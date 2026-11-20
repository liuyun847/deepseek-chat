# chat-demo

English | [简体中文](README.zh-CN.md)

A static chat demo powered by the DeepSeek API. No application backend is required: the browser connects directly to the configured API service.

You can [try the app online](https://deepseek-ai.github.io/chat-demo/) or download the archive from [Releases](https://github.com/deepseek-ai/deepseek-chat-demo/releases), extract it, and double-click `index.html` to use it locally without installation or a build. Enter your API key in Settings before your first chat.

## Getting started

Install Node.js 22.12+ and pnpm, then run:

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

Open http://localhost:8090.

To build the static site:

```sh
pnpm build
```

The output is written to `dist/`. Deploy it to a static web server or open `dist/index.html` directly. Opening the file directly requires browser support for storage on `file://` pages and an API service that permits their cross-origin requests.

## Features

- Multiple conversations with automatic titles, renaming, and deletion; edit prompts, regenerate replies, and switch between message branches.
- Streaming replies, deep thinking with selectable reasoning effort (low / high / max), smart search, link reading, and source citations; stop generation or continue eligible replies.
- Upload, paste, or drag and drop attachments.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- Model and reasoning-effort pickers on the chat input bar (the same values as Settings → General, always in sync), model list from `GET /models`, named system prompts (Settings → System prompts) with search by name or content, Simplified Chinese and English, light and dark themes, mobile layouts, location settings, and chat history import and export.

## Data and storage

Your API key, settings, and the system prompt library are stored in the browser's localStorage. Conversations and original attachments are stored in IndexedDB. Local data is isolated by browser profile and site origin. Sending messages and uploading attachments send the relevant content to the configured API service.

History import and export in Settings use ZIP archives. After confirmation and successful validation, importing replaces all local conversations and attachments. Exports include conversations and locally available original images, but exclude API keys, settings, and original non-image attachments. See the [history import/export documentation (Chinese)](src/services/chat/history/README.md) for the archive format and preservation details.

Settings → Data → Delete all chats clears all local conversations, original attachments, and unsent drafts after confirmation. It stops ongoing replies and returns to a new chat. Your API key and settings are preserved; files already uploaded to the API service are not deleted.

## Multi-device sync (M1)

The repo ships a zero-dependency sync service plus a client entry point for syncing chats and messages between devices on the same machine or LAN.

Start the service (Node.js 22+, built-in modules only). On Windows the scripts below do it for you — idempotent, they exit 0 only after `GET /api/health` reports `format=chat-demo-sync`:

```powershell
node sync-server\gen-cert.mjs                # first run: self-signed TLS cert in sync-server\tls\
.\sync-server\start.ps1                      # start HTTPS (hidden window, port 7788; -Port / SYNC_PORT to change)
.\sync-server\stop.ps1                       # stop by port, idempotent
node sync-server/server.mjs --tls-cert sync-server\tls\cert.pem --tls-key sync-server\tls\key.pem
```

Logs: `sync-server\logs\start.log` (start/stop results). The service itself prints to stdout only and starts.ps1 deliberately does not redirect it — see the note in `start.ps1` (redirecting makes the long-lived node hold the autostart stderr file, which turned the next logon run into a silent no-op).

It listens on `127.0.0.1` by default and stores data in `sync-server/data/sync-data.json`. For other devices on the LAN, start it with `--host 0.0.0.0`, keep TLS, add `--token`, and enter this machine's HTTPS address in the client. In the client, open Settings → Multi-device sync, fill in the server URL (for example `https://192.168.1.5:7788`) and device name, then "Test connection" → "Sync now". Non-loopback plain `http://` addresses are rejected by the client.

The local web service trusts the self-signed cert through `SYNC_CA_FILE` (it auto-detects `sync-server/tls/cert.pem` in `start.ps1`); the browser only talks to the loopback origin, so it never sees the self-signed certificate. On the page served by `local-server` (next section) the URL can be **left empty**: sync then uses the same-origin `/sync/api/*`, which that service forwards to `https://127.0.0.1:7788`, so the browser shows phone-synced chats with zero configuration. A typed URL always wins.

**Self-signed HTTPS needs one manual step on the phone: pinning the certificate fingerprint.** The Android shell rejects a self-signed certificate unless the server's SHA-256 fingerprint is pinned on the device — `onReceivedSslError` cancels everything else, and there is no trust-on-first-use. The server prints that fingerprint at startup, and the same 64-character lowercase hex value is available from `node sync-server/gen-cert.mjs`, from `certFingerprint` in `GET /api/health` and `GET /`, and in the create-group / invite responses (the machine running the browser shows it with a **Copy** button). Paste it into Settings → Multi-device sync → "Server certificate fingerprint" → **Save fingerprint**: colons, spaces and upper case are normalized, and the page hands it to the native side through `window.__dsSync.setTlsPin()` → `Bridge.setSyncTlsPin`, which stores it in SharedPreferences so it survives a process restart. Until it is pinned the settings page shows a red hint and test/sync/group actions fail with an explicit message instead of a bare "cannot reach the server". Rotating the certificate (`gen-cert.mjs --force`) changes the fingerprint, so every phone must pin it again. Browsers have no such bridge: there the local service (CA file) or the browser trust store does the checking. To verify the three cases without a phone, run `node tools/tls-pin-sim.mjs --url https://<host>:7788 [--pin <fingerprint>]` (exit code 0 accepted / 2 no pin / 3 mismatch).

**QR pairing.** After creating the group (or pressing "Create pairing code") the group panel grows a "Pair by QR code" card: an inline SVG (not a modal — the phone has to look at the screen), black modules on white, with a 10-minute countdown. The code carries a self-describing string built by the server, `deepseek-sync://pair?v=1&h=<host:port>&c=<code>&f=<cert fingerprint>&x=<expiry seconds>`, so **one scan hands the phone all three things** — server address, pairing code and certificate fingerprint — with no manual copying. Three rules matter:

- It is a **complete join credential** (equivalent to a password), valid for 10 minutes and single use. Do not screenshot it around and never feed it to an online QR generator. When `x` passes, the page **removes the SVG** (replaced by "expired, regenerate") so nobody is lured into scanning a dead code.
- Only the server can supply the address inside the code: the page always lives on loopback (`127.0.0.1`), so an address derived from `location.origin` would point the phone at itself. The server returns `pair.uri` in the create-group / invite responses; the page only renders the matrix.
- **With the default deployment the card cannot be drawn**: `start.ps1` passes no `--host`, so the service listens on loopback only and the card shows a command you can actually run instead. To let a phone connect, restart it in LAN mode: `node sync-server/server.mjs --host 0.0.0.0 --token <passphrase>` — a non-loopback listen without a passphrase is **refused at startup**, not just warned about; behind a reverse proxy, port mapping or domain add `--public-host 192.168.1.5:7788` to say where the phone should connect. The card never shows an address the phone cannot reach (`pair.reachable === false`), and when the server has **no TLS certificate** at all (`pair.reason` is `no-tls`) it draws no code and tells you to generate the certificate first — the phone rejects plaintext non-loopback addresses outright, so such a code would only waste a scan. The one-step equivalent on Windows is `.\sync-server\start.ps1 -Lan` (off by default; the passphrase comes from `-Token`, else `SYNC_TOKEN`, else `.secrets\sync-token.txt`, and the script refuses to start when all three are missing) — the log then says "已对局域网开放" (opened to the LAN).

The pairing-string parser exists once, in TypeScript (`src/services/sync/pairing.ts`, testable outside the browser); the scan-and-fill flow reuses it. Self-checks: `node tools/pair-qr-sim.mjs` (L1 parsing + L2 matrix golden vectors + L4 server-side address choice + an old-WebView regression, exit code 0 = pass) and `node tools/pair-qr-sim.mjs --parse "<string>"` (prints address / code / fingerprint / expiry).

**On the phone side (scan / pick an image / paste)**: Settings → Sync → the "Pair by QR code" card. All three entries feed the same parser, then a confirmation card shows server address, pairing code, certificate fingerprint and expiry; nothing is submitted until you tap "Pair and join":

1. **Scan QR code** (APK only): opens the native `ScanActivity` (Camera2 preview + ZXing decoding). A denied camera permission or a device without a camera falls through to the next two paths without crashing.
2. **Pick an image**: from the scanner, choose a QR photo through the system file picker (`BitmapFactory` → the same decoder class). This is the fallback for glare or screen protectors, and the only entry that can exercise the whole chain without a real phone.
3. **Paste the pairing string**: paste the `deepseek-sync://…` produced by "Copy pairing string" and tap "Parse". The web build (browser) only has this one.

Order matters: the certificate fingerprint is written **before** `joinGroup`. The WebView rejects self-signed certificates during the TLS handshake, so writing the pin later shows up as "the first attempt always fails, the second one works". Failure messages differ per parser `reason` (too long / not this app's code / unknown version / bad address / plaintext non-loopback / bad characters in the code / fingerprint not 64 hex digits / expired) instead of one vague "pairing failed".

The decoding half is testable without a phone: `.\tools\qr-decode-check.ps1` compiles **the same `QrDecode.java` that ships in the APK** on the desktop JVM and runs it over the four fixed samples in `tools\qr-samples\` — **both paths** (`RGBLuminanceSource` for images, the padded Y plane with `rowStride` for camera frames) — comparing the decoded text byte for byte and then re-parsing it. The samples come from `node tools/qr-samples/generate.mjs`, which uses the page's own encoder (including a real pairing string and one counter-example).

No restart is needed when the data file changes underneath: the service stats the file on every `/api/health`, `/api/state` and `POST /api/sync` and re-reads it (merging by last-write-wins) when someone else wrote it — so chats written by hand or by another instance show up in the browser immediately, without bouncing `sync-server`.

Autostart: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\deepseek-chat-sync.vbs` runs `sync-server\start.ps1` once per logon through a windowless Windows PowerShell 5.1 — same pattern as the web service below (rename it to `.vbs.disabled` to turn it off; its own stderr goes to `sync-server\logs\autostart.err.log`). At autostart it listens on `127.0.0.1:7788` only: phones cannot reach it. It opens up to the LAN **only** when you restart it explicitly with `--host 0.0.0.0 --token <passphrase>`; then a phone connects straight to that HTTPS port (see QR pairing above).

Sync is record-granular last-write-wins: records unique to either side are kept, and when the same record changed on both sides the latest edit wins. Deletions travel as tombstones so deleted chats are not pulled back, and branch fields (`parentId`, `selectedChildId`, `rootMessageId`) are synced verbatim. Attachments sync file details only, not the file itself.

Five record kinds are synced: `session`, `message`, `settings` (the whole device-agnostic settings object as one record — the newest copy wins), `prompt` (one record per system prompt, deletions as tombstones) and `prompt-selection` (which prompt is active, one record; a remote selection pointing at a prompt this device does not have falls back to the default until it arrives). Your **API key, device id and device name are never synced** — they stay on each device, and incoming settings can never overwrite them. Protocol version is **2**; a v1 client refuses to sync against a v2 server, and a v2 client gets a 400 from a v1 server (upgrade both sides together). Old data files containing only sessions and messages load unchanged. See [sync-server/README.md](sync-server/README.md) for the API and conflict rules.

## Local web service (browser access + autostart)

`local-server/` is a zero-dependency Node service (built-in modules only) that serves `dist/` to the browser, reverse-proxies `/anthropic/*` and `/models` to `https://api.deepseek.com`, and reverse-proxies `/sync/api/*` to the sync service (`127.0.0.1:7788` by default, override with `SYNC_UPSTREAM`). **The API key lives only on the server** — not a single byte of it ends up in the browser bundle.

```powershell
pnpm --config.shell-emulator=true build:web   # frontend build WITHOUT the baked key -> dist/
.\local-server\start.ps1                      # start; exits 0 only after /api/health passes
.\local-server\stop.ps1                       # stop by port, idempotent
```

Open <http://127.0.0.1:7789/> (change the port with the `PORT` environment variable).

- Port 7789, loopback only. A non-loopback `HOST` (say `0.0.0.0`) is refused at startup: this service lends the server-side key to the page, so exposing it to the LAN means handing that key to every device on the network — that needs a passphrase/auth mechanism first, which is out of scope for now.
- Key source: `DS_API_KEY` wins, then `.secrets\api-key.txt` (single line, git-ignored). With neither, the service still starts, static pages work, and proxy routes answer 503 with instructions; `GET /api/health` only reports `keyConfigured: true/false` and never echoes the key.
- Why the key is not in the frontend: `dist/` is plain static content, so whoever fetches the JS gets the key. The web build therefore stops sending credentials: `src/services/localService.ts` probes `GET /api/health` on startup, and on a hit switches to relative `/anthropic/...` paths while the server injects `x-api-key`. In the APK (`https://dsapp.local`) and under `file://` the probe is false, so behaviour is unchanged — no second build flavor needed.
- Cross-site protection: proxy routes check `Origin` (present and different from this service → 403, which stops any web page from spending your key through `127.0.0.1`) and `Host` (loopback only, which blocks DNS rebinding); request bodies are capped at 20 MB (413 beyond that, 32 MB for the sync route).
- Sync route: `/sync/api/{health,state,sync}` → `http://127.0.0.1:7788/api/{health,state,sync}`, method/body/headers passed through. It forwards the page's own token header, and when a request carries none it injects `Bearer <passphrase>` read from `.secrets/sync-token.txt` (fallback `SYNC_TOKEN`) — in LAN mode every `/api/*` on 7788 requires the passphrase, so the browser never has to be told it; a caller that does send a token (the device token after joining) is never overridden, and `SYNC_UPSTREAM` may only point at a loopback address. If the sync service is down the route answers **502** with a Chinese reason (`{"error":{"type":"sync_upstream_down",…}}`) and the settings page shows "同步服务未启动" instead of a bare fetch error. The proxy deliberately reads nothing from `sync-server/data/sync-data.json`: that JSON already has two writers, and a third one would silently drop other writers' records.
- Autostart: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\deepseek-chat-web.vbs` runs `local-server\start.ps1` through a windowless Windows PowerShell 5.1 (same pattern as `dsh-desktop-autostart.vbs`: two log files, rename to disable). To turn it off, rename the file to `.vbs.disabled`. Logs live in `local-server\logs\`: `start.log` (start/stop results) and `server.log` (service log, rotated at 2 MB).
- Serving a default (`build`, key-baked) artifact shows a dismissible yellow banner at the top of the page: "This page carries a built-in API Key — use it on your own machine only", because that artifact hands the key to anyone who can open the page. `build:web` artifacts show no banner.
- ⚠ The `dist/` produced by `build:web` has **no key** in it. Rebuild with the default `pnpm --config.shell-emulator=true build` before packaging an APK — step 0 of `tools\build-apk.ps1` blocks a keyless artifact and prints exactly that command (you never get a silently keyless APK).

## Android APK

The repo can also be packaged as an installable APK: the same `dist/` output is embedded in the APK's assets and served to a WebView from a virtual `https://dsapp.local` origin (a real secure origin, so localStorage and IndexedDB work). No Gradle, no Maven — the chain is aapt2 → javac → d8 → jar → zipalign → apksigner, driven by `tools/build-apk.ps1` (Windows, PowerShell 7).

```powershell
.\tools\setup-toolchain.ps1                     # one-off: JDK 17 + build-tools 35.0.1 + android-35 into %USERPROFILE%\.devtools
pnpm --config.shell-emulator=true build       # frontend -> dist/
.\tools\build-apk.ps1                          # -> dist-apk\deepseek-chat.apk
.\tools\verify-apk.ps1                         # assertions on the artifact
adb install -r dist-apk\deepseek-chat.apk
```

- The API key can be **baked in at build time** from a local secret file: put the key in `.secrets/api-key.txt` (single line, git-ignored) and the next `pnpm build` injects it into the main bundle — the APK and the static site then work right after installing/opening, with no setup. Without that file the build falls back to the original flow: enter the key in Settings, where it is stored in localStorage of the app origin. A key entered in Settings always wins over the built-in one, and `tools\verify-apk.ps1` checks the packaged key against the secret file (fingerprint only, never the key itself). **`build:web`, used by the local web service, deliberately injects no key** (see the section above) — package APKs from the default `pnpm build`.
- Package name stays `ds.app` and the signing key is `android\debug.keystore` (git-ignored), so a new APK can be installed **over** an existing install. Lose that keystore and you must uninstall first, which wipes local chats.
- `versionName` comes from `package.json`; `versionCode` is `major*10000 + minor*100 + patch` (so 0.3.0 → 300). Bump `package.json` before shipping.
- `minSdk 26`, `targetSdk 34` (35 forces edge-to-edge on Android 15), **exactly two** permissions: `INTERNET` and `CAMERA` (QR pairing; dangerous level, so the system dialog appears the first time you tap "Scan QR code"). A camera is not required to install: the manifest declares `uses-feature android.hardware.camera required="false"`, so camera-less devices install fine and the scanner drops straight to "Pick an image"; denying the permission does not crash either — same fallback. `tools\verify-apk.ps1` asserts "exactly 2", "CAMERA declared" and "camera not required".
- **One third-party binary**: `android\libs\zxing-core-3.5.3.jar` (Apache-2.0, used only to turn camera frames / images into QR strings — see [android/libs/README.md](android/libs/README.md)). This is the **single exception** to "no third-party libraries (AndroidX included)": it is a plain jar (no AAR, no resources, no transitive dependencies), so it only has to be added to `javac -classpath` and to the `d8` inputs in `tools\build-apk.ps1` — the zero-Gradle chain stays intact. It costs `classes.dex` 42 KB → ~590 KB (APK-internal compressed +274 KB) and the APK 1.87 → 2.15 MB; phase 2's M4 (`ScanActivity` + `QrDecode`) adds another ~22 KB of dex on top. The full licence ships as `android\libs\LICENSE-APACHE-2.0.txt` (Apache-2.0 §4 requires it when distributing) — keep it with any redistributed APK.
- `android/` holds the shell: `MainActivity.java` (assets serving, external links, file picker, SAF export, back key), `shell.js` (page-side patch: back key, blob downloads, and runtime polyfills for old WebViews; `serveAsset` inserts it as a classic `<script>` at the top of the entry HTML's `<head>`, so it runs before the deferred main bundle), `res/`, `AndroidManifest.xml`. Nothing in `src/` or `rspack.config.ts` is Android-specific: the shell works because the build uses `publicPath: 'auto'`.
- Old WebViews (measured on WebView 91) cannot parse syntax Mermaid's bundle needs (it ships `class` static blocks), so importing that chunk throws a SyntaxError. `src/services/markdown/mermaid.ts` therefore probes capabilities first: when unsupported the diagram falls back to a plain code block labelled "Diagrams are not supported in this environment" and the mermaid chunk is never requested; when supported nothing changes (still lazy-loaded).

## Development

| Command       | Description                  |
| ------------- | ---------------------------- |
| `pnpm dev`    | Start the development server |
| `pnpm build`  | Build into `dist/`           |
| `pnpm build:web` | Build into `dist/` without the baked key (local web service) |
| `pnpm type`   | Run TypeScript type checks   |
| `pnpm lint`   | Lint with oxlint             |
| `pnpm format` | Format with oxfmt            |

[rspack.config.ts](rspack.config.ts) uses `https://api.deepseek.com` by default. Use `createConfig({ apiOrigin, devServer })` to customize the API origin and development server proxy.

Chat uses `deepseek-flash` by default and lets you pick another model either on the chat input bar or in Settings → General (both edit the same setting). Reasoning effort is sent as `output_config.effort` (`low` / `high` / `max`, default `high`) and omitted when deep thinking is off. Requests go through Anthropic-compatible Messages / Files APIs. The request `system` field carries the prompt selected in Settings → System prompts (a built-in default is used when none is selected); switching it only affects later requests and never rewrites stored messages. Requests include extensions for search, link reading, titles, and `latest_reminder`, so the configured service must support the corresponding capabilities. Supported attachment formats are determined by server-side validation.

```text
src/
  app/                 Application layout, themes, and global styles
  components/          Chat, settings, Markdown, and other UI components
  i18n/                English and Chinese translations
  services/
    api/               API requests, SSE, and protocol types
    chat/              Conversations, message branches, storage, and history import/export
    markdown/          Markdown parsing, syntax highlighting, and diagrams
    sync/              Multi-device sync (HTTPS channel);
                       settings / prompts / prompt-selection live in sync/local.ts
  utils/               Shared utilities
```

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
