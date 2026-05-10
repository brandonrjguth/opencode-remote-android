# OpenCode Remote

OpenCode Remote is a companion app that lets you control your OpenCode server from phone or desktop, even when you are not at your main workstation.
It is designed to make daily usage simple: connect to your server, check active sessions, see progress, send new prompts or slash commands, and stop a running action when needed.

## Screenshots

| Screenshot 1 | Screenshot 2 |
|---|---|
| ![](docs/screenshots/1000046910.jpg) | ![](docs/screenshots/1000046911.jpg) |

## What It Can Do

- configure and test connection to your OpenCode server
- browse and monitor sessions (`idle`, `busy`, `retry`)
- open a session and read messages, todo items, and progress
- send prompts (and `/commands`) directly from the chat input
- stop running work when necessary
- play completion feedback sound when a running session finishes

## Technology Stack

- frontend: React + TypeScript + Vite
- mobile packaging: Capacitor (Android APK)
- networking: OpenCode HTTP API (`/global/health`, `/session/*`, `/command`)
- CI/CD: GitHub Actions for cloud APK builds

## Server Setup

The app now expects a small wrapper server from this repo in front of the OpenCode server.

### Quick Linux setup

If this machine uses `systemd`, you can run the one-shot installer from the repo root:

```bash
npm run setup:linux
```

It will:

- prompt for the shared username and password
- configure OpenCode on `127.0.0.1:4096`
- configure the wrapper on `0.0.0.0:4097`
- save the managed root directory in `server-config.json`
- install and start `systemd --user` services for both servers

The app still lets the user enter host, port, username, and password manually. The built-in default port remains `4097`.

Architecture:

- `opencode-ai serve` runs privately on `127.0.0.1:4096`
- this repo's wrapper server runs on your LAN-facing port, by default `4097`
- the wrapper owns the managed root directory, creates subfolders for new sessions, and forwards requests to OpenCode

### 1. Start OpenCode upstream locally

macOS / Linux (bash/zsh):

```bash
OPENCODE_SERVER_USERNAME=opencode OPENCODE_SERVER_PASSWORD=your-password npx -y opencode-ai serve --hostname 127.0.0.1 --port 4096
```

Windows PowerShell:

```powershell
$env:OPENCODE_SERVER_USERNAME="opencode"
$env:OPENCODE_SERVER_PASSWORD="your-password"
npx -y opencode-ai serve --hostname 127.0.0.1 --port 4096
```

### 2. Configure the managed root directory

From this repo root:

```bash
npm run server:set-root -- /absolute/path/to/projects
```

This is the sandbox-style root the wrapper uses for new session folders.

### 3. Start the wrapper server

macOS / Linux (bash/zsh):

```bash
OPENCODE_UPSTREAM_URL=http://127.0.0.1:4096 OPENCODE_UPSTREAM_USERNAME=opencode OPENCODE_UPSTREAM_PASSWORD=your-password node server/index.mjs --hostname 0.0.0.0 --port 4097
```

If you want the wrapper itself protected with Basic Auth, also set:

```bash
OPENCODE_REMOTE_USERNAME=opencode OPENCODE_REMOTE_PASSWORD=your-password
```

### 4. Point the Android app at the wrapper

Use these app settings:

- Host: your computer IP
- Port: `4097`
- Username/password: wrapper credentials if configured, otherwise any values are ignored

If remote/mobile cannot connect, open TCP `4097` in your OS firewall and network firewall/NAT.

## Run Locally (Web) to test

```bash
cd web
npm install
npm run dev
```
Open the shown URL from your browser (or your phone on the same LAN).

## Android APK Build (Cloud, no local SDK required)

1. Push to `main` or run workflow manually.
2. Open GitHub Actions -> **Build Android APK**.
3. Download artifact `opencode-remote-debug-apk`.
4. Install `app-debug.apk` on Android.

To also generate a signed release APK (`app-release-signed.apk`), configure these GitHub repository secrets:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

When all four secrets are present, the workflow publishes an additional artifact: `opencode-remote-release-apk`.

The workflow does this automatically:

- builds the React app
- creates Capacitor Android project
- compiles debug APK with Gradle

## Manual Android Packaging (Optional)

```bash
cd web
npm run build
npx cap add android
npx cap sync android
```

Then open `web/android` in Android Studio if you want local native debugging.

## App Configuration

Use your server values:

- Host: computer LAN IP (for example `192.168.1.20`)
- Port: `4096`
- Username/password: Basic Auth credentials used to start OpenCode server

The app is not limited to LAN. You can also use it over WAN/VPN if your network routing (NAT/firewall) and security setup are configured correctly.

## Main Endpoints Used

- `/global/health`
- `/session`, `/session/status`, `/session/:id`
- `/session/:id/message`, `/session/:id/command`, `/session/:id/abort`
- `/session/:id/todo`, `/session/:id/diff`
