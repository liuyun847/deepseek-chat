package ds.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.ConsoleMessage;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebChromeClient.FileChooserParams;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * WebView 壳：把构建产物 dist/ 打进 APK 的 assets，用自定义 https 源供给给页面。
 *
 * 为什么不用 file:// 加载 assets
 * ==============================
 * file:// 是不透明源（opaque origin），localStorage 在部分 WebView 上被限制、
 * IndexedDB 直接不可用 —— 而本应用的会话与附件原件全在 IndexedDB 里。
 * https://dsapp.local/ 是真正的安全源，存储 API 全部可用；请求在
 * shouldInterceptRequest 里被就地换成本地 assets，一个字节都不出网。
 *
 * 为什么前端不需要为 APK 改一行
 * ============================
 * rspack 的 publicPath 是 'auto'，运行时按当前脚本地址推导资源根，因此同一份
 * dist/ 在 http(s)://、file://、https://dsapp.local/ 下都能跑：入口
 * /index.html 引的相对路径 static/js/main.<hash>.js 落到 assets/static/js/…
 *
 * 与 WebView 能力缺口对应的三处补丁
 * =================================
 *   1. 返回键 —— 单页应用没有 history，原生只能问页面；页面侧由 assets/shell.js
 *      提供 window.__dsBack()（关掉最上层弹窗），见该文件注释。
 *   2. blob: 导出 —— WebView 没有下载管理器，<a download> 点了没反应；
 *      shell.js 拦截后把内容转成 base64 交给本类的 Bridge.saveBase64，
 *      再用系统文件选择器落盘。
 *   3. <input type=file> —— 不覆写 onShowFileChooser，选文件请求会被静默丢弃。
 *
 * 注意：本类不能用 lambda / 方法引用。javac 以 android.jar 作 bootclasspath 编译，
 * 里面没有 java.lang.invoke.LambdaMetafactory，lambda 会直接编译失败。
 */
@SuppressWarnings("deprecation") // onBackPressed / SYSTEM_UI_FLAG_LIGHT_STATUS_BAR 在 API 30+ 标注过时，但在 minSdk 26 上行为最稳，见各自注释
public class MainActivity extends Activity {

    /** 前端资源的虚拟来源。域名带 https 只是为了让 WebView 认定为安全源。 */
    private static final String ORIGIN = "https://dsapp.local";
    private static final String START_URL = ORIGIN + "/index.html";

    /** 壳层补丁脚本的 assets 路径。由构建脚本从 android/shell/ 拷进 APK。 */
    private static final String SHELL_ASSET = "shell.js";

    /** 设为 true 可用 chrome://inspect 调试线上 WebView。仅调试时打开。 */
    private static final boolean DEBUG_DEFAULT = false;

    /** ACTION_CREATE_DOCUMENT 的请求码（导出落盘）。 */
    private static final int REQ_SAVE_DOCUMENT = 1002;

    /** 网页里 <input type=file> 选文件的请求码。回调形态与导出完全不同，必须分开。 */
    private static final int REQ_PICK_FILE = 1003;

    /** 单次导出的体积上限：base64 跨 JNI 传字符串，太大容易在低端机上 OOM。 */
    private static final int MAX_SAVE_BYTES = 48 * 1024 * 1024;

    private boolean debugMode = DEBUG_DEFAULT;

    private WebView web;

    /** 待落盘的内容（用户还在系统文件选择器里挑位置时暂存）。 */
    private volatile byte[] pendingBytes = null;
    private volatile String pendingName = "";
    private volatile String pendingMime = "application/octet-stream";

