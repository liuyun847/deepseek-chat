package ds.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.graphics.drawable.GradientDrawable;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Size;
import android.view.Gravity;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.InputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * 扫码界面：Camera2 预览 + ZXing 解码，另带「从图片选择」这条兜底路径。
 *
 * 为什么是独立 Activity，不在 WebView 上叠一层预览
 * ===============================================
 * MainActivity 是 setContentView(web)。要在 WebView 上面叠 SurfaceView，得改内容视图结构，
 * 还要面对「WebView 硬件层 + Surface 独立层」的 z-order 与黑屏问题；而收益只是省掉一次
 * startActivityForResult。独立 Activity 还白捡一个好处：页面状态不丢（MainActivity 还在
 * 返回栈里，扫完回来，设置页里刚才那张二维码卡片和输入框都还在）。
 *
 * 结果怎么传出去
 * ==============
 * 只有一条通道：setResult + finish → MainActivity.onActivityResult → evaluateJavascript
 * → window.__dsScan.onResult(json)。**本类不解析配对串**（解析只有一份，在 src/services/sync/pairing.ts）。
 *
 * 生命周期（这里最容易漏，漏了的表现是第二次进不来、报 "Camera in use"）
 * ==================================================================
 *   onCreate 建视图 → onResume 开线程 + openCamera → onPause 关 session/device + 停线程
 *   → onDestroy 关 ImageReader。相机必须 open 在后台 HandlerThread 上（主线程 open 会卡 UI，
 *   部分机器直接抛 IllegalStateException）。
 */
@SuppressWarnings("deprecation") // createCaptureSession / onActivityResult / onBackPressed 在 API 30+ 标注过时，但在 minSdk 26 上行为最稳（与 MainActivity 同一取舍）
public class ScanActivity extends Activity {

    /** 成功时的原始文本（未经解析） */
    public static final String EXTRA_RAW = "raw";
    /** 失败原因：nocamera / permission / cancelled / timeout / error */
    public static final String EXTRA_REASON = "reason";
    /** 失败细节（只用于显示与排查） */
    public static final String EXTRA_DETAIL = "detail";

    public static final String REASON_NO_CAMERA = "nocamera";
    public static final String REASON_PERMISSION = "permission";
    public static final String REASON_CANCELLED = "cancelled";
    public static final String REASON_TIMEOUT = "timeout";
    public static final String REASON_ERROR = "error";

    private static final int REQ_PERMISSION = 2001;
    private static final int REQ_PICK_IMAGE = 2002;

    /** 解码用的取景尺寸上限（长边）：二维码识别不需要更高，720p 省内存也够快 */
    private static final int MAX_DECODE_EDGE = 1280;
    /** 图库图片解码时的长边上限：过大的图（4K 照片）会吃满内存，缩到 1600 足够 */
    private static final int MAX_IMAGE_EDGE = 1600;
    /** 连续多少毫秒没扫到就提示改路径 */
    private static final long HINT_AFTER_MS = 20000L;

    private SurfaceView previewView;
    private TextView hintView;
    private Button torchButton;
    private FrameLayout rootView;

    private CameraManager cameraManager;
    private CameraDevice cameraDevice;
    private CameraCaptureSession captureSession;
    /**
     * 已经发起了 createCaptureSession、但 onConfigured/onConfigureFailed 还没回来。
     *
     * 这个闸门不是洁癖：surfaceCreated 与 camera.onOpened 谁先到不确定，而每一次
     * createCaptureSession 都会**关掉上一次的会话**。没有它就会连开两次，第一份回调回来时
     * 拿着一个已经被关掉的 session 去 setRepeatingRequest，实测报
     * 「Session has been closed; further changes are illegal」，预览直接不启动。
     */
    private boolean sessionPending;
    private ImageReader imageReader;
    private String cameraId;
    private Size decodeSize;
    private boolean flashAvailable;
    private boolean torchOn;

    private HandlerThread cameraThread;
    private Handler cameraHandler;

