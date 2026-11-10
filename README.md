# opencode2api Manager

Install, update and manage [opencode2api](https://github.com/jasonxu114514/opencode2api) on **macOS and Windows**.

**One repo, three ways to use it:** an OpenChamber panel, an OpenCode v1/v2 **server plugin**, and a CLI. No TUI/GUI plugin or RPC setup is needed.

## OpenChamber

1. Open **Settings → Extensions**.
2. Add `https://github.com/Lukejdjd/opencode2api-manager` and review its permissions.
3. Open **opencode2api Manager** on the rail.
4. If the gateway isn't installed, click **Install and start**.
5. Click **Add provider**, then **Show local key**. Connect that key under **Settings → Providers → opencode2api**.

[Install in OpenChamber](openchamber://extensions/install?url=https%3A%2F%2Fgithub.com%2FLukejdjd%2Fopencode2api-manager)

Already have opencode2api? Check **Installation paths**; don't reinstall it.

## OpenCode CLI users

Clone the repo, then run:

```sh
git clone https://github.com/Lukejdjd/opencode2api-manager.git
cd opencode2api-manager
node cli/main.js install
node cli/main.js connect
node cli/main.js key
node cli/main.js enable-plugin
```

Connect the printed key using OpenCode's **`/connect`**, then restart OpenCode.

**OpenCode v1:** add `--v1` to `connect` and `enable-plugin`.

Already have a gateway? Skip `install`; use `node cli/main.js settings` to inspect its detected paths.

## What runs automatically?

- **Model sync:** every five minutes while OpenChamber or the OpenCode plugin is running. The shared **Automatic model sync** setting controls both.
- **Update checks:** hourly while either interface is active. Gateway updates require your action.
- **Using both?** They share a lock and timestamps, so they don't repeat the same sync. Multiple OpenCode projects are coordinated too.
- **No plugin installed?** `node cli/main.js watch` is the fallback; keep that terminal running.

**Windows login is separate.** Freshly installed gateways don't automatically start when you sign in. Click **Start** after login, or configure Windows startup separately. This doesn't mean you need the `watch` command when the plugin is installed.

## Useful commands

```sh
node cli/main.js status
node cli/main.js check
node cli/main.js update
node cli/main.js start
node cli/main.js sync
```

WARP is optional and affects gateway traffic only. Enable it in the panel after reviewing Cloudflare's terms. Rate limits can still occur.

## Requirements

- OpenChamber **2.7.0+** for the panel.
- OpenCode **1.18.29+** for the v1 server-plugin format; v2 adapter targets **2.2.3+**. See CI for versions verified.
- **Node 20+** for the CLI. The OpenChamber extension uses its bundled runtime.
- macOS Apple Silicon/Intel or Windows x64. Linux CLI support is included.

[Advanced paths, backups and limitations](docs/DETAILS.md) · [Tests](https://github.com/Lukejdjd/opencode2api-manager/actions) · [MIT license](LICENSE)