    /**
     * 文件选择的回填通道（用户还在系统选择器里挑文件时暂存）。
     *
     * 必须存成成员字段：onShowFileChooser 与 onActivityResult 是两个独立回调，
     * 中间隔着用户操作，没有别的办法把 ValueCallback 传过去。
     * WebView 的约定是「每次 onShowFileChooser 必须恰好回调一次」：漏回调或回调两次，
     * 都会让这个 input 在本页生命周期内彻底失效（第二次点击再无反应）。
     */
    private volatile ValueCallback<Uri[]> filePathCallback = null;
    private volatile boolean pendingFilePathMultiple = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        // 调试开关用 intent extra 传，不改代码即可切换：
        //   adb shell am start -n ds.app/.MainActivity --ez debug true
        // 打开后 WebView 可用 chrome://inspect 调试，JS 控制台也会转到 logcat（tag: DSApp）
        debugMode = getIntent() != null && getIntent().getBooleanExtra("debug", DEBUG_DEFAULT);

        web = new WebView(this);
        setContentView(web, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        // IndexedDB / localStorage 依赖 DOM storage；本应用的会话就在 IndexedDB 里
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        // file:// 一律关掉以收紧攻击面；content:// 必须放开 ——
        // 系统选择器回传的是 content:// Uri，WebView 要经 ContentResolver 去读它，
        // setAllowContentAccess(false) 时读不到，<input type=file> 会表现为"选了没反应"。
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        // 不跟随系统字体缩放，避免大字号下布局崩掉（页面自己有字号设置）
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        // 不设 useWideViewPort / loadWithOverviewMode：保持默认（关闭），
        // 布局宽度 = WebView 宽度（设备 CSS 宽度），页面里的
        // matchMedia('(min-width: 768px)') 因此能正确判出手机形态。

        if (debugMode) WebView.setWebContentsDebuggingEnabled(true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return serveAsset(req.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (u != null && "dsapp.local".equals(u.getHost())) return false;
                openExternally(u);
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // 页面文档就绪后注入壳层补丁。失败也不影响主流程（返回键退化为直接退出）
                injectShell();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            // markdown 里的外链是 target=_blank，走这里转到系统浏览器
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture,
                                          android.os.Message resultMsg) {
                WebView tmp = new WebView(MainActivity.this);
                tmp.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                        openExternally(r.getUrl());
                        return true;
                    }
                });
                ((WebView.WebViewTransport) resultMsg.obj).setWebView(tmp);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                if (debugMode) {
                    android.util.Log.d("DSApp", m.message() + "  (line " + m.lineNumber() + ")");
                }
                return debugMode;
            }

            /**
             * 网页里点了 <input type=file>（本项目即「导入对话记录」）。
             *
             * 不覆写这个方法，WebView 就静默丢掉这次选择请求 —— 表现正是"点了没反应"。
             * 返回 true 表示"请求已接管"，随后必须且只能调用一次 filePathCallback：
             *   选中 → onReceiveValue(new Uri[]{...})；取消 → onReceiveValue(null)。
             * 取消那次尤其不能漏，否则该 input 在本页内第二次点击永久失效。
             */
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                // 上一次请求还没回就又被点了一次：先把旧的以 null 结掉，再换新的
                cancelPendingFileChooser();

                filePathCallback = callback;
                pendingFilePathMultiple = params != null
                        && params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE;

                String[] accept = params == null ? null : params.getAcceptTypes();
                final String mime = pickerMime(accept);
                bridgeLog("onShowFileChooser accept=" + joinAccept(accept)
                        + " → type=" + mime + " multiple=" + pendingFilePathMultiple);

                // ACTION_GET_CONTENT：不需要任何权限，也不需要 FileProvider。
                // 返回的 Uri 是 content:// 且由系统自带读授权，这里再把 flag 显式写上，
                // 免得个别 ROM 没给、WebView 拿去读时又打不开。
                final Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                i.setType(mime);
                if (pendingFilePathMultiple) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                // 单选时给每个具体类型：部分 ROM 的文件选择器认 EXTRA_MIME_TYPES 比认 setType 准
                if (!"*/*".equals(mime) && !"image/*".equals(mime) && accept != null) {
                    i.putExtra(Intent.EXTRA_MIME_TYPES, accept);
                }

                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        try {
                            startActivityForResult(i, REQ_PICK_FILE);
                        } catch (Exception e) {
                            // 起不来也要结掉回调，否则 input 就废了
                            cancelPendingFileChooser();
                            toastUi("无法打开文件选择器：" + e.getMessage());
                        }
                    }
                });
                return true;
            }
        });

        // 注入名必须与 android/shell/shell.js 里调用的 window.__DS_BRIDGE__ 一致
        web.addJavascriptInterface(new Bridge(), "__DS_BRIDGE__");

        // http(s) 下载交给系统浏览器：WebView 自己没有下载管理器，
        // 不接管的话点了没反应。blob: / data: 由 shell.js 走 Bridge 落盘，到不了这里。
        web.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimetype, long contentLength) {
                bridgeLog("onDownloadStart " + url + " (" + contentLength + " bytes)");
                openExternally(Uri.parse(url));
            }
        });

        applyBarColors(isNight());
        web.loadUrl(START_URL);
    }

    // ── assets 供给 ─────────────────────────────────────────────────────────

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html");
        MIME.put("js", "application/javascript");
        MIME.put("mjs", "application/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("webmanifest", "application/manifest+json");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("gif", "image/gif");
        MIME.put("webp", "image/webp");
        MIME.put("svg", "image/svg+xml");
        MIME.put("ico", "image/x-icon");
        MIME.put("woff", "font/woff");
        MIME.put("woff2", "font/woff2");
        MIME.put("ttf", "font/ttf");
        MIME.put("otf", "font/otf");
        MIME.put("txt", "text/plain");
        MIME.put("map", "application/json");
    }

    /**
     * 把 https://dsapp.local/&lt;path&gt; 映射到 assets/&lt;path&gt;。
     *
     * @param uri WebView 请求的地址；非本应用源返回 null（表示交给网络栈正常处理）
     * @return 本地资源响应；assets 里没有该路径时返回 404 文本响应
     */
    private WebResourceResponse serveAsset(Uri uri) {
        if (uri == null || !"dsapp.local".equals(uri.getHost())) return null;

        String path = uri.getPath();
        if (path == null || path.isEmpty() || "/".equals(path)) path = "/index.html";
        // 归一化，拒绝任何越出 assets 根的路径
        String rel = path.startsWith("/") ? path.substring(1) : path;
        if (rel.contains("..")) return notFound();

        try {
            InputStream in = getAssets().open(rel);
            WebResourceResponse res = new WebResourceResponse(mimeOf(rel), "utf-8", in);
            Map<String, String> h = new HashMap<>();
            // 资源文件名带 contenthash，可以放心长缓存；入口 html 必须每次校验
            h.put("Cache-Control", "no-cache");
            h.put("X-Content-Type-Options", "nosniff");
            res.setResponseHeaders(h);
            return res;
        } catch (IOException e) {
            bridgeLog("assets 里没有 " + rel);
            return notFound();
        }
    }

    private static String mimeOf(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0) return "application/octet-stream";
        String ext = name.substring(dot + 1).toLowerCase();
        String m = MIME.get(ext);
        return m != null ? m : "application/octet-stream";
    }

    private WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8",
                new ByteArrayInputStream("404".getBytes(StandardCharsets.UTF_8)));
    }

    /**
     * 用系统浏览器/邮件应用打开外部链接。
     *
     * @param u 目标地址；为 null 或协议不在 http/https/mailto 内时静默忽略
     *          （javascript:、intent: 之类一律不外发）
     */
    private void openExternally(Uri u) {
        if (u == null) return;
        String scheme = u.getScheme();
        if (scheme == null) return;
        if (!scheme.equals("http") && !scheme.equals("https") && !scheme.equals("mailto")) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception ignored) {
            // 没有可处理该链接的应用时静默忽略
        }
    }

    // ── 壳层补丁注入 ────────────────────────────────────────────────────────

    /** 读取 assets/shell.js 并注入当前页面。失败只记日志，不影响主流程。 */
    private void injectShell() {
        try (InputStream in = getAssets().open(SHELL_ASSET)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            String js = new String(out.toByteArray(), StandardCharsets.UTF_8);
            web.evaluateJavascript(js, null);
            bridgeLog("shell.js 已注入");
        } catch (Exception e) {
            bridgeLog("注入 shell.js 失败：" + e);
        }
    }

    // ── JS 桥 ───────────────────────────────────────────────────────────────

    /** 暴露给页面脚本的桥，注入名 __DS_BRIDGE__。 */
    public class Bridge {

        /** 供页面判断运行形态（浏览器里没有这个对象）。 */
        @JavascriptInterface
        public String platform() {
            return "android";
        }

        @JavascriptInterface
        public void toast(final String msg) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
                }
            });
        }

        /**
         * 把页面里的导出内容交给系统文件选择器落盘。
         *
         * 用 Storage Access Framework 而不是"申请权限写公共目录"：
         *   - 零权限：API 29+ 走 MediaStore 不需要权限，API 26–28 写公共目录需要
         *     WRITE_EXTERNAL_STORAGE，且能否真写入还取决于系统有没有把 sdcard_rw
         *     组（gid 1015）加进进程组列表 —— 不少定制系统/模拟器不这么做，
         *     结果是"权限显示已授予、实际写入 Permission denied"。
         *   - SAF 在所有 API 19+ 行为一致，用户自己选位置，卸载也不会被清掉。
         *
         * @param name 建议的文件名（会被清洗掉路径分隔符）
         * @param mime MIME 类型，空则用 application/octet-stream
         * @param b64 文件内容的 base64（跨 JNI 只能传基本类型）
         * @return true 表示已受理；解码失败或超过体积上限时返回 false
         * @sideeffect 弹出系统文件选择器，结果在 onActivityResult 里写盘
         */
        @JavascriptInterface
        public boolean saveBase64(String name, String mime, String b64) {
            final String safe = safeName(name);
            final String type = cleanMime(mime);
            byte[] data;
            try {
                data = Base64.decode(b64 == null ? "" : b64, Base64.DEFAULT);
            } catch (Exception e) {
                bridgeLog("saveBase64 解码失败：" + e);
                return false;
            }
            if (data.length > MAX_SAVE_BYTES) {
                bridgeLog("saveBase64 超出上限：" + data.length);
                toastUi("导出内容过大（" + (data.length / 1024 / 1024) + " MB）");
                return false;
            }
            bridgeLog("saveBase64 " + safe + " " + data.length + " 字节, sdk="
                    + android.os.Build.VERSION.SDK_INT);
            pendingBytes = data;
            pendingName = safe;
            pendingMime = type;

            final Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType(type);
            i.putExtra(Intent.EXTRA_TITLE, safe);
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try {
                        startActivityForResult(i, REQ_SAVE_DOCUMENT);
                    } catch (Exception e) {
                        pendingBytes = null;
                        toastUi("无法打开文件选择器：" + e.getMessage());
                    }
                }
            });
            return true;
        }
    }

    /**
     * 系统文件选择器的返回入口，两条链路共用：
     *   REQ_SAVE_DOCUMENT → 导出落盘
     *   REQ_PICK_FILE     → <input type=file> 选文件，回填给 WebView
     */
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode == REQ_PICK_FILE) {
            // 先把 callback 摘下来再回调：本方法内部无论如何都要恰好结掉一次。
            ValueCallback<Uri[]> cb = filePathCallback;
            final boolean multiple = pendingFilePathMultiple;
            filePathCallback = null;
            pendingFilePathMultiple = false;
            if (cb == null) return;   // 已经被 cancelPendingFileChooser 结过了

            java.util.ArrayList<Uri> picked = new java.util.ArrayList<Uri>();
            if (resultCode == RESULT_OK && data != null) {
                // 两种形态都要处理：多选给 ClipData，单选给 data.getData()。
                // 个别 ROM 多选时也会把 getData() 填成第一项，故两者都收、末尾去重。
                android.content.ClipData clip = data.getClipData();
                if (clip != null) {
                    for (int k = 0; k < clip.getItemCount(); k++) {
                        android.content.ClipData.Item it = clip.getItemAt(k);
                        Uri u = it == null ? null : it.getUri();
                        if (u != null && !picked.contains(u)) picked.add(u);
                    }
                }
                Uri one = data.getData();
                if (picked.isEmpty() && one != null) picked.add(one);
            }

            // 用户取消（resultCode != RESULT_OK 或没带数据）时必须回 null：
            // 这是 WebView 的硬约定，漏掉它同一个 input 第二次点击就再也不会响。
            if (picked.isEmpty()) {
                bridgeLog("文件选择已取消");
                cb.onReceiveValue(null);
                return;
            }

            Uri[] out = new Uri[picked.size()];
            picked.toArray(out);
            if (!multiple && out.length > 1) out = new Uri[]{out[0]};   // 单选只交第一个
            bridgeLog("文件选择返回 " + out.length + " 项");
            cb.onReceiveValue(out);
            return;
        }

        if (requestCode != REQ_SAVE_DOCUMENT) return;

        byte[] bytes = pendingBytes;
        pendingBytes = null;
        Uri uri = (resultCode == RESULT_OK && data != null) ? data.getData() : null;
        if (uri == null) { toastUi("已取消保存"); return; }
        if (bytes == null) { toastUi("没有可保存的内容"); return; }

        // "wt" = 截断写入（write + truncate），否则覆盖短文件会残留尾部旧内容
        try (OutputStream os = getContentResolver().openOutputStream(uri, "wt")) {
            if (os == null) throw new IOException("无法打开目标文件");
            os.write(bytes);
            os.flush();
            toastUi("已保存：" + displayName(uri));
        } catch (Exception e) {
            toastUi("保存失败：" + e.getMessage());
        }
    }

    /**
     * 取回文件名，供 Toast 提示用。
     *
     * @param uri 系统选择器回传的 content:// 地址
     * @return 文件名；查不到时退回路径末段，再不行返回"文件"
     */
    private String displayName(Uri uri) {
        try (android.database.Cursor c = getContentResolver().query(
                uri, new String[]{android.provider.OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
        } catch (Exception ignored) { /* 取不到就用扩展名兜底 */ }
        String s = uri.getLastPathSegment();
        return s == null ? "文件" : s;
    }

    /** 只取主 mime，逗号参数（charset 等）丢掉。 */
    private static String cleanMime(String mime) {
        String m = mime == null ? "" : mime;
        int i = m.indexOf(';');
        if (i > 0) m = m.substring(0, i);
        m = m.trim();
        return m.isEmpty() ? "application/octet-stream" : m;
    }

    /** Toast 必须回 UI 线程。 */
    private void toastUi(final String msg) {
        bridgeLog("toast: " + msg);
        runOnUiThread(new Runnable() {
            @Override public void run() {
                Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show();
            }
        });
    }

    /** 桥侧诊断日志。debug 模式下会随 JS 控制台一起进 logcat（tag: DSApp）。 */
    private void bridgeLog(String msg) {
        if (debugMode) android.util.Log.d("DSApp", "[bridge] " + msg);
    }

    // ── <input type=file> 的支持代码 ─────────────────────────────────────────

    /**
     * 以「取消」结掉悬着的文件选择回调（幂等：没有悬着的就什么也不做）。
     *
     * 两处调用：用户重复点击时先结掉旧的；选择器起不来 / 页面销毁时兜底结掉。
     * 绝不能对同一个 callback 调用两次，所以这里先摘字段再回调。
     */
    private void cancelPendingFileChooser() {
        ValueCallback<Uri[]> cb = filePathCallback;
        filePathCallback = null;
        pendingFilePathMultiple = false;
        if (cb != null) cb.onReceiveValue(null);
    }

    /**
     * 把 FileChooserParams.getAcceptTypes() 折算成 Intent 用的 MIME 类型。
     *
     * 本项目的导入框 accept 是 ".zip,application/zip,application/x-zip-compressed"，
     * 这几种不是 image 开头，选择器只会把它们当"其它类型"，因此统一给通配 + EXTRA_MIME_TYPES，
     * 由系统再做过滤（部分 ROM 的选择器对 EXTRA_MIME_TYPES 支持不全，但都认通配）。
     *
     * 其余情况：没有 accept 或本身就是通配 → 通配不限制；全是 image/* → 合并成 image/*。
     * （本注释里不写通配符字面量：星号紧跟斜杠会提前关掉块注释。）
     */
    private static String pickerMime(String[] accept) {
        if (accept == null || accept.length == 0) return "*/*";
        boolean allImage = true;
        int n = 0;
        for (int k = 0; k < accept.length; k++) {
            String a = accept[k];
            if (a == null || a.trim().isEmpty()) continue;
            a = a.trim();
            if ("*/*".equals(a)) return "*/*";
            n++;
            if (!a.startsWith("image/")) allImage = false;
        }
        if (n == 0) return "*/*";
        return allImage ? "image/*" : "*/*";
    }

    /** 仅用于日志，把 acceptTypes 拼成一行。 */
    private static String joinAccept(String[] accept) {
        if (accept == null || accept.length == 0) return "(空)";
        StringBuilder sb = new StringBuilder();
        for (int k = 0; k < accept.length; k++) {
            if (k > 0) sb.append(',');
            sb.append(accept[k]);
        }
        return sb.toString();
    }

    /** 去掉路径分隔符等危险字符，避免文件名里出现路径穿越。 */
    private static String safeName(String name) {
        String n = (name == null || name.isEmpty()) ? "export.bin" : name;
        n = n.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (n.isEmpty()) n = "export.bin";
        if (n.length() > 120) n = n.substring(0, 120);
        return n;
    }

    // ── 生命周期、返回键与配色 ───────────────────────────────────────────────

    @Override
    public void onBackPressed() {
        // 先让页面处理（关弹窗），页面说没处理才退出
        web.evaluateJavascript("(window.__dsBack && window.__dsBack()) ? 1 : 0",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (!"1".equals(value)) finish();
                    }
                });
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // 深浅色跟随系统：只更新原生这一层的条形颜色，页面由前端自己切主题
        applyBarColors(isNight());
    }

    @Override
    protected void onDestroy() {
        pendingBytes = null;
        // 页面都没了，悬着的文件选择回调必须结掉，否则它对应的 input 会一直卡住
        cancelPendingFileChooser();
        if (web != null) {
            web.removeJavascriptInterface("__DS_BRIDGE__");
            web.destroy();
        }
        super.onDestroy();
    }

    /** 当前是否深色模式（与前端 prefers-color-scheme 同源）。 */
    private boolean isNight() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
    }

    /**
     * 按深浅色设置状态栏 / 导航栏 / WebView 底色，避免启动瞬间或旋转后闪白。
     *
     * @param night true 用深色底 + 浅色图标，false 用浅色底 + 深色图标
     * @sideeffect 修改窗口条形颜色与 systemUiVisibility
     */
    private void applyBarColors(boolean night) {
        int bg = getColor(R.color.app_bg);
        Window win = getWindow();
        win.setStatusBarColor(bg);
        win.setNavigationBarColor(bg);
        if (web != null) web.setBackgroundColor(bg);
        View decor = win.getDecorView();
        int flags = decor.getSystemUiVisibility();
        if (night) {
            flags = flags & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        } else {
            flags = flags | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        }
        decor.setSystemUiVisibility(flags);
    }
}
