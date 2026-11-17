package ds.app;

import android.content.Context;
import android.net.wifi.WifiManager;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 局域网点对点传输层：UDP 广播发现 + TCP 请求/响应搬运。
 *
 * 职责边界（刻意做窄）
 * ===================
 * 这一层只搬字节，不认识聊天数据：请求体是页面加密好的信封 JSON（format/proto/from/id/ts/iv/data），
 * 本类只从里面取一个 {@code id} 用来把回复对上号，其余原样透传给页面。因此：
 *   - 密钥、口令、明文永远不进 Java 层，也不写进任何日志；
 *   - 合并与落库全在页面（WebView 里的 TS），Java 没有第二套业务逻辑。
 *
 * 发现（为什么必须用 UDP 广播 + MulticastLock）
 * ==========================================
 * 零配置发现只能是「大家都往局域网广播地址喊一声」。Android 9 上有个坑：Wi-Fi 驱动默认
 * 会把发往广播/组播的包过滤掉，不解锁就永远收不到对端广播 —— 必须
 * WifiManager.createMulticastLock() 加锁（需要 CHANGE_WIFI_MULTICAST_STATE 权限）。
 * 锁在页面前台时持有、退到后台立即释放：它是全局的 Wi-Fi 过滤开关，长期持有会费电。
 *
 * TCP 端口随机
 * ===========
 * ServerSocket 绑 0 端口由系统分配，随广播带出去，因此不需要任何固定端口约定，
 * 也不会和手机上别的应用抢端口。同一台机器上两个进程各自监听自己的随机端口即可。
 *
 * 为什么用「4 字节长度前缀 + 正文」而不是「读到 EOF」
 * ==============================================
 * 一问一答只需要一次连接，最早写的是客户端发完就 shutdownOutput（半关），服务端读到
 * EOF 即知道请求完整。但半关在 adb forward、部分 NAT/代理上不可靠：代理可能把半关当成
 * 整条连接结束，回包就再也回不去（实测：模拟器 + adb forward 上服务端写完了、宿主侧
 * 一个字节都收不到）。长度前缀让两端都不依赖 FIN，读超时也变成真正的异常而不是正常路径。
 * 4 字节大端，与 Node 侧 Buffer.writeUInt32BE 一致。
 *
 * 线程模型
 * ======
 *   收广播线程  —— DatagramSocket.receive 循环，维护对端表
 *   广播线程    —— 每 ANNOUNCE_INTERVAL_MS 发一次，顺带清理超时对端
 *   接受线程    —— ServerSocket.accept 循环，每个连接一个线程（个人局域网并发极低）
 *   发送线程    —— 每次主动请求一个线程（同步 I/O，简单可靠）
 * 所有回调都从工作线程抛给 MainActivity，由它切到 UI 线程再 evaluateJavascript。
 *
 * 注意：本类不能用 lambda（javac 以 android.jar 作 bootclasspath 编译，没有 LambdaMetafactory）。
 */
public class LanLink {

    /** 发现用的 UDP 端口：两端必须一致。选一个不常用的大端口，避开系统服务 */
    private static final int DISCOVERY_PORT = 47823;

    /** 广播周期。4 秒是「发现够快」与「流量/耗电够省」的折中，对端表 3 个周期过期 */
    private static final int ANNOUNCE_INTERVAL_MS = 4000;

    /** 对端有效期：3 个广播周期没消息就当离线 */
    private static final long PEER_TTL_MS = ANNOUNCE_INTERVAL_MS * 3L + 2000L;

    /** 单条请求的体积上限（与页面侧的 32 MB 含义一致，留出信封与 base64 膨胀余量） */
    private static final int MAX_PAYLOAD = 40 * 1024 * 1024;

    /** 连接读超时：对端半死不活时不至于永远占着线程 */
    private static final int READ_TIMEOUT_MS = 20000;

    /** 请求方等回复的上限 */
    private static final int REPLY_TIMEOUT_MS = 30000;

    /** 回调出口。实现方负责切线程。 */
    public interface Listener {
        /** 诊断日志（只在 debug 模式输出到 logcat） */
        void onLog(String message);

        /** 在线设备表变化（具体内容由调用方用 peersJson() 现取） */
        void onPeers();

        /** 收到一个请求；调用方应尽快用 take() 取走信封，并（可选）reply() 回一条 */
        void onRequest(String requestId);

        /** 主动请求有了结果（成功或失败），同样用 take() 取 */
        void onResponse(String requestId);
    }

