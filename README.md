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
- Model selection (list from `GET /models`), named system prompts (Settings → System prompts), Simplified Chinese and English, light and dark themes, mobile layouts, location settings, and chat history import and export.

## Data and storage

Your API key, settings, and the system prompt library are stored in the browser's localStorage. Conversations and original attachments are stored in IndexedDB. Local data is isolated by browser profile and site origin. Sending messages and uploading attachments send the relevant content to the configured API service.

History import and export in Settings use ZIP archives. After confirmation and successful validation, importing replaces all local conversations and attachments. Exports include conversations and locally available original images, but exclude API keys, settings, and original non-image attachments. See the [history import/export documentation (Chinese)](src/services/chat/history/README.md) for the archive format and preservation details.

Settings → Data → Delete all chats clears all local conversations, original attachments, and unsent drafts after confirmation. It stops ongoing replies and returns to a new chat. Your API key and settings are preserved; files already uploaded to the API service are not deleted.

## Multi-device sync (M1)

The repo ships a zero-dependency sync service plus a client entry point for syncing chats and messages between devices on the same machine or LAN.

Start the service (Node.js 22+, built-in modules only):

```sh
node sync-server/server.mjs --port 7788
```

It listens on `127.0.0.1` by default and stores data in `sync-server/data/sync-data.json`. For other devices on the LAN, start it with `--host 0.0.0.0` and enter this machine's IP in the client. In the client, open Settings → Multi-device sync, fill in the server URL (for example `http://127.0.0.1:7788`) and device name, then "Test connection" → "Sync now".

Sync is record-granular (chat, message) last-write-wins: records unique to either side are kept, and when the same record changed on both sides the latest edit wins. Deletions travel as tombstones so deleted chats are not pulled back, and branch fields (`parentId`, `selectedChildId`, `rootMessageId`) are synced verbatim. Attachments sync file details only, not the file itself. See [sync-server/README.md](sync-server/README.md) for the API and conflict rules.

## Android APK

The repo can also be packaged as an installable APK: the same `dist/` output is embedded in the APK's assets and served to a WebView from a virtual `https://dsapp.local` origin (a real secure origin, so localStorage and IndexedDB work). No Gradle, no Maven — the chain is aapt2 → javac → d8 → jar → zipalign → apksigner, driven by `tools/build-apk.ps1` (Windows, PowerShell 7).

```powershell
.\tools\setup-toolchain.ps1                     # one-off: JDK 17 + build-tools 35.0.1 + android-35 into %USERPROFILE%\.devtools
pnpm --config.shell-emulator=true build       # frontend -> dist/
.\tools\build-apk.ps1                          # -> dist-apk\deepseek-chat.apk
.\tools\verify-apk.ps1                         # 33 assertions on the artifact
adb install -r dist-apk\deepseek-chat.apk
```

- The API key can be **baked in at build time** from a local secret file: put the key in `.secrets/api-key.txt` (single line, git-ignored) and the next `pnpm build` injects it into the main bundle — the APK and the static site then work right after installing/opening, with no setup. Without that file the build falls back to the original flow: enter the key in Settings, where it is stored in localStorage of the app origin. A key entered in Settings always wins over the built-in one, and `tools\verify-apk.ps1` checks the packaged key against the secret file (fingerprint only, never the key itself).
- Package name stays `ds.app` and the signing key is `android\debug.keystore` (git-ignored), so a new APK can be installed **over** an existing install. Lose that keystore and you must uninstall first, which wipes local chats.
- `versionName` comes from `package.json`; `versionCode` is `major*10000 + minor*100 + patch` (so 0.2.0 → 200). Bump `package.json` before shipping.
- `minSdk 26`, `targetSdk 34` (35 forces edge-to-edge on Android 15), only the `INTERNET` permission.
- `android/` holds the shell: `MainActivity.java` (assets serving, external links, file picker, SAF export, back key), `shell.js` (page-side patch: back key, blob downloads, and runtime polyfills for old WebViews; `serveAsset` inserts it as a classic `<script>` at the top of the entry HTML's `<head>`, so it runs before the deferred main bundle), `res/`, `AndroidManifest.xml`. Nothing in `src/` or `rspack.config.ts` is Android-specific: the shell works because the build uses `publicPath: 'auto'`.
- Old WebViews (measured on WebView 91) cannot parse syntax Mermaid's bundle needs (it ships `class` static blocks), so importing that chunk throws a SyntaxError. `src/services/markdown/mermaid.ts` therefore probes capabilities first: when unsupported the diagram falls back to a plain code block labelled "Diagrams are not supported in this environment" and the mermaid chunk is never requested; when supported nothing changes (still lazy-loaded).

## Development

| Command       | Description                  |
| ------------- | ---------------------------- |
| `pnpm dev`    | Start the development server |
| `pnpm build`  | Build into `dist/`           |
| `pnpm type`   | Run TypeScript type checks   |
| `pnpm lint`   | Lint with oxlint             |
| `pnpm format` | Format with oxfmt            |

[rspack.config.ts](rspack.config.ts) uses `https://api.deepseek.com` by default. Use `createConfig({ apiOrigin, devServer })` to customize the API origin and development server proxy.

Chat uses `deepseek-flash` by default and lets you pick another model in Settings. Reasoning effort is sent as `output_config.effort` (`low` / `high` / `max`, default `high`) and omitted when deep thinking is off. Requests go through Anthropic-compatible Messages / Files APIs. The request `system` field carries the prompt selected in Settings → System prompts (a built-in default is used when none is selected); switching it only affects later requests and never rewrites stored messages. Requests include extensions for search, link reading, titles, and `latest_reminder`, so the configured service must support the corresponding capabilities. Supported attachment formats are determined by server-side validation.

```text
src/
  app/                 Application layout, themes, and global styles
  components/          Chat, settings, Markdown, and other UI components
  i18n/                English and Chinese translations
  services/
    api/               API requests, SSE, and protocol types
    chat/              Conversations, message branches, storage, and history import/export
    markdown/          Markdown parsing, syntax highlighting, and diagrams
  utils/               Shared utilities
```

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