    /** 相机权限是否已授予（每帧都要用，存字段省得反复查 binder） */
    private boolean cameraGranted;
    /** 本次进入是否已经弹过权限对话框：避免拒绝后在 onResume 里无限重弹 */
    private boolean permissionAsked;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        cameraManager = (CameraManager) getSystemService(CAMERA_SERVICE);
        buildViews();
    }

    // ── 视图 ────────────────────────────────────────────────────────────────

    /**
     * 全部用代码搭视图，不用 XML 布局。
     *
     * 理由与 MainActivity 一致：本项目零 Gradle、零 AndroidX，aapt2 只处理 res/ 下的资源；
     * 这么小的界面再引一份 layout 只会多一个构建环节。
     */
    private void buildViews() {
        rootView = new FrameLayout(this);
        rootView.setBackgroundColor(Color.BLACK);

        previewView = new SurfaceView(this);
        rootView.addView(previewView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // 取景框：白描边空心方框，只是视觉引导，不参与任何解码逻辑
        View box = new View(this);
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(0x00000000);
        shape.setStroke(dp(3), 0xCCFFFFFF);
        shape.setCornerRadius(dp(12));
        box.setBackground(shape);
        FrameLayout.LayoutParams boxParams = new FrameLayout.LayoutParams(dp(220), dp(220));
        boxParams.gravity = Gravity.CENTER;
        rootView.addView(box, boxParams);

        LinearLayout overlay = new LinearLayout(this);
        overlay.setOrientation(LinearLayout.VERTICAL);
        overlay.setPadding(dp(16), dp(16), dp(16), dp(24));
        rootView.addView(overlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // 顶栏：标题 + 手电筒 + 取消
        LinearLayout topBar = new LinearLayout(this);
        topBar.setOrientation(LinearLayout.HORIZONTAL);
        topBar.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = new TextView(this);
        title.setText("扫码配对");
        title.setTextColor(Color.WHITE);
        title.setTextSize(18);
        title.setShadowLayer(4, 0, 1, Color.BLACK);
        topBar.addView(title, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        torchButton = new Button(this);
        torchButton.setText("手电筒");
        torchButton.setVisibility(View.GONE);
        torchButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                toggleTorch();
            }
        });
        topBar.addView(torchButton);

        Button cancel = new Button(this);
        cancel.setText("取消");
        cancel.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                cancelScan();
            }
        });
        topBar.addView(cancel);
        overlay.addView(topBar);

        // 中间留白（取景框在 FrameLayout 里已居中，这里只是把底部提示压到底）
        View spacer = new View(this);
        overlay.addView(spacer, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        hintView = new TextView(this);
        hintView.setText("把电脑上的二维码放进取景框");
        hintView.setTextColor(Color.WHITE);
        hintView.setTextSize(14);
        hintView.setShadowLayer(4, 0, 1, Color.BLACK);
        overlay.addView(hintView);

        // 底部：从图片选择（无相机/不能授权时的唯一出路，所以永远存在）
        LinearLayout bottom = new LinearLayout(this);
        bottom.setOrientation(LinearLayout.HORIZONTAL);
        bottom.setGravity(Gravity.CENTER);
        Button pick = new Button(this);
        pick.setText("从图片选择");
        pick.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                pickImage();
            }
        });
        bottom.addView(pick);
        overlay.addView(bottom);

        setContentView(rootView);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    // ── 生命周期 ────────────────────────────────────────────────────────────

    @Override
    protected void onResume() {
        super.onResume();
        startCameraThread();
        if (!hasCameraFeature()) {
            // 没有相机不是错误：抬手就给「从图片选择」这条路（uses-feature required=false 保证能装）
            showBlocked("这台设备没有可用的相机，请用下面的「从图片选择」，或直接粘贴配对串");
            return;
        }
        // 回到前台时重新亮出预览：用户可能刚在系统设置里把相机权限打开
        previewView.setVisibility(View.VISIBLE);
        ensurePermissionThenOpen();
    }

    @Override
    protected void onPause() {
        // 顺序不能反过来：先关 session 再关 device，最后才停线程。
        // 不关的后果是下一次 openCamera 报 "Camera in use"（相机资源被本进程占着没释放）。
        closeCamera();
        stopCameraThread();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        closeReader();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        cancelScan();
    }

    // ── 权限 ────────────────────────────────────────────────────────────────

    /** 相机功能是否存在（uses-feature 里声明为 required=false，所以可能真的没有） */
    private boolean hasCameraFeature() {
        return getPackageManager().hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY);
    }

    private void ensurePermissionThenOpen() {
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            cameraGranted = true;
            openCamera();
            return;
        }
        cameraGranted = false;
        if (permissionAsked) {
            showBlocked("没有相机权限。到系统设置里允许本应用的「相机」，或用下面的「从图片选择」");
            return;
        }
        permissionAsked = true;
        requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_PERMISSION);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] granted) {
        super.onRequestPermissionsResult(requestCode, permissions, granted);
        if (requestCode != REQ_PERMISSION) {
            return;
        }
        boolean ok = granted != null && granted.length > 0
                && granted[0] == PackageManager.PERMISSION_GRANTED;
        if (ok) {
            cameraGranted = true;
            previewView.setVisibility(View.VISIBLE);
            setHint("把电脑上的二维码放进取景框");
            openCamera();
        } else {
            // 拒绝不崩、不退出：降到「从图片选择」这条路上，并把话说清楚
            showBlocked("没有相机权限。到系统设置里允许本应用的「相机」，或用下面的「从图片选择」");
        }
    }

    // ── 相机 ────────────────────────────────────────────────────────────────

    private void startCameraThread() {
        if (cameraThread != null) {
            return;
        }
        cameraThread = new HandlerThread("ds-scan-camera");
        cameraThread.start();
        cameraHandler = new Handler(cameraThread.getLooper());
    }

    private void stopCameraThread() {
        if (cameraThread == null) {
            return;
        }
        cameraThread.quitSafely();
        try {
            cameraThread.join(500);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
        cameraThread = null;
        cameraHandler = null;
    }

    /**
     * 打开相机。必须在后台线程的 Handler 上异步进行（openCamera 的回调走 cameraHandler）。
     */
    private void openCamera() {
        if (cameraDevice != null || cameraManager == null || cameraHandler == null) {
            return;
        }
        try {
            cameraId = pickCameraId();
            if (cameraId == null) {
                showBlocked("这台设备没有可用的相机，请用「从图片选择」或直接粘贴配对串");
                return;
            }
            CameraCharacteristics characteristics = cameraManager.getCameraCharacteristics(cameraId);
            Boolean flash = characteristics.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
            flashAvailable = flash != null && flash.booleanValue();
            StreamConfigurationMap map =
                    characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            if (map == null) {
                showBlocked("这个相机不提供取景配置，请用「从图片选择」");
                return;
            }
            decodeSize = pickDecodeSize(map.getOutputSizes(ImageFormat.YUV_420_888));
            Size previewSize = pickPreviewSize(map.getOutputSizes(SurfaceHolder.class));
            if (previewSize != null) {
                previewView.getHolder().setFixedSize(previewSize.getWidth(), previewSize.getHeight());
            }
            openReader();
            previewView.getHolder().addCallback(surfaceCallback);
            cameraManager.openCamera(cameraId, deviceCallback, cameraHandler);
            if (flashAvailable) {
                torchButton.setVisibility(View.VISIBLE);
            }
        } catch (SecurityException e) {
            showBlocked("没有相机权限，请到系统设置里允许「相机」");
        } catch (CameraAccessException e) {
            showBlocked("打不开相机：" + e.getMessage() + "；可以用「从图片选择」");
        } catch (Exception e) {
            showBlocked("打不开相机：" + e.getMessage() + "；可以用「从图片选择」");
        }
    }

    /** 优先后置摄像头；没有就随便挑一个（模拟器可能只有一个「虚拟」相机） */
    private String pickCameraId() throws CameraAccessException {
        String[] ids = cameraManager.getCameraIdList();
        if (ids == null || ids.length == 0) {
            return null;
        }
        for (String id : ids) {
            CameraCharacteristics c = cameraManager.getCameraCharacteristics(id);
            Integer facing = c.get(CameraCharacteristics.LENS_FACING);
            if (facing != null && facing.intValue() == CameraCharacteristics.LENS_FACING_BACK) {
                return id;
            }
        }
        return ids[0];
    }

    /** 取长边 <= MAX_DECODE_EDGE 的最大尺寸；都太大时取最小的那个 */
    private static Size pickDecodeSize(Size[] sizes) {
        if (sizes == null || sizes.length == 0) {
            return new Size(640, 480);
        }
        List<Size> list = new ArrayList<Size>(Arrays.asList(sizes));
        Collections.sort(list, new Comparator<Size>() {
            @Override
            public int compare(Size a, Size b) {
                return Long.compare((long) a.getWidth() * a.getHeight(),
                        (long) b.getWidth() * b.getHeight());
            }
        });
        Size best = null;
        for (Size s : list) {
            if (Math.max(s.getWidth(), s.getHeight()) <= MAX_DECODE_EDGE) {
                best = s;
            }
        }
        return best != null ? best : list.get(0);
    }

    /** 预览尺寸：只用来给人看，挑个常见的比例即可；拿不到就交给系统默认 */
    private static Size pickPreviewSize(Size[] sizes) {
        if (sizes == null || sizes.length == 0) {
            return null;
        }
        for (Size s : sizes) {
            if (s.getWidth() == 1280 && s.getHeight() == 720) {
                return s;
            }
        }
        return sizes[0];
    }

    private void openReader() {
        closeReader();
        // maxImages=2：多了涨内存，少了容易在解码期间把新帧全丢掉
        imageReader = ImageReader.newInstance(decodeSize.getWidth(), decodeSize.getHeight(),
                ImageFormat.YUV_420_888, 2);
        imageReader.setOnImageAvailableListener(onImage, cameraHandler);
    }

    private void closeReader() {
        if (imageReader != null) {
            try {
                imageReader.close();
            } catch (Exception ignored) {
                // 已经关了
            }
            imageReader = null;
        }
    }

    private void closeCamera() {
        sessionPending = false;
        if (captureSession != null) {
            try {
                captureSession.close();
            } catch (Exception ignored) {
                // 已经断了
            }
            captureSession = null;
        }
        if (cameraDevice != null) {
            try {
                cameraDevice.close();
            } catch (Exception ignored) {
                // 已经断了
            }
            cameraDevice = null;
        }
        if (previewView != null) {
            try {
                previewView.getHolder().removeCallback(surfaceCallback);
            } catch (Exception ignored) {
                // 没有回调
            }
        }
        closeReader();
        torchOn = false;
    }

    private final SurfaceHolder.Callback surfaceCallback = new SurfaceHolder.Callback() {
        @Override
        public void surfaceCreated(SurfaceHolder holder) {
            createSession();
        }

        @Override
        public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
            createSession();
        }

        @Override
        public void surfaceDestroyed(SurfaceHolder holder) {
            // 预览面没了：先关 session，等 surfaceCreated 再重建。
            // sessionPending 也要一起清 —— 不然「发起建会话 → 面被销毁」会把闸门永远卡死
            if (captureSession != null) {
                try {
                    captureSession.close();
                } catch (Exception ignored) {
                    // 已关
                }
                captureSession = null;
            }
            sessionPending = false;
        }
    };

    private final CameraDevice.StateCallback deviceCallback = new CameraDevice.StateCallback() {
        @Override
        public void onOpened(CameraDevice camera) {
            cameraDevice = camera;
            createSession();
        }

        @Override
        public void onDisconnected(CameraDevice camera) {
            camera.close();
            cameraDevice = null;
        }

        @Override
        public void onError(CameraDevice camera, int error) {
            camera.close();
            cameraDevice = null;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    setHint("相机出错（code " + error + "），可以用「从图片选择」");
                }
            });
        }
    };

    /**
     * 建预览会话：需要相机已打开 + 预览面有效 + ImageReader 就绪，三样缺一个就先等着
     * （等的那一方会再调一次：onOpened / surfaceCreated / surfaceChanged 都会走到这里）。
     *
     * 用 sessionPending 挡住「同一时刻发起两次」—— 每次 createCaptureSession 都会关掉上一次
     * 的会话，第二次的回调拿到的是已关闭的 session（见字段注释）。
     */
    private void createSession() {
        if (cameraDevice == null || imageReader == null) {
            return;
        }
        if (captureSession != null || sessionPending) {
            return;
        }
        Surface previewSurface = previewView.getHolder().getSurface();
        if (previewSurface == null || !previewSurface.isValid()) {
            return;
        }
        sessionPending = true;
        try {
            List<Surface> targets = new ArrayList<Surface>();
            targets.add(previewSurface);
            targets.add(imageReader.getSurface());
            cameraDevice.createCaptureSession(targets, new CameraCaptureSession.StateCallback() {
                @Override
                public void onConfigured(CameraCaptureSession session) {
                    sessionPending = false;
                    captureSession = session;
                    startPreview();
                }

                @Override
                public void onConfigureFailed(CameraCaptureSession session) {
                    sessionPending = false;
                    setHint("预览配置失败，可以用「从图片选择」");
                }
            }, cameraHandler);
        } catch (CameraAccessException e) {
            sessionPending = false;
            setHint("预览启动失败：" + e.getMessage());
        } catch (Exception e) {
            sessionPending = false;
            setHint("预览启动失败：" + e.getMessage());
        }
    }

    private void startPreview() {
        if (captureSession == null || cameraDevice == null) {
            return;
        }
        Surface previewSurface = previewView.getHolder().getSurface();
        if (previewSurface == null || !previewSurface.isValid()) {
            // 面已销毁：等 surfaceCreated 重新建会话，别拿失效的 surface 去 setRepeatingRequest
            return;
        }
        try {
            CaptureRequest.Builder builder =
                    cameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            builder.addTarget(previewView.getHolder().getSurface());
            builder.addTarget(imageReader.getSurface());
            // 连续对焦：拍屏幕时更容易抓住清晰的那一帧
            Integer afMode = CameraCharacteristics.CONTROL_AF_MODE_CONTINUOUS_PICTURE;
            builder.set(CaptureRequest.CONTROL_AF_MODE, afMode);
            builder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);
            captureSession.setRepeatingRequest(builder.build(), null, cameraHandler);
            scheduleTimeoutHint();
        } catch (IllegalStateException e) {
            // 会话在这期间被关掉了（例如预览面重建）：清掉引用，让下一次 onOpened/surfaceChanged 重建
            captureSession = null;
            setHint("预览重启中…");
        } catch (Exception e) {
            setHint("预览启动失败：" + e.getMessage());
        }
    }

    private void scheduleTimeoutHint() {
        if (cameraHandler == null) {
            return;
        }
        cameraHandler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (captureSession != null) {
                    setHint("还没扫到？把码放满取景框、调亮屏幕，或用下面的「从图片选择」");
                }
            }
        }, HINT_AFTER_MS);
    }

    /**
     * 解码一帧。
     *
     * 直接在这个回调线程里做（不另开线程）：解码耗时 0–30 ms，而这个 handler 同时也在跑
     * 相机的回调 —— 阻塞它一点点比「多一个线程 + 队列 + 竞态」划算。解码期间进来的新帧
     * 会由 ImageReader 的 maxImages=2 自动丢掉（丢帧正是我们想要的：永远只解最新一帧）。
     */
    private final ImageReader.OnImageAvailableListener onImage =
            new ImageReader.OnImageAvailableListener() {
                @Override
                public void onImageAvailable(ImageReader reader) {
                    Image image = null;
                    try {
                        image = reader.acquireLatestImage();
                    } catch (Exception e) {
                        return;
                    }
                    if (image == null) {
                        return;
                    }
                    String text = null;
                    try {
                        Image.Plane plane = image.getPlanes()[0];
                        ByteBuffer buffer = plane.getBuffer();
                        int width = image.getWidth();
                        int height = image.getHeight();
                        int rowStride = plane.getRowStride();
                        byte[] data = new byte[buffer.remaining()];
                        buffer.get(data);
                        text = QrDecode.decodeY(data, width, height, rowStride);
                    } catch (Exception e) {
                        text = null;
                    } finally {
                        try {
                            image.close();
                        } catch (Exception ignored) {
                            // 已经关了
                        }
                    }
                    if (text != null && text.trim().length() > 0) {
                        finishWithRaw(text.trim());
                    }
                }
            };

    private void toggleTorch() {
        if (cameraManager == null || cameraId == null || !flashAvailable) {
            toast("这台设备没有闪光灯");
            return;
        }
        try {
            torchOn = !torchOn;
            cameraManager.setTorchMode(cameraId, torchOn);
            torchButton.setText(torchOn ? "关手电筒" : "手电筒");
        } catch (Exception e) {
            torchOn = false;
            toast("手电筒不可用：" + e.getMessage());
        }
    }

    // ── 从图片选择 ──────────────────────────────────────────────────────────

    /**
     * 走系统选择器取图（ACTION_GET_CONTENT）：零权限，用户自己选位置。
     * 这条路径同时是「没有相机」「相机被占」时的兜底，也是自动化验收唯一能走的入口。
     */
    private void pickImage() {
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.setType("image/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        try {
            startActivityForResult(Intent.createChooser(intent, "选择二维码图片"), REQ_PICK_IMAGE);
        } catch (Exception e) {
            toast("打不开图片选择器：" + e.getMessage());
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_PICK_IMAGE) {
            return;
        }
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            setHint("没有选择图片");
            return;
        }
        final Uri uri = data.getData();
        setHint("正在识别图片…");
        new Thread(new Runnable() {
            @Override
            public void run() {
                String text = null;
                String error = null;
                try {
                    text = decodeImage(uri);
                } catch (Exception e) {
                    error = e.getMessage();
                }
                final String found = text;
                final String failure = error;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (found != null && found.trim().length() > 0) {
                            finishWithRaw(found.trim());
                        } else if (failure != null) {
                            setHint("读不出这张图片：" + failure);
                        } else {
                            setHint("这张图片里没找到二维码，换一张或让电脑上重新截图");
                        }
                    }
                });
            }
        }).start();
    }

    /**
     * 把图片解成文本。
     *
     * 两步走：先只读尺寸（inJustDecodeBounds）算出采样率，再真解码 — 否则一张 4K 照片
     * 直接 decode 会是 40 MB 的位图，模拟器/低端机直接 OOM。
     *
     * @param uri 系统选择器回传的 content:// 地址
     * @return 解出的文本；没有二维码返回 null
     * @throws Exception 读不到流、或图片本身损坏
     */
    private String decodeImage(Uri uri) throws Exception {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        InputStream probe = getContentResolver().openInputStream(uri);
        if (probe == null) {
            throw new Exception("打不开文件");
        }
        try {
            BitmapFactory.decodeStream(probe, null, bounds);
        } finally {
            probe.close();
        }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw new Exception("不是有效的图片");
        }
        int sample = 1;
        while (Math.max(bounds.outWidth, bounds.outHeight) / sample > MAX_IMAGE_EDGE) {
            sample *= 2;
        }
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sample;
        options.inPreferredConfig = Bitmap.Config.ARGB_8888;
        Bitmap bitmap;
        InputStream stream = getContentResolver().openInputStream(uri);
        if (stream == null) {
            throw new Exception("打不开文件");
        }
        try {
            bitmap = BitmapFactory.decodeStream(stream, null, options);
        } finally {
            stream.close();
        }
        if (bitmap == null) {
            throw new Exception("解码图片失败");
        }
        try {
            int width = bitmap.getWidth();
            int height = bitmap.getHeight();
            int[] pixels = new int[width * height];
            bitmap.getPixels(pixels, 0, width, 0, 0, width, height);
            return QrDecode.decodeRgb(pixels, width, height);
        } finally {
            bitmap.recycle();
        }
    }

    // ── 收口 ────────────────────────────────────────────────────────────────

    /** 扫到了：带上原始串回给 MainActivity（先关相机再 finish，避免相机资源悬着） */
    private void finishWithRaw(String raw) {
        Intent result = new Intent();
        result.putExtra(EXTRA_RAW, raw);
        setResult(RESULT_OK, result);
        cameraGranted = false;
        closeCamera();
        finish();
    }

    private void cancelScan() {
        Intent result = new Intent();
        result.putExtra(EXTRA_REASON, REASON_CANCELLED);
        setResult(RESULT_CANCELED, result);
        closeCamera();
        finish();
    }

    /**
     * 进入「这条路走不通」的状态：提示换成能照做的那句，并放开「从图片选择」。
     *
     * 必须把 SurfaceView 藏掉：它是独立图层、会在窗口上「挖一个洞」（surface 本身是透明的），
     * 相机没在出帧时看到的是**后一个窗口**的内容 —— 实测拒绝权限后透出了桌面/上一个应用的画面，
     * 看着像应用没渲染好。藏掉之后剩下的就是纯黑底 + 提示文字。
     */
    private void showBlocked(final String message) {
        closeCamera();
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (previewView != null) {
                    previewView.setVisibility(View.GONE);
                }
                setHint(message);
                if (torchButton != null) {
                    torchButton.setVisibility(View.GONE);
                }
            }
        });
    }

    private void setHint(final String message) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (hintView != null) {
                    hintView.setText(message);
                }
            }
        });
    }

    private void toast(final String message) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(ScanActivity.this, message, Toast.LENGTH_SHORT).show();
            }
        });
    }
}