    /** 对端一台设备 */
    private static final class Peer {
        String deviceId;
        String name;
        String host;
        int port;
        String pairTag;
        long lastSeen;
    }

    /** 收件箱上限（条） */
    private static final int INBOX_LIMIT = 16;

    /** 一个等待回复的连接 */
    private static final class Pending {
        final Socket socket;
        final CountDownLatch latch = new CountDownLatch(1);
        volatile String response;

        Pending(Socket socket) {
            this.socket = socket;
        }
    }

    private final Context context;
    private final Listener listener;
    private final Object lock = new Object();

    /** deviceId → 对端。LinkedHashMap 保持插入顺序，日志与界面显示稳定 */
    private final Map<String, Peer> peers = new LinkedHashMap<String, Peer>();

    /** requestId → 等待回复的连接（服务端角色） */
    private final Map<String, Pending> pending = new LinkedHashMap<String, Pending>();

    /**
     * 收件箱：requestId → 一条待取走的数据。
     * 下标 0 是负载（信封 JSON），下标 1 是错误信息（两者必有其一）。
     *
     * 为什么要中转而不是直接 evaluateJavascript 塞进去：一次同步的密文 base64 可能有几 MB，
     * 拼进脚本文本会让 WebView 去解析一段超长字符串字面量；改成「先通知 id、JS 再同步来取」，
     * 大字符串只走 bridge 的返回值，脚本本身永远只有几十字节。
     * 上限 16 条，超出丢最旧的：页面卡死时不能让收件箱无限涨。
     */
    private final Map<String, String[]> inbox = new LinkedHashMap<String, String[]>();

    private volatile boolean running = false;
    private volatile boolean foreground = true;
    private volatile String deviceId = "";
    private volatile String deviceName = "";
    private volatile String pairTag = "";
    private volatile int tcpPort = 0;

    private ServerSocket serverSocket;
    private DatagramSocket udpSocket;
    private Thread acceptThread;
    private Thread receiveThread;
    private Thread announceThread;
    private WifiManager.MulticastLock multicastLock;

    /**
     * @param context  应用上下文（取 WifiManager 用）
     * @param listener 回调出口，非空
     */
    public LanLink(Context context, Listener listener) {
        this.context = context.getApplicationContext() == null ? context : context.getApplicationContext();
        this.listener = listener;
    }

    public boolean isRunning() {
        return running;
    }

    /**
     * 开始监听并广播。重复调用是幂等的（已经在跑就直接返回当前信息）。
     *
     * @param id    本机设备 id（与记录里的 device 字段同源，冲突判定用）
     * @param name  本机设备名（只用于展示）
     * @param tag   口令指纹；空串表示还没设口令，此时只广播「我在线」但不会配对
     * @return 本机信息 JSON，含 tcp 端口与局域网 IPv4（拿不到时为 127.0.0.1）
     * @throws IOException 端口绑不上（极端情况：系统没有可用端口）
     */
    public String start(String id, String name, String tag) throws IOException {
        if (running) {
            return selfJson();
        }
        deviceId = id == null ? "" : id;
        deviceName = name == null ? "" : name;
        pairTag = tag == null ? "" : tag;
        if (deviceId.isEmpty()) {
            throw new IOException("deviceId 不能为空");
        }

        ServerSocket server = new ServerSocket(0);
        server.setReuseAddress(true);
        serverSocket = server;
        tcpPort = server.getLocalPort();

        DatagramSocket udp = new DatagramSocket(null);
        udp.setReuseAddress(true);
        udp.setBroadcast(true);
        udp.bind(new InetSocketAddress(DISCOVERY_PORT));
        udpSocket = udp;

        running = true;
        startThreads();
        updateLock();
        log("start device=" + deviceId + " tcp=" + tcpPort);
        return selfJson();
    }

    /** 停止所有线程并释放端口。幂等。 */
    public void stop() {
        if (!running) {
            return;
        }
        running = false;
        log("stop");
        closeQuietly(serverSocket);
        closeQuietly(udpSocket);
        serverSocket = null;
        udpSocket = null;
        synchronized (lock) {
            for (Pending item : pending.values()) {
                closeQuietly(item.socket);
                item.latch.countDown();
            }
            pending.clear();
            peers.clear();
            inbox.clear();
        }
        releaseLock();
    }

