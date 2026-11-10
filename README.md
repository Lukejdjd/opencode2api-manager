# opencode2api Manager

A local manager for [opencode2api](https://github.com/jasonxu114514/opencode2api), usable as an **OpenChamber extension** or a **standalone OpenCode companion CLI**. It is a manager, not another inference proxy.

- Check installed/latest stable gateway versions and read release notes.
- Install the official gateway from scratch on macOS or Windows x64, with SHA-256 verification.
- Start, stop, restart, update, and restore the previous binary if update readiness fails.
- Configure the built-in WARP pool; show active, standby, and cooling exits.
- Add/sync the OpenCode provider and its model limits/capabilities, preserving JSONC comments, custom names, variants, and missing models.
- Automatically sync every five minutes while OpenChamber is running, when enabled. Standalone CLI users can run `watch`.
- Inspect selected structured log fields without exposing API keys or conversation content.

## What kind of extension is this?

This package is an **OpenChamber extension plus a standalone CLI**, not an OpenCode server/TUI plugin. Do not add this repository to OpenCode's `plugins` array. The CLI manages the gateway and writes the provider configuration that OpenCode reads; it does not inject hooks, commands, or UI into the OpenCode process.

| Interface | Requirement |
| --- | --- |
| OpenChamber panel and Work Status | OpenChamber 2.7.0+ |
| Standalone manager CLI | Node.js 20+; Node 22 tested in CI |
| Default provider output | OpenCode 2.x configuration format |
| `connect --v1` | Legacy OpenCode 1.x configuration format; merge behavior tested, exact OpenCode runtime minimum not established |

There is no OpenCode plugin-API dependency. OpenCode itself is not installed by this manager. Native OpenCode plugin/TUI integration would be an additional entrypoint, separate from the existing OpenChamber panel.

## Install in OpenChamber

Requires **OpenChamber 2.7.0+**. Add this repository URL under **Settings → Extensions → Folder, ZIP or URL**:

```text
https://github.com/Lukejdjd/opencode2api-manager
```

[Install in OpenChamber](openchamber://extensions/install?url=https%3A%2F%2Fgithub.com%2FLukejdjd%2Fopencode2api-manager)

Review the service permission prompt. The local Node service runs with your user's rights, reads gateway keys from its local configuration, edits the selected OpenCode provider configuration, downloads official releases, and runs the configured gateway executable. It never receives your chats. It does not require admin rights or a system Node installation inside OpenChamber.

Find **opencode2api Manager** on the rail or Extension pages menu, and **opencode2api** in Work Status. Installed dependencies and compiled scripts are included; OpenChamber does not need to build anything. Repository installs receive extension-update notices through OpenChamber. Gateway updates remain click-to-update.

### Fresh Windows or Mac setup

1. Open the manager. Check **Installation paths** if you use custom locations.
2. Click **Install and start**. It downloads the platform-specific official release, verifies its checksum, generates a local API key, and starts the gateway on `127.0.0.1:8080`. The gateway's web dashboard starts disabled; this manager supplies its controls.
3. Click **Add provider** to write the provider and discovered models into OpenCode's global config.
4. Click **Show local key**, then connect `opencode2api` once in **OpenChamber Settings → Providers**, or **OpenCode `/connect`**. This uses the application's own credential store; the manager does not write to obsolete auth files. Keep the key private.
5. Enable **Automatically sync every five minutes** if wanted. This is a local extension service task, not an agent/AI automation and consumes no model tokens.
6. WARP is initially **off**. To enable it, read/accept Cloudflare's terms, select the pool settings, then click **Apply and restart**. UDP 2408 must be reachable. Only gateway free-model traffic uses the tunnel, not your whole computer. It can retry a rate-limited request on another exit; it cannot guarantee fresh quota or replay a stream already sent to a client.

An existing gateway is not overwritten by Install. macOS LaunchAgents whose filenames contain `opencode2api` are detected where possible; inspect the paths before controlling them. Other installations can be selected in Installation paths.

## Standalone OpenCode

Requires **Node.js 20+** (22 recommended). No OpenChamber required. Clone or download this repo; built scripts are committed:

```sh
git clone https://github.com/Lukejdjd/opencode2api-manager.git
cd opencode2api-manager
node cli/main.js install
node cli/main.js connect
node cli/main.js key
# In OpenCode: /connect → opencode2api → use the local key
node cli/main.js status
node cli/main.js watch
```

Those commands also work in Windows PowerShell. `watch` keeps syncing every five minutes until stopped; it must remain running. One-shot `sync` runs once. `connect --v1` generates the legacy OpenCode 1.x provider format; the default is OpenCode 2.x/OpenChamber's v2 format. Existing v1 provider blocks can also be synchronized.

```sh
node cli/main.js check
node cli/main.js update
node cli/main.js restart
node cli/main.js sync
node cli/main.js logs
node cli/main.js warp on 4 ipv6 --accept-warp-terms
node cli/main.js warp off 4 ipv6
```

Read the [Cloudflare WARP terms](https://www.cloudflare.com/application/terms/) before supplying the acceptance flag.

### Paths and process lifetime

Default fresh gateway folder:
- Windows: `%LOCALAPPDATA%\opencode2api`
- macOS/Linux: `~/.local/share/opencode2api`

The OpenCode config defaults to `$XDG_CONFIG_HOME/opencode/opencode.jsonc` or `~/.config/opencode/opencode.jsonc`, using an existing `.json` when no `.jsonc` exists. Pick a custom path if your OpenCode install uses another location.

The CLI and extension share local settings in `~/.config/opencode2api-manager`. `OPENCODE2API_MANAGER_DATA_DIR` overrides this for isolated testing. Settings, downloaded archives, local state, and config backups live outside the extension package and Git repository. Backups may contain credentials; keep them private. They are currently retained until manually removed.

Existing macOS LaunchAgents are controlled using `launchctl`. Fresh installs and Windows/Linux installs run a detached gateway child process. These survive closing the manager but **do not automatically start after reboot/login**. Open the manager and click Start, or use the CLI. Configure startup separately if desired. Windows services created by NSSM/SCM are not automatically adopted; stop them in their own service manager before starting the manager-owned gateway. The manager only terminates processes whose saved PID and executable path match its own gateway.

Settings can also be set with `node cli/main.js settings '<JSON>'` (PowerShell: single-quote JSON with double-quoted property names). Accepts absolute `root`, `binary`, `configPath`, `providerPath`, plus `launchLabel` on macOS and `autoSync`. Avoid concurrent managers for different gateways: this release intentionally supports one local gateway at port 8080.

## Compatibility and limits

- macOS Apple Silicon and Intel; Windows x64. On Windows ARM, use an x64 Node/OpenChamber runtime. Linux binaries are supported by the CLI but no Linux service-manager integration is included.
- Node/Electron built-ins only at runtime; neither Bun nor Python is needed by the installed extension.
- Automatic sync/update checks in the extension need OpenChamber running. Version checks are cached for one hour. Work Status refreshes while visible; opening/refreshing the panel also checks cached state. No OS notifications or agent tasks are created.
- The badge is a manager rail badge, not an update badge on OpenChamber's built-in provider card. The Work Status section can show a newer gateway release without opening the panel.
- Sync only adds/refreshes discovered entries. Removed/temporarily missing models and manual overrides remain; delete retired entries yourself.
- Sync respects custom names/variants/other fields, but deliberately refreshes discovered limits and input/output/tool capabilities. Redirected `modelID` entries are left alone.
- It cannot remove upstream rate limits. Rotating exits may share exhausted quota. Upstream behavior can change.
- Applying WARP settings, stopping, restarting, or updating interrupts active requests. Updates verify binary readiness, not a paid inference call. Only the previous binary is restored on update failure; a private pre-update configuration backup is kept separately.
- Gateway and extension have separate versions. This manager is not affiliated with OpenCode, OpenChamber, Cloudflare, or opencode2api.

## Development and tests

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
bun run check
```

GitHub Actions runs checks on macOS, Windows and Linux. The Windows job additionally downloads/checksums/extracts the real official gateway and exercises fresh setup, readiness, provider/model sync, and stop/start in an isolated temporary directory. It makes no inference calls and does not enable WARP. Network failures can fail that smoke test. Real Windows WARP/desktop integration still needs testing on your network.

## Licenses

This manager is MIT-licensed; bundled dependency notices are in THIRD_PARTY_NOTICES.txt. opencode2api is a separate GPL-3.0 project downloaded from its official release. The manager does not redistribute or modify its binary. Cloudflare's terms apply to WARP.
