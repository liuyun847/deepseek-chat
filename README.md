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
.\sync-server\start.ps1                      # start (hidden window, port 7788; -Port / SYNC_PORT to change)
.\sync-server\stop.ps1                       # stop by port, idempotent
node sync-server/server.mjs --port 7788      # or run it in the foreground to see the service log
```

Logs: `sync-server\logs\start.log` (start/stop results). The service itself prints to stdout only and starts.ps1 deliberately does not redirect it — see the note in `start.ps1` (redirecting makes the long-lived node hold the autostart stderr file, which turned the next logon run into a silent no-op).

It listens on `127.0.0.1` by default and stores data in `sync-server/data/sync-data.json`. For other devices on the LAN, start it with `--host 0.0.0.0` and enter this machine's IP in the client. In the client, open Settings → Multi-device sync, fill in the server URL (for example `http://127.0.0.1:7788`) and device name, then "Test connection" → "Sync now".

On the page served by `local-server` (next section) the URL can be **left empty**: sync then uses the same-origin `/sync/api/*`, which that service forwards to `127.0.0.1:7788`, so the browser shows phone-synced chats with zero configuration. A typed URL always wins.

No restart is needed when the data file changes underneath: the service stats the file on every `/api/health`, `/api/state` and `POST /api/sync` and re-reads it (merging by last-write-wins) when someone else wrote it — so chats that arrive over P2P show up in the browser immediately, without bouncing `sync-server`.

Autostart: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\deepseek-chat-sync.vbs` runs `sync-server\start.ps1` once per logon through a windowless Windows PowerShell 5.1 — same pattern as the web service below (rename it to `.vbs.disabled` to turn it off; its own stderr goes to `sync-server\logs\autostart.err.log`). It listens on `127.0.0.1:7788` only: phones reach this PC over P2P (`lan-peer`), not through that port.

Sync is record-granular last-write-wins: records unique to either side are kept, and when the same record changed on both sides the latest edit wins. Deletions travel as tombstones so deleted chats are not pulled back, and branch fields (`parentId`, `selectedChildId`, `rootMessageId`) are synced verbatim. Attachments sync file details only, not the file itself.

Five record kinds are synced: `session`, `message`, `settings` (the whole device-agnostic settings object as one record — the newest copy wins), `prompt` (one record per system prompt, deletions as tombstones) and `prompt-selection` (which prompt is active, one record; a remote selection pointing at a prompt this device does not have falls back to the default until it arrives). Your **API key, device id, device name and the phone-to-phone passphrase are never synced** — they stay on each device, and incoming settings can never overwrite them. Protocol version is **2**; a v1 client refuses to sync against a v2 server, and a v2 client gets a 400 from a v1 server (upgrade both sides together). Old data files containing only sessions and messages load unchanged. See [sync-server/README.md](sync-server/README.md) for the API and conflict rules.

## Phone-to-phone (LAN P2P, no server)

Settings → Phone-to-phone: put two phones on the same Wi-Fi and type the **same passphrase** (at least 8 characters) on both. From then on they discover each other and sync automatically — no server, no IP addresses to fill in.

- Discovery: the native layer in the APK (`LanLink.java`) broadcasts over UDP (port 47823) every few seconds — device id, name, TCP port, passphrase fingerprint — and listens for the same from others. Since Android 9, receiving broadcasts requires holding a `WifiManager.MulticastLock` (permission `CHANGE_WIFI_MULTICAST_STATE`); the lock is held while the page is visible and released the moment the app goes to the background, which also stops broadcasting.
- Transport: each device binds its `ServerSocket` to a random port and does one request/response per TCP connection, framed as a 4-byte big-endian length followed by the body. The body is an encrypted envelope whose only plaintext is device id, request id, timestamp and a random iv.
- Encryption: the passphrase is stretched with PBKDF2-HMAC-SHA256 (120k rounds, fixed salt) into a 256-bit key; messages are gzipped and sealed with AES-GCM, with the envelope's from/id/ts bound in as AAD. The passphrase itself is never stored — only the derived key. The broadcast "fingerprint" is the first 6 bytes of SHA-256(key): matching fingerprints mean paired. A device with a different passphrase cannot decrypt and therefore never syncs.
- Merge: the same LWW and tombstone rules as the HTTP channel (`src/services/sync/merge.ts`); only the "authoritative full state" is replaced by "whatever the peer is missing". If both sides share the same data stamp (`stampOf`), no records are sent at all — just one hello.
- Scheduling: the device with the lexicographically smaller `deviceId` initiates; the other sends a ping when it has something to pull. Local edits trigger a debounced (4 s) push, plus a 45 s version check. Attachments sync file details only, exactly like the HTTP channel.

Layering (the transport never sees plaintext):

```text
LanLink.java            UDP discovery + TCP framing (bytes only, no app data)
  ↕ addJavascriptInterface