    /** 前后台切换：后台不广播、不持有组播锁（省电），但保留 TCP 监听以便对端还能推过来 */
    public void setForeground(boolean value) {
        if (foreground == value) {
            return;
        }
        foreground = value;
        log("foreground=" + value);
        updateLock();
    }

    /** 在线设备表（JSON 数组）。字段与广播里的一致，另加 lastSeen */
    public String peersJson() {
        List<Peer> snapshot;
        synchronized (lock) {
            snapshot = new ArrayList<Peer>(peers.values());
        }
        StringBuilder builder = new StringBuilder("[");
        for (int index = 0; index < snapshot.size(); index++) {
            Peer peer = snapshot.get(index);
            if (index > 0) {
                builder.append(',');
            }
            JSONObject item = new JSONObject();
            try {
                item.put("deviceId", peer.deviceId);
                item.put("name", peer.name);
                item.put("host", peer.host);
                item.put("port", peer.port);
                item.put("pairTag", peer.pairTag == null ? "" : peer.pairTag);
                item.put("lastSeen", peer.lastSeen);
            } catch (Exception ignored) {
                // JSONObject.put 只在 key 为 null 时抛，这里 key 全是常量
            }
            builder.append(item.toString());
        }
        builder.append(']');
        return builder.toString();
    }

    /**
     * 主动发一个请求，结果通过 {@link Listener#onResponse} 异步回来。
     *
     * @param requestId 调用方生成的请求 id（用于对上回调）
     * @param host      对端地址
     * @param port      对端端口
     * @param payload   信封 JSON
     * @sideeffect 起一个工作线程做同步 I/O
     */
    public void send(final String requestId, final String host, final int port, final String payload) {
        Thread worker = new Thread(new Runnable() {
            @Override
            public void run() {
                Socket socket = null;
                try {
                    byte[] bytes = payload.getBytes(StandardCharsets.UTF_8);
                    if (bytes.length > MAX_PAYLOAD) {
                        synchronized (lock) {
                            putInbox(requestId, null, "payload too large");
                        }
                        listener.onResponse(requestId);
                        return;
                    }
                    socket = new Socket();
                    socket.connect(new InetSocketAddress(host, port), 5000);
                    socket.setSoTimeout(READ_TIMEOUT_MS);
                    OutputStream out = new BufferedOutputStream(socket.getOutputStream());
                    writeFrame(out, bytes);
                    out.flush();
                    String text = readFrame(new DataInputStream(new BufferedInputStream(
                            socket.getInputStream())), MAX_PAYLOAD);
                    log("send ok id=" + requestId + " bytes=" + text.length());
                    synchronized (lock) {
                        putInbox(requestId, text, null);
                    }
                    listener.onResponse(requestId);
                } catch (Exception e) {
                    log("send fail id=" + requestId + " " + e);
                    synchronized (lock) {
                        putInbox(requestId, null, String.valueOf(e.getMessage()));
                    }
                    listener.onResponse(requestId);
                } finally {
                    closeQuietly(socket);
                }
            }
        }, "ds-lan-send");
        worker.setDaemon(true);
        worker.start();
    }

    /**
     * 取走收件箱里的一条数据（页面在收到 onRequest / onResponse 之后调用）。
     *
     * @param requestId 回调里给的那个 id
     * @return JSON：{"ok":true,"payload":"<信封 JSON>"} 或 {"ok":false,"error":"原因"}；没有这条返回 null
     * @sideeffect 该条从收件箱移除（只能取一次）
     */
    public String take(String requestId) {
        String[] entry;
        synchronized (lock) {
            entry = inbox.remove(requestId);
        }
        if (entry == null) {
            return null;
        }
        JSONObject json = new JSONObject();
        try {
            if (entry[1] != null) {
                json.put("ok", false);
                json.put("error", entry[1]);
            } else {
                json.put("ok", true);
                json.put("payload", entry[0] == null ? "" : entry[0]);
            }
        } catch (Exception e) {
            return null;
        }
        return json.toString();
    }

    /** 放进收件箱并维持上限。调用方需已持有 lock。 */
    private void putInbox(String requestId, String payload, String error) {
        inbox.put(requestId, new String[]{payload, error});
        while (inbox.size() > INBOX_LIMIT) {
            Iterator<String> iterator = inbox.keySet().iterator();
            if (!iterator.hasNext()) {
                break;
            }
            iterator.next();
            iterator.remove();
        }
    }

