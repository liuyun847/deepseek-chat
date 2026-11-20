package ds.app;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.ChecksumException;
import com.google.zxing.DecodeHintType;
import com.google.zxing.FormatException;
import com.google.zxing.LuminanceSource;
import com.google.zxing.NotFoundException;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.RGBLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;

import java.util.EnumMap;
import java.util.EnumSet;
import java.util.Map;

/**
 * 二维码解码：把「一块像素」变成「一串文本」。**整个类不引用任何 android.* 符号。**
 *
 * 为什么刻意不引用 android.*
 * =========================
 * 相机帧（YUV 的 Y 平面）与图库图片（ARGB 像素）在这里都退化成基本类型数组，
 * 于是同一份解码代码能在桌面 JVM 上用 javac + java 直接跑（tools/qr-decode-check.ps1）。
 * 没有真机时这是唯一能钉住「行跨距（rowStride）算没算对」的办法 —— 那正是这类代码
 * 最常见的静默错误：图像斜着、人眼看着像二维码、解码器永远 NotFound。
 *
 * 失败一律返回 null，不抛异常：扫码路径上「这一帧没认出码」是正常状态，不是错误。
 * 只吞 ZXing 的三种受检异常（NotFoundException / ChecksumException / FormatException），
 * 其余异常（例如 OOM）继续往上抛，不掩盖真实故障。
 */
public final class QrDecode {

    /**
     * 解码提示：只试 QR，并开启 TRY_HARDER。
     *
     * - POSSIBLE_FORMATS 收窄到 QR_CODE：屏幕反光时一帧要试十几种码型纯属浪费；
     * - TRY_HARDER：低对比度 / 轻微模糊时是解得出与解不出的差别（实测过的边界见设计文档）。
     * 初始化后只读，多线程共用安全。
     */
    private static final Map<DecodeHintType, Object> HINTS = buildHints();

    private QrDecode() {
        // 纯静态工具类
    }

    private static Map<DecodeHintType, Object> buildHints() {
        Map<DecodeHintType, Object> hints = new EnumMap<DecodeHintType, Object>(DecodeHintType.class);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, EnumSet.of(BarcodeFormat.QR_CODE));
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        return hints;
    }

    /**
     * 解相机帧（YUV_420_888 的 Y 平面，即灰度）。
     *
     * rowStride 常常大于宽度（硬件按 16/32 字节对齐补了填充）。直接整块 memcpy 会得到
     * 「每行都右移一点」的斜图 —— 人眼几乎看不出，解码器必然失败。所以按行拷前 width 字节，
     * 源偏移 row * rowStride。
     *
     * @param data      Y 平面原始字节（通常来自 Image.Plane.getBuffer()）
     * @param width     图像宽度（像素）
     * @param height    图像高度（像素）
     * @param rowStride 行跨距（字节）；<= 0 或等于 width 时按紧密排列处理
     * @return 解出的文本；这一帧没有可识别的二维码时返回 null
     */
    public static String decodeY(byte[] data, int width, int height, int rowStride) {
        if (data == null || width <= 0 || height <= 0) {
            return null;
        }
        int stride = rowStride > 0 ? rowStride : width;
        if (stride < width) {
            return null;
        }
        byte[] tight;
        if (stride == width) {
            if (data.length < width * height) {
                return null;
            }
            tight = data;
        } else {
            tight = new byte[width * height];
            for (int row = 0; row < height; row++) {
                int from = row * stride;
                if (from < 0 || from + width > data.length) {
                    return null;
                }
                System.arraycopy(data, from, tight, row * width, width);
            }
        }
        // 只给 Y 数据也能用 PlanarYUVLuminanceSource：它的 getRow 只读 Y 平面
        // （偏移 (y + top) * dataWidth + left），不碰 UV —— 这一点由 tools/qr-decode-check.ps1 钉住
        LuminanceSource source = new PlanarYUVLuminanceSource(
                tight, width, height, 0, 0, width, height, false);
        return decodeSource(source);
    }

    /**
     * 解一张图库图片（ARGB_8888 像素数组）。
     *
     * 走 ZXing 自带的 RGBLuminanceSource（亮度按 0.299R + 0.587G + 0.114B 折算）。
     * 位图解码（BitmapFactory）留在 ScanActivity 里，本类只收 int[]，所以桌面 JVM 上照样能跑。
     *
     * @param pixels ARGB 像素，长度必须 >= width * height，按行优先
     * @param width  宽度
     * @param height 高度
     * @return 解出的文本；没有二维码时返回 null
     */
    public static String decodeRgb(int[] pixels, int width, int height) {
        if (pixels == null || width <= 0 || height <= 0 || pixels.length < width * height) {
            return null;
        }
        return decodeSource(new RGBLuminanceSource(width, height, pixels));
    }

    /**
     * 解一个亮度源（两个入口最后都汇到这里，只有这一处决定用什么二值化与什么 Reader）。
     *
     * @param source 亮度源
     * @return 文本；没解出返回 null
     */
    private static String decodeSource(LuminanceSource source) {
        try {
            BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(source));
            Result result = new QRCodeReader().decode(bitmap, HINTS);
            return result == null ? null : result.getText();
        } catch (NotFoundException e) {
            return null;
        } catch (ChecksumException e) {
            return null;
        } catch (FormatException e) {
            return null;
        }
    }
}