shell.js  window.__dsLan   callback queue + Promise plumbing (bulk data is pulled back by the page)
  ↕
lan/bridge.ts          typed wrapper around the native bridge
lan/crypto.ts          PBKDF2 / AES-GCM / fingerprint / gzip, base64
lan/protocol.ts        envelope and message shapes, time window, data stamp
lan/transfer.ts        peer-to-peer diff merge (reuses merge.ts decisions)
lan/exchange.ts        IndexedDB glue (load all, apply, rewrite snapshots)
lan/engine.ts          orchestration: peer table, auto sync, throttling, self test
```

With only one phone, Settings → Phone-to-phone → "Self test" sends a ping and a hello to its own TCP port: native accept → page decrypt → encrypted reply, reporting the RTT and whether both data stamps agree. A two-process protocol simulation and a "host process acts as the second phone" interop script live in [tools/lan-sim/README.md](tools/lan-sim/README.md).

Limits (stated up front): this only works inside one subnet — guest Wi-Fi and AP isolation block broadcasts. For cross-subnet or relayed setups keep using the HTTP sync above.

### The PC as a peer

`lan-peer/` makes the desktop a first-class peer of that same protocol, so a phone can sync straight to the PC with no HTTP server in between. Wire format, message types, `PROTO` version and merge rules are untouched — the phone app needs **zero changes**.

```powershell
# one-time: the passphrase must be identical on both sides (>= 8 chars).
# start.ps1 reads it from <repo>\.secrets\lan-passphrase.txt (single line, gitignored),
# or from -Passphrase, or from $env:LAN_PASSPHRASE - never from node's command line.
notepad .secrets\lan-passphrase.txt

.\lan-peer\start.ps1        # compiles the shared TS modules on first run, starts hidden, self-checks TCP port + broadcast
.\lan-peer\stop.ps1         # stop; idempotent
node lan-peer\peer.mjs --passphrase <same one>   # or run it in the foreground to watch the log
```

Then on the phone: Settings → Phone-to-phone → type the **same passphrase** → save & pair. The PC shows up under “Discovered devices” within ~4 seconds and sync starts on its own (the phone always initiates, because `dev-…` sorts before the PC's `pc-…` id; the PC sends a ping when it has something new to pull).

- Data lives in one JSON file: `sync-server/data/sync-data.json` — the exact file `sync-server/server.mjs` uses (`{format:'chat-demo-sync',version:2,records:{…}}`). Rows that arrived over P2P are therefore visible to the web client as soon as it syncs against 7788, and vice versa. Merging is still LWW + tombstones, so nothing gets resurrected.
- Writes are “read latest → merge → atomic rename”. If 7788 happens to run at the same time it rewrites the whole file from its own in-memory view, so P2P-only rows can vanish for a while; the peer re-merges them back from its own overlay on the 45 s tick (tombstones still win). Running only one of the two at a time is the clean setup.
- Multi-NIC: the peer broadcasts on every non-loopback IPv4 interface plus 255.255.255.255. Pass `--iface 192.168.1.10` (an interface address, or that subnet's broadcast address) to pin it to one NIC, e.g. when a VirtualBox host-only adapter is in the way.
- Same-subnet only: guest Wi-Fi and AP isolation drop broadcasts, so the phone will not discover the PC there.
- Firewall: allow inbound **UDP 47823** (discovery) and inbound **TCP on the port the peer picked** (random by default; printed at startup and stored in `lan-peer/logs/state.json`, pin it with `--port 47824` if you prefer a fixed rule). Windows' first-run prompt only covers the TCP listener — add the UDP rule by hand:

```powershell
New-NetFirewallRule -DisplayName 'chat-demo LAN P2P' -Direction Inbound -Protocol UDP -LocalPort 47823 -Action Allow
New-NetFirewallRule -DisplayName 'chat-demo LAN P2P TCP' -Direction Inbound -Protocol TCP -LocalPort 47824 -Action Allow
```

Logs: `lan-peer\logs\peer.log` (service), `start.log` (start/stop results), `state.json` (live ports/records/peers — also what `start.ps1` self-checks). The passphrase never appears in any log; only “configured” and the public `pairTag` do. Autostart: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\deepseek-chat-lan-peer.vbs` — rename it to `.vbs.disabled` to disable, same pattern as the web service.

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
- Sync route: `/sync/api/{health,state,sync}` → `http://127.0.0.1:7788/api/{health,state,sync}`, method/body/headers passed through. It forwards the page's sync token header but never injects a credential, and `SYNC_UPSTREAM` may only point at a loopback address. If the sync service is down the route answers **502** with a Chinese reason (`{"error":{"type":"sync_upstream_down",…}}`) and the settings page shows "同步服务未启动" instead of a bare fetch error. The proxy deliberately reads nothing from `sync-server/data/sync-data.json`: that JSON already has two writers, and a third one would silently drop other writers' records.
- Autostart: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\deepseek-chat-web.vbs` runs `local-server\start.ps1` through a windowless Windows PowerShell 5.1 (same pattern as `dsh-desktop-autostart.vbs`: two log files, rename to disable). To turn it off, rename the file to `.vbs.disabled`. Logs live in `local-server\logs\`: `start.log` (start/stop results) and `server.log` (service log, rotated at 2 MB).
- Serving a default (`build`, key-baked) artifact shows a dismissible yellow banner at the top of the page: "This page carries a built-in API Key — use it on your own machine only", because that artifact hands the key to anyone who can open the page. `build:web` artifacts show no banner.
- ⚠ The `dist/` produced by `build:web` has **no key** in it. Rebuild with the default `pnpm --config.shell-emulator=true build` before packaging an APK — step 0 of `tools\build-apk.ps1` blocks a keyless artifact and prints exactly that command (you never get a silently keyless APK).

## Android APK

The repo can also be packaged as an installable APK: the same `dist/` output is embedded in the APK's assets and served to a WebView from a virtual `https://dsapp.local` origin (a real secure origin, so localStorage and IndexedDB work). No Gradle, no Maven — the chain is aapt2 → javac → d8 → jar → zipalign → apksigner, driven by `tools/build-apk.ps1` (Windows, PowerShell 7).