    /**
     * 回复一个收到的请求（服务端角色）。
     *
     * @param requestId onRequest 给的那个 id
     * @param payload   信封 JSON；null 表示不回内容，直接关连接
     * @return true 表示这个请求还在等（未被超时清掉）
     */
    public boolean reply(String requestId, String payload) {
        Pending item;
        synchronized (lock) {
            item = pending.get(requestId);
        }
        if (item == null) {
            log("reply late id=" + requestId);
            return false;
        }
        item.response = payload;
        item.latch.countDown();
        return true;
    }

    // ── 线程 ────────────────────────────────────────────────────────────────

    private void startThreads() {
        acceptThread = new Thread(new Runnable() {
            @Override
            public void run() {
                acceptLoop();
            }
        }, "ds-lan-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();

        receiveThread = new Thread(new Runnable() {
            @Override
            public void run() {
                receiveLoop();
            }
        }, "ds-lan-recv");
        receiveThread.setDaemon(true);
        receiveThread.start();

        announceThread = new Thread(new Runnable() {
            @Override
            public void run() {
                announceLoop();
            }
        }, "ds-lan-announce");
        announceThread.setDaemon(true);
        announceThread.start();
    }

    private void acceptLoop() {
        while (running) {
            ServerSocket server = serverSocket;
            if (server == null) {
                return;
            }
            Socket socket;
            try {
                socket = server.accept();
            } catch (IOException e) {
                if (running) {
                    log("accept 异常：" + e);
                }
                return;
            }
            final Socket client = socket;
            Thread worker = new Thread(new Runnable() {
                @Override
                public void run() {
                    handleConnection(client);
                }
            }, "ds-lan-conn");
            worker.setDaemon(true);
            worker.start();
        }
    }

    /**
     * 处理一个入站连接：读完整请求 → 交给页面 → 等页面回复 → 写回 → 关连接。
     * 一个连接只承载一次请求/响应（够用且最简单；同步一来一回就是一次连接）。
     *
     * @param socket 已建立的连接，方法返回前一定关闭
     */
    private void handleConnection(Socket socket) {
        Pending item = new Pending(socket);
        String requestId = null;
        try {
            socket.setSoTimeout(READ_TIMEOUT_MS);
            String text = readFrame(new DataInputStream(new BufferedInputStream(
                    socket.getInputStream())), MAX_PAYLOAD);
            if (text == null || text.isEmpty()) {
                return;
            }
            requestId = new JSONObject(text).optString("id", "");
            if (requestId.isEmpty()) {
                log("请求缺 id，丢弃");
                return;
            }
            synchronized (lock) {
                pending.put(requestId, item);
                putInbox(requestId, text, null);
            }
            listener.onRequest(requestId);
            if (!item.latch.await(REPLY_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                log("等页面回复超时 id=" + requestId);
                return;
            }
            String response = item.response;
            if (response == null) {
                return;
            }
            byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
            OutputStream out = new BufferedOutputStream(socket.getOutputStream());
            writeFrame(out, bytes);
            out.flush();
            log("已回复 id=" + requestId + " bytes=" + bytes.length);
        } catch (SocketTimeoutException e) {
            log("读请求超时");
        } catch (Exception e) {
            log("连接处理失败：" + e);
        } finally {
            if (requestId != null) {
                synchronized (lock) {
                    pending.remove(requestId);
                }
                item.latch.countDown();
            }
            closeQuietly(socket);
        }
    }

    private void receiveLoop() {
        byte[] buffer = new byte[4096];
        while (running) {
            DatagramSocket udp = udpSocket;
            if (udp == null) {
                return;
            }
            DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
            try {
                udp.receive(packet);
            } catch (IOException e) {
                if (running) {
                    log("收广播异常：" + e);
                }
                return;
            }
            String text = new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8);
            handleAnnounce(text, packet.getAddress());
        }
    }

    /**
     * 处理一条对端广播。
     *
     * @param text 广播正文（JSON）
     * @param from 数据包来源地址（用它而不是 JSON 里的字段：JSON 里的 host 可伪造，来源不可）
     */
    private void handleAnnounce(String text, InetAddress from) {
        String peerId;
        String peerName;
        String peerTag;
        int peerPort;
        try {
            JSONObject json = new JSONObject(text);
            if (!"chat-demo-lan".equals(json.optString("format", ""))) {
                return;
            }
            if (json.optInt("proto", 0) != 1) {
                return;
            }
            peerId = json.optString("deviceId", "");
            peerName = json.optString("name", "");
            peerTag = json.optString("pairTag", "");
            peerPort = json.optInt("port", 0);
        } catch (Exception e) {
            return;
        }
        if (peerId.isEmpty() || peerId.equals(deviceId) || peerPort <= 0) {
            return;
        }
        boolean changed;
        synchronized (lock) {
            Peer peer = peers.get(peerId);
            changed = peer == null || !peer.host.equals(from.getHostAddress()) || peer.port != peerPort
                    || (peer.pairTag == null ? !peerTag.isEmpty() : !peer.pairTag.equals(peerTag));
            if (peer == null) {
                peer = new Peer();
                peer.deviceId = peerId;
                peers.put(peerId, peer);
            }
            peer.name = peerName;
            peer.host = from.getHostAddress();
            peer.port = peerPort;
            peer.pairTag = peerTag;
            peer.lastSeen = System.currentTimeMillis();
        }
        if (changed) {
            log("发现对端 " + peerId + " " + from.getHostAddress() + ":" + peerPort);
            listener.onPeers();
        }
    }

    private void announceLoop() {
        while (running) {
            if (foreground) {
                broadcastOnce();
                prunePeers();
            }
            try {
                Thread.sleep(ANNOUNCE_INTERVAL_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    /** 往每个网段的广播地址 + 255.255.255.255 各发一份，覆盖单网卡与多网卡（含热点）场景 */
    private void broadcastOnce() {
        DatagramSocket udp = udpSocket;
        if (udp == null) {
            return;
        }
        JSONObject json = new JSONObject();
        try {
            json.put("format", "chat-demo-lan");
            json.put("proto", 1);
            json.put("deviceId", deviceId);
            json.put("name", deviceName);
            json.put("port", tcpPort);
            json.put("pairTag", pairTag);
        } catch (Exception e) {
            return;
        }
        byte[] bytes = json.toString().getBytes(StandardCharsets.UTF_8);
        for (InetAddress target : broadcastTargets()) {
            try {
                udp.send(new DatagramPacket(bytes, bytes.length, target, DISCOVERY_PORT));
            } catch (IOException e) {
                // 某个网段发不出去不影响其它网段
                log("广播到 " + target + " 失败：" + e.getMessage());
            }
        }
    }

    /**
     * 算出要广播的地址列表：所有非回环网卡的广播地址，加一个 255.255.255.255。
     * 只用 255.255.255.255 在部分路由器/热点下会被网关丢掉，指定网段广播更可靠。
     *
     * @return 去重后的广播目标
     */
    private List<InetAddress> broadcastTargets() {
        List<InetAddress> targets = new ArrayList<InetAddress>();
        try {
            targets.add(InetAddress.getByName("255.255.255.255"));
        } catch (Exception ignored) {
            // 理论上不会失败
        }
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces != null && interfaces.hasMoreElements()) {
                NetworkInterface item = interfaces.nextElement();
                if (item.isLoopback() || !item.isUp()) {
                    continue;
                }
                for (InterfaceAddress address : item.getInterfaceAddresses()) {
                    InetAddress broadcast = address.getBroadcast();
                    if (broadcast != null && !targets.contains(broadcast)) {
                        targets.add(broadcast);
                    }
                }
            }
        } catch (Exception e) {
            log("枚举网卡失败：" + e);
        }
        return targets;
    }

    private void prunePeers() {
        boolean changed = false;
        long now = System.currentTimeMillis();
        synchronized (lock) {
            Iterator<Map.Entry<String, Peer>> iterator = peers.entrySet().iterator();
            while (iterator.hasNext()) {
                Map.Entry<String, Peer> entry = iterator.next();
                if (now - entry.getValue().lastSeen > PEER_TTL_MS) {
                    iterator.remove();
                    log("对端离线 " + entry.getKey());
                    changed = true;
                }
            }
        }
        if (changed) {
            listener.onPeers();
        }
    }

    // ── 杂项 ────────────────────────────────────────────────────────────────

    /** 本机信息：tcp 端口 + 局域网地址 + 口令指纹（口径与广播一致） */
    private String selfJson() {
        JSONObject json = new JSONObject();
        try {
            json.put("deviceId", deviceId);
            json.put("name", deviceName);
            json.put("port", tcpPort);
            json.put("pairTag", pairTag);
            json.put("host", localAddress());
            json.put("udpPort", DISCOVERY_PORT);
        } catch (Exception ignored) {
            return "{}";
        }
        return json.toString();
    }

    /**
     * 找一个可用的局域网 IPv4 地址（界面展示用；拿不到时返回 127.0.0.1）。
     *
     * @return 点分十进制的本地地址
     */
    public static String localAddress() {
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            List<String> fallback = new ArrayList<String>();
            while (interfaces != null && interfaces.hasMoreElements()) {
                NetworkInterface item = interfaces.nextElement();
                if (item.isLoopback() || !item.isUp()) {
                    continue;
                }
                Enumeration<InetAddress> addresses = item.getInetAddresses();
                while (addresses.hasMoreElements()) {
                    InetAddress address = addresses.nextElement();
                    if (!(address instanceof Inet4Address) || address.isLoopbackAddress()) {
                        continue;
                    }
                    if (address.isSiteLocalAddress()) {
                        return address.getHostAddress();
                    }
                    fallback.add(address.getHostAddress());
                }
            }
            if (!fallback.isEmpty()) {
                return fallback.get(0);
            }
        } catch (Exception ignored) {
            // 落到下面的兜底
        }
        return "127.0.0.1";
    }

    /** 前后台变化时同步组播锁：前台加锁（能收广播）、后台释放（省电） */
    private void updateLock() {
        if (running && foreground) {
            acquireLock();
        } else {
            releaseLock();
        }
    }

    private void acquireLock() {
        if (multicastLock != null && multicastLock.isHeld()) {
            return;
        }
        try {
            WifiManager manager = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
            if (manager == null) {
                log("没有 WifiManager，跳过组播锁");
                return;
            }
            multicastLock = manager.createMulticastLock("ds-lan");
            // 不引用计数：前后台切换由本类自己管，重复 acquire 不用配对 release
            multicastLock.setReferenceCounted(false);
            multicastLock.acquire();
            log("组播锁已获取");
        } catch (Exception e) {
            // 没有 CHANGE_WIFI_MULTICAST_STATE 权限时这里会抛；广播可能收不到，但不应崩
            log("组播锁获取失败：" + e);
        }
    }

    private void releaseLock() {
        try {
            if (multicastLock != null && multicastLock.isHeld()) {
                multicastLock.release();
                log("组播锁已释放");
            }
        } catch (Exception e) {
            log("组播锁释放失败：" + e);
        }
        multicastLock = null;
    }

    /**
     * 读一帧：4 字节大端长度 + 正文。
     *
     * @param in    带缓冲的输入流，本方法不负责关闭
     * @param limit 正文上限，超过即抛异常
     * @return UTF-8 文本；对端一个字节都没发就关闭时返回 null
     * @throws IOException 读失败、长度非法或正文被截断
     */
    private static String readFrame(DataInputStream in, int limit) throws IOException {
        int length;
        try {
            length = in.readInt();
        } catch (EOFException e) {
            // 对端什么都没发就关了：当作空请求，不当异常
            return null;
        }
        if (length <= 0 || length > limit) {
            throw new IOException("帧长度不合法：" + length);
        }
        byte[] body = new byte[length];
        in.readFully(body);
        return new String(body, StandardCharsets.UTF_8);
    }

    /**
     * 写一帧：4 字节大端长度 + 正文。调用方负责 flush。
     *
     * @param out   输出流
     * @param body  正文
     * @throws IOException 写失败
     */
    private static void writeFrame(OutputStream out, byte[] body) throws IOException {
        DataOutputStream data = new DataOutputStream(out);
        data.writeInt(body.length);
        data.write(body);
        data.flush();
    }

    private static void closeQuietly(Object target) {
        if (target == null) {
            return;
        }
        try {
            if (target instanceof Socket) {
                ((Socket) target).close();
            } else if (target instanceof ServerSocket) {
                ((ServerSocket) target).close();
            } else if (target instanceof DatagramSocket) {
                ((DatagramSocket) target).close();
            }
        } catch (Exception ignored) {
            // 关不掉也没有更好的处理
        }
    }

    private void log(String message) {
        listener.onLog(message);
    }

    /** 空实现的 Listener，便于测试与兜底 */
    public static Listener noop() {
        return new Listener() {
            @Override
            public void onLog(String message) {
                // 什么都不做
            }

            @Override
            public void onPeers() {
                // 什么都不做
            }

            @Override
            public void onRequest(String requestId) {
                // 什么都不做
            }

            @Override
            public void onResponse(String requestId) {
                // 什么都不做
            }
        };
    }
}
