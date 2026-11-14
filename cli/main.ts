#!/usr/bin/env node
import { scheduledMaintenance } from "../service/maintenance";
import * as m from "../service/manager";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { parseConfig, edit } from "../service/core";
const [action = "help", ...args] = process.argv.slice(2);
async function main() {
  if (action === "help") {
    console.log(
      `opencode2api-manager (Node 20+)\n\nstatus | check | install | update | install-fork-patch | restore-stock | start | stop | restart | sync | watch | maintenance\nenable-plugin [--v1] | connect [--v1] | key | logs | settings [JSON] | warp on|off [pool-size] [ipv6|ipv4|dual] [--accept-warp-terms]\n\nInstall uses official checksummed releases. WARP starts OFF.\nconnect adds provider/models; connect the local key once through OpenCode /connect.\nwatch synchronizes every 5 minutes until Ctrl+C; keep it running for standalone OpenCode.\nsettings JSON sets absolute root/binary/configPath/providerPath, launchLabel (macOS), autoSync.\nState: ${m.stateDir}`,
    );
    return;
  }
  if (action === "watch") {
    console.log("Watching model catalog every 5 minutes. Ctrl+C to stop.");
    for (;;) {
      try {
        console.log(JSON.stringify(await scheduledMaintenance("cli-watch")));
      } catch (e) {
        console.error(e instanceof Error ? e.message : "Sync unavailable.");
      }
      await new Promise((r) => setTimeout(r, 300000));
    }
  }
  const operations: Record<string, () => Promise<any>> = {
    "enable-plugin": () =>
      m.exclusive(async () => {
        const settings = await m.settings();
        let original = "{}\n";
        try {
          original = await readFile(settings.providerPath, "utf8");
        } catch {}
        const config = parseConfig(original);
        const key = args.includes("--v1") ? "plugin" : "plugins";
        const entries = config[key] ?? [];
        if (!Array.isArray(entries))
          throw new Error("Plugin list is not an array.");
        const folder = fileURLToPath(new URL("../", import.meta.url)).replace(
          /[\\/]$/,
          "",
        );
        if (
          !entries.some(
            (entry: any) =>
              entry === folder ||
              (Array.isArray(entry) && entry[0] === folder) ||
              entry?.package === folder,
          )
        ) {
          const next = edit(original, [key], [...entries, folder]);
          if (original !== "{}\n") await m.backup(settings.providerPath);
          await m.atomic(
            settings.providerPath,
            next,
            original === "{}\n" ? undefined : original,
          );
        }
        return {
          message:
            "Server plugin added. Restart OpenCode/OpenChamber to load it. Model sync uses the shared manager setting.",
        };
      }),
    maintenance: () =>
      scheduledMaintenance("cli-maintenance", {
        check: !args.includes("--sync-only"),
      }),
    status: () => m.snapshot(),
    check: () => m.snapshot(true),
    install: () => m.exclusive(() => m.install()),
    update: () => m.exclusive(() => m.update()),
    "install-fork-patch": () => m.exclusive(() => m.installForkPatch()),
    "restore-stock": () => m.exclusive(() => m.restoreStockGateway()),
    start: () => m.exclusive(() => m.serviceControl("start")),
    stop: () => m.exclusive(() => m.serviceControl("stop")),
    restart: () => m.exclusive(() => m.serviceControl("restart")),
    sync: () => m.exclusive(() => m.syncModels()),
    connect: () => m.exclusive(() => m.connectProvider(args.includes("--v1"))),
    key: () => m.readLocalKey(),
    logs: () => m.logs(),
    settings: () =>
      args.length
        ? m.exclusive(() => m.saveSettings(JSON.parse(args.join(" "))))
        : m.settings(),
    warp: () => {
      if (!["on", "off"].includes(args[0] ?? ""))
        throw new Error("Use warp on|off.");
      return m.exclusive(() =>
        m.setWarp({
          enabled: args[0] === "on",
          poolSize: Number(args[1] ?? 4),
          stack: args[2] ?? "ipv6",
          acceptWarpTerms: args.includes("--accept-warp-terms"),
        }),
      );
    },
  };
  if (!operations[action]) throw new Error("Unknown command. Run help.");
  console.log(JSON.stringify(await operations[action]!(), null, 2));
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "Operation failed.");
  process.exitCode = 1;
});
