package ds.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
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

import org.json.JSONObject;

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
 * shell.js 怎么进页面（注入时机）
 * ==============================
 * 必须在主脚本之前。主脚本是 defer，按规范排在所有经典脚本之后执行；而首帧渲染就可能
 * 调用 polyfill 里的方法（实测：侧栏时间线分组调 r.at(-1)，缺 at 直接整页白屏，
 * 见 .dsh/.project/20261115-旧WebView兼容修复/08c-at-race-list.json：rootLen 21794 → 0）。
 * 所以 serveAsset 供 index.html 时把 <script src="/shell.js"></script> 插到 <head> 最前面：
 * 经典同步脚本，解析到就执行，一定先于 defer 的主包。
 * onPageFinished 那次注入保留为兜底（shell.js 自带 window.__dsShell 幂等闸门，
 * 重复执行只是空转），用于兜住 /shell.js 请求失败或页面不经本类供给的极端情况。
 *
 * 与 WebView 能力缺口对应的三处补丁
 * =================================
 *   1. 返回键 —— 单页应用没有 history，原生只能问页面；页面侧由 assets/shell.js
 *      提供 window.__dsBack()（按「浮层 → 弹窗 → 抽屉 → 会话页」由内往外回退），
 *      返回 false 时原生才决定 goBack 或退出，见 onBackPressed 与该文件注释。
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

    /** 入口 HTML 在 assets 内的相对路径。只有它需要插入壳层脚本标签。 */
    private static final String ENTRY_HTML = "index.html";

    /**
     * 插到入口 HTML &lt;head&gt; 最前面的脚本标签。
     *
     * 不能带 defer / async：主脚本是 defer，而 defer 脚本排在所有经典脚本之后执行，
     * 所以「经典同步」这一段必然先于主包跑完 —— 这正是修首帧白屏的关键。
     * data-ds-shell 只是「这份 HTML 已经插过」的识别标记，用于保证注入幂等。
     */
    private static final String SHELL_TAG = "<script src=\"/shell.js\" data-ds-shell></script>";

    /** 上面那个标签的识别标记。 */
    private static final String SHELL_MARK = "data-ds-shell";

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

    /**
     * 局域网直连的传输层（UDP 广播发现 + TCP 请求/响应）。
     * 页面未调用 lanStart 之前它不占任何端口；所有密钥与明文都不经过这一层。
     */
    private LanLink lan;

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
                // 兜底注入：正常路径下 index.html 里的 <script src="/shell.js"> 早已执行过，
                // 这里再跑一次是空转（shell.js 顶部有 window.__dsShell 幂等闸门）。
                // 保留它只为兜住「/shell.js 没加载成功」或「页面不经 serveAsset 供给」的情况，
                // 那时返回键会退化为直接退出，不至于完全没补丁。失败也不影响主流程。
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

        // 局域网直连：这一层只搬字节，不认识聊天数据（加解密与合并在页面里）。
        // 三条回调都只推「有东西了」，数据由页面反过来同步取（见 LanLink.take 的注释）。
        lan = new LanLink(this, new LanLink.Listener() {
            @Override
            public void onLog(String message) {
                bridgeLog("[lan] " + message);
            }

            @Override
            public void onPeers() {
                evalJs("window.__dsLan&&window.__dsLan.onPeers&&window.__dsLan.onPeers()");
            }

            @Override
            public void onRequest(String requestId) {
                evalJs("window.__dsLan&&window.__dsLan.onRequest&&window.__dsLan.onRequest("
                        + JSONObject.quote(requestId) + ")");
            }

            @Override
            public void onResponse(String requestId) {
                evalJs("window.__dsLan&&window.__dsLan.onResponse&&window.__dsLan.onResponse("
                        + JSONObject.quote(requestId) + ")");
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
            // 入口 HTML 必须带上壳层脚本：主包是 defer，注入晚了首帧就会踩空（见类注释）
            if (ENTRY_HTML.equals(rel)) return htmlWithShell(rel, in);
            return localResponse(rel, in);
        } catch (IOException e) {
            bridgeLog("assets 里没有 " + rel);
            return notFound();
        }
    }

    /**
     * 包一层本地资源响应（统一 charset 与两条安全/缓存头）。
     *
     * @param rel  assets 内的相对路径，用来定 MIME
     * @param body 响应体，调用方负责关闭
     * @return 带响应头的本地资源响应
     */
    private WebResourceResponse localResponse(String rel, InputStream body) {
        WebResourceResponse res = new WebResourceResponse(mimeOf(rel), "utf-8", body);
        Map<String, String> h = new HashMap<>();
        // 资源文件名带 contenthash，可以放心长缓存；入口 html 必须每次校验
        h.put("Cache-Control", "no-cache");
        h.put("X-Content-Type-Options", "nosniff");
        res.setResponseHeaders(h);
        return res;
    }

    /**
     * 供入口 HTML，并把壳层脚本标签插到 &lt;head&gt; 最前面。
     *
     * 为什么在这里改而不是改 dist/index.html：dist 是前端产物，同一个文件还要能直接用
     * 浏览器打开（README 支持双击 index.html）；/shell.js 只有壳里才有，写进产物会变成
     * 网页形态的 404。放在供给层做，前端零改动、APK 内 assets 也保持原样。
     *
     * 编码：按 UTF-8 解码/编码，BOM（U+FEFF）会原样往返，其余字节不受影响。
     *
     * @param rel  assets 内的相对路径（即 index.html）
     * @param raw  assets 里的原始字节流，本方法内读完并关闭
     * @return 注入后的 HTML 响应；已插过或找不到可插位置时返回原文（不改动更好过改坏）
     */
    private WebResourceResponse htmlWithShell(String rel, InputStream raw) {
        byte[] original;
        try {
            original = readAll(raw);
        } catch (IOException e) {
            // 读失败就退回「原样供给」：页面仍能打开，只是没有提前注入的补丁
            // （返回空体会变成白屏 —— 那正是这次要修的症状，不能自己造一个）
            bridgeLog("读取入口 HTML 失败，改为原样供给：" + e);
            try {
                return localResponse(rel, getAssets().open(rel));
            } catch (IOException again) {
                bridgeLog("重新打开入口 HTML 也失败：" + again);
                return notFound();
            }
        }
        String html = new String(original, StandardCharsets.UTF_8);
        String patched = injectShellTag(html);
        if (patched == null) return localResponse(rel, new ByteArrayInputStream(original));
        byte[] body = patched.getBytes(StandardCharsets.UTF_8);
        bridgeLog("入口 HTML 已注入壳层脚本（" + original.length + " → " + body.length + " 字节）");
        return localResponse(rel, new ByteArrayInputStream(body));
    }

    /**
     * 把 {@link #SHELL_TAG} 插到 &lt;head ...&gt; 开标签之后。
     *
     * @param html 原始 HTML
     * @return 注入后的 HTML；已经插过、或没有任何可插的锚点时返回 null（表示保持原文）
     */
    private static String injectShellTag(String html) {
        if (html == null || html.indexOf(SHELL_MARK) >= 0) return null;
        int at = headInsertOffset(html);
        if (at < 0) return null;
        return html.substring(0, at) + SHELL_TAG + html.substring(at);
    }

    /**
     * 找出「插进去一定在主脚本之前」的偏移。
     *
     * 优先 &lt;head ...&gt; 开标签之后；万一产物没有 head，退到第一个 &lt;script 之前 ——
     * 仍然保证先于主包。两者都没有就不插（返回 -1）：宁可不补，也不要把标签塞进
     * &lt;!doctype&gt; 之前（那会把文档打成怪异模式）。
     *
     * @param html 原始 HTML
     * @return 插入偏移；无法安全插入时返回 -1
     */
    private static int headInsertOffset(String html) {
        int head = indexOfIgnoreCase(html, "<head", 0);
        if (head >= 0) {
            int close = html.indexOf('>', head);
            if (close > 0) return close + 1;
        }
        return indexOfIgnoreCase(html, "<script", 0);
    }

    /**
     * 忽略大小写的子串查找（String 只提供区分大小写的 indexOf）。
     *
     * @param haystack 被搜的串
     * @param needle   要找的子串
     * @param from     起始偏移
     * @return 首次出现的下标；找不到返回 -1
     */
    private static int indexOfIgnoreCase(String haystack, String needle, int from) {
        int last = haystack.length() - needle.length();
        for (int i = Math.max(from, 0); i <= last; i++) {
            if (haystack.regionMatches(true, i, needle, 0, needle.length())) return i;
        }
        return -1;
    }

    /**
     * 把流读干净并关闭。
     *
     * @param in 输入流，方法返回前一定关闭
     * @return 全部字节
     * @throws IOException 读取失败
     */
    private static byte[] readAll(InputStream in) throws IOException {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream(Math.max(1024, in.available()));
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        } finally {
            try {
                in.close();
            } catch (IOException ignored) {
                // 关不掉也没别的办法，字节已经读完了
            }
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

    /**
     * 读取 assets/shell.js 并用 evaluateJavascript 注入当前页面（兜底通道）。
     *
     * 常规通道是 serveAsset 在入口 HTML 里插的 &lt;script src="/shell.js"&gt;：
     * 那条路径先于主包执行，能挡住首帧白屏。这里只是兜底，正常情况下是空转。
     * 失败只记日志，不影响主流程。
     */
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

        // ── 局域网直连（手机↔手机）─────────────────────────────────────────

        /**
         * 启动局域网监听与广播。页面每次进入可见状态都会调用（幂等）。
         *
         * @param deviceId   本机设备 id，必须非空（记录里的 device 字段同源）
         * @param deviceName 展示用设备名
         * @param pairTag    口令指纹；空串表示没设口令，仍广播但不配对
         * @return 本机信息 JSON（tcp 端口、局域网地址、udp 端口）；失败时返回 {"error":"..."}
         */
        @JavascriptInterface
        public String lanStart(String deviceId, String deviceName, String pairTag) {
            if (lan == null) {
                return "{\"error\":\"not ready\"}";
            }
            try {
                String info = lan.start(deviceId, deviceName, pairTag);
                bridgeLog("lanStart " + info);
                return info;
            } catch (Exception e) {
                bridgeLog("lanStart 失败：" + e);
                return "{\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}";
            }
        }

        /** 停止监听与广播（页面不可见、或用户关掉开关时调用）。 */
        @JavascriptInterface
        public void lanStop() {
            if (lan != null) {
                lan.stop();
            }
        }

        /** 当前在线设备表（JSON 数组字符串）。 */
        @JavascriptInterface
        public String lanPeers() {
            return lan == null ? "[]" : lan.peersJson();
        }

        /**
         * 取走回调里通知的那条数据。
         *
         * @param requestId onRequest / onResponse 给的 id
         * @return {"ok":true,"payload":"..."} 或 {"ok":false,"error":"..."}；没有则 null
         */
        @JavascriptInterface
        public String lanTake(String requestId) {
            return lan == null ? null : lan.take(requestId);
        }

        /**
         * 向对端发一个请求（加密信封由页面组装好）。
         *
         * @param requestId 页面生成的 id，结果通过 window.__dsLan.onResponse 通知
         * @param host      对端地址（来自发现表）
         * @param port      对端 TCP 端口（来自发现表）
         * @param payload   信封 JSON
         */
        @JavascriptInterface
        public void lanSend(String requestId, String host, int port, String payload) {
            if (lan != null) {
                lan.send(requestId, host, port, payload);
            }
        }

        /**
         * 回复一个收到的请求。
         *
         * @param requestId onRequest 给的 id
         * @param payload   信封 JSON
         * @return true 表示请求还在等待（没被超时清掉）
         */
        @JavascriptInterface
        public boolean lanReply(String requestId, String payload) {
            return lan != null && lan.reply(requestId, payload);
        }

        /** 本机局域网地址（界面展示 + 自环自检用）。 */
        @JavascriptInterface
        public String lanAddress() {
            return LanLink.localAddress();
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

    /**
     * 在页面里执行一段脚本。
     *
     * 必须回 UI 线程：evaluateJavascript 只能在创建 WebView 的线程调用，
     * 而调用方（LanLink 的收发线程）都在工作线程上。
     *
     * @param script 要执行的脚本；只用来做「通知」，大块数据由页面反过来取（见 LanLink.take）
     */
    private void evalJs(final String script) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (web != null) {
                    web.evaluateJavascript(script, null);
                }
            }
        });
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

    /**
     * 返回键的页面判定脚本。
     *
     * 页面已消费这次按键（关下拉浮层 / 关弹窗 / 收起抽屉 / 会话页回列表）给 1，
     * 页面没有可回退的层级给 0，由原生决定 goBack 还是退出。
     *
     * 两个坑：
     *   1. 必须返回**数字**而不是字符串。evaluateJavascript 的结果按 JSON 编码回传，
     *      字符串会带上引号 —— 返回 '1' 时这里拿到的是 "\"1\""，与 "1" 永远不等。
     *   2. 外面套一层函数吃掉页面脚本的异常：抛错时结果是 null，这里折成 0，
     *      行为退化为「原生决定」，不会把返回键卡成按了没反应。
     */
    private static final String JS_BACK =
            "(function(){try{return window.__dsBack&&window.__dsBack()?1:0}catch(e){return 0}})()";

    /** 等页面回调的上限。页面卡住（渲染进程忙、脚本死循环）时也不至于让返回键彻底失灵。 */
    private static final long BACK_TIMEOUT_MS = 800L;

    /**
     * 这次返回键是否还在等页面回调。
     *
     * evaluateJavascript 是异步的，连按时每次都会重新问一遍页面：上一次的判定还没回来
     * 就再问一次，两个回调会各关一层，一次连按能把两层界面一起关掉。用它挡掉重复的按键。
     */
    private boolean backPending = false;

    private final Handler uiHandler = new Handler(Looper.getMainLooper());

    /** 页面没在 BACK_TIMEOUT_MS 内回调时的兜底：当作「页面没处理」继续往下走。 */
    private final Runnable backTimeout = new Runnable() {
        @Override
        public void run() {
            if (!backPending) return;
            backPending = false;
            bridgeLog("返回键：页面未回调，按未处理兜底");
            resolveBack(false);
        }
    };

    /**
     * 系统返回键。先问页面（关浮层、关弹窗、收起抽屉、会话页回列表），
     * 页面说没处理才轮到原生：能 goBack 就 goBack，否则退出。
     *
     * 为什么必须问页面：本应用是单页应用、没有 history 路由，正常使用下 canGoBack()
     * 一直是 false，原生无从判断"该关哪个界面"。
     */
    @Override
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        if (backPending) return;   // 上一次的判定还在路上：这次丢掉，避免一次连按关两层
        backPending = true;
        uiHandler.postDelayed(backTimeout, BACK_TIMEOUT_MS);
        web.evaluateJavascript(JS_BACK, new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                uiHandler.removeCallbacks(backTimeout);
                if (!backPending) return;   // 已经被超时兜底处理过了
                backPending = false;
                // 结果可能是 1 / 0 / true / false；字符串形态会带 JSON 引号，一起兼容
                String result = value == null ? "" : value.replace("\"", "").trim();
                bridgeLog("返回键：页面返回 " + result);
                resolveBack("1".equals(result) || "true".equals(result));
            }
        });
    }

    /**
     * 页面判定之后的收尾。
     *
     * @param handled 页面是否已消费这次返回键
     * @sideeffect handled 为 false 时可能调用 web.goBack()，或结束当前 Activity
     */
    private void resolveBack(boolean handled) {
        if (handled) return;
        // 页面没有可回退的层级：WebView 历史里还能退就退。正常使用走不到这一步
        // （页面不做 history 跳转），但万一页面里出现了可回退的历史，回退比直接退出更合理。
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        // 真正的退出：交给系统默认实现，保留返回键/返回手势的标准退出动画
        super.onBackPressed();
    }

    /**
     * 回到前台：重新持有 Wi-Fi 组播锁（不解锁就收不到局域网广播，见 LanLink 类注释）。
     * 真正的「开始广播」仍由页面驱动的 lanStart 决定，这里只负责锁与前台标记。
     */
    @Override
    protected void onResume() {
        super.onResume();
        if (lan != null) {
            lan.setForeground(true);
        }
    }

    /**
     * 退到后台：立即释放组播锁并停止广播。
     * 不释放会一直占着 Wi-Fi 的广播/组播过滤开关，待机耗电明显。
     * TCP 监听保留：对端推过来的请求仍能落库。
     */
    @Override
    protected void onPause() {
        if (lan != null) {
            lan.setForeground(false);
        }
        super.onPause();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // 深浅色跟随系统：只更新原生这一层的条形颜色，页面由前端自己切主题
        applyBarColors(isNight());
    }

    @Override
    protected void onDestroy() {
        uiHandler.removeCallbacks(backTimeout);
        backPending = false;
        pendingBytes = null;
        // 页面都没了，悬着的文件选择回调必须结掉，否则它对应的 input 会一直卡住
        cancelPendingFileChooser();
        // 传输层也必须停：否则这两个端口和线程会跟着进程一直挂着
        if (lan != null) {
            lan.stop();
            lan = null;
        }
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