```powershell
.\tools\setup-toolchain.ps1                     # one-off: JDK 17 + build-tools 35.0.1 + android-35 into %USERPROFILE%\.devtools
pnpm --config.shell-emulator=true build       # frontend -> dist/
.\tools\build-apk.ps1                          # -> dist-apk\deepseek-chat.apk
.\tools\verify-apk.ps1                         # 34 assertions on the artifact
adb install -r dist-apk\deepseek-chat.apk
```

- The API key can be **baked in at build time** from a local secret file: put the key in `.secrets/api-key.txt` (single line, git-ignored) and the next `pnpm build` injects it into the main bundle — the APK and the static site then work right after installing/opening, with no setup. Without that file the build falls back to the original flow: enter the key in Settings, where it is stored in localStorage of the app origin. A key entered in Settings always wins over the built-in one, and `tools\verify-apk.ps1` checks the packaged key against the secret file (fingerprint only, never the key itself). **`build:web`, used by the local web service, deliberately injects no key** (see the section above) — package APKs from the default `pnpm build`.
- Package name stays `ds.app` and the signing key is `android\debug.keystore` (git-ignored), so a new APK can be installed **over** an existing install. Lose that keystore and you must uninstall first, which wipes local chats.
- `versionName` comes from `package.json`; `versionCode` is `major*10000 + minor*100 + patch` (so 0.3.0 → 300). Bump `package.json` before shipping.
- `minSdk 26`, `targetSdk 34` (35 forces edge-to-edge on Android 15), only two permissions: `INTERNET` and `CHANGE_WIFI_MULTICAST_STATE` (the multicast lock used by phone-to-phone discovery; normal level, granted at install).
- `android/` holds the shell: `MainActivity.java` (assets serving, external links, file picker, SAF export, back key), `LanLink.java` (LAN discovery over UDP broadcast + TCP request/response), `shell.js` (page-side patch: back key, blob downloads, and runtime polyfills for old WebViews; `serveAsset` inserts it as a classic `<script>` at the top of the entry HTML's `<head>`, so it runs before the deferred main bundle), `res/`, `AndroidManifest.xml`. Nothing in `src/` or `rspack.config.ts` is Android-specific: the shell works because the build uses `publicPath: 'auto'`.
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
    sync/              Multi-device sync (HTTP channel + phone-to-phone LAN P2P);
                       settings / prompts / prompt-selection live in sync/local.ts
  utils/               Shared utilities
```

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
