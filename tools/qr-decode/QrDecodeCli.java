package dstools;

import ds.app.QrDecode;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.File;

/**
 * 桌面 JVM 上的二维码解码探针：把 tools/qr-samples/ 里的图片喂给 **APK 里那段同样的解码代码**。
 *
 * 为什么能这么跑
 * ==============
 * ds.app.QrDecode 刻意不引用任何 android.* 符号（相机帧的 Y 平面与图库图片的 ARGB 都退化成
 * 基本类型数组），所以在桌面 JVM 上用 javac + java 就能直接跑。这不是为了测试而测试：
 * 没有真机时，「按 rowStride 逐行拷 Y 平面」这类逻辑没有任何别的办法能验证 ——
 * 它错了的表现是「图像斜一点、人眼看着像二维码、解码器永远 NotFound」。
 *
 * 两种模式（对应 ScanActivity 的两条输入路径）
 *   QrDecodeCli <图片>                → ARGB 像素 → QrDecode.decodeRgb（图库图片）
 *   QrDecodeCli --yuv <填充字节> <图片> → 造一个 rowStride = 宽度 + 填充 的 Y 平面
 *                                      → QrDecode.decodeY（相机帧）
 *
 * 输出：解出的原文到 stdout（**只有这一行**，供脚本逐字符比对）；解不出打印 null。
 * 退出码：0 = 解出；1 = 这张图里没有可识别的二维码；2 = 参数/IO 错误。
 */
public final class QrDecodeCli {

    private QrDecodeCli() {
    }

    public static void main(String[] args) {
        String file = null;
        int pad = -1;
        for (int i = 0; i < args.length; i++) {
            if ("--yuv".equals(args[i])) {
                if (i + 1 >= args.length) {
                    System.err.println("--yuv 后面要跟填充字节数（0 表示不留填充）");
                    System.exit(2);
                }
                pad = Integer.parseInt(args[++i]);
            } else {
                file = args[i];
            }
        }
        if (file == null) {
            System.err.println("用法：QrDecodeCli [--yuv <填充字节>] <图片文件>");
            System.exit(2);
        }
        BufferedImage image;
        try {
            image = ImageIO.read(new File(file));
        } catch (Exception e) {
            System.err.println("读不了图片：" + e);
            System.exit(2);
            return;
        }
        if (image == null) {
            System.err.println("不是 ImageIO 认识的图片格式：" + file);
            System.exit(2);
            return;
        }
        int width = image.getWidth();
        int height = image.getHeight();
        int[] pixels = new int[width * height];
        image.getRGB(0, 0, width, height, pixels, 0, width);

        String text;
        if (pad >= 0) {
            int stride = width + pad;
            byte[] y = toYPlane(pixels, width, height, stride);
            text = QrDecode.decodeY(y, width, height, stride);
        } else {
            text = QrDecode.decodeRgb(pixels, width, height);
        }

        if (text == null || text.isEmpty()) {
            System.out.println("null");
            System.exit(1);
        }
        System.out.println(text);
        System.exit(0);
    }

    /**
     * 把 ARGB 像素折成 Y 平面，并按给定行跨距排布（每行末尾留 pad 个无关字节）。
     *
     * 亮度用 BT.601 系数（0.299R + 0.587G + 0.114B）—— ZXing 的 RGBLuminanceSource 也是这一套，
     * 两种模式解出同一串才说明「差的不只是亮度算法」。
     *
     * @param pixels ARGB 像素（行优先）
     * @param width  宽度
     * @param height 高度
     * @param stride 行跨距（>= width）
     * @return 长度 stride × height 的 Y 平面；填充字节故意写成 0x5A（非 0/非 255），
     *         一旦解码实现漏掉跨距，这些垃圾字节就会破坏图像
     */
    private static byte[] toYPlane(int[] pixels, int width, int height, int stride) {
        byte[] y = new byte[stride * height];
        for (int row = 0; row < height; row++) {
            int base = row * stride;
            for (int col = 0; col < width; col++) {
                int argb = pixels[row * width + col];
                int r = (argb >> 16) & 0xff;
                int g = (argb >> 8) & 0xff;
                int b = argb & 0xff;
                y[base + col] = (byte) ((r * 299 + g * 587 + b * 114) / 1000);
            }
            for (int fill = width; fill < stride; fill++) {
                y[base + fill] = (byte) 0x5A;
            }
        }
        return y;
    }
}
