import { readFile, appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createMaintenanceRunner } from "../service/maintenance";
import { withManagerLock } from "../service/lock";
export function fixtureRunner(directory: string) {
  return createMaintenanceRunner({
    stateDir: directory,
    exclusive: (fn) => withManagerLock(directory, fn),
    settings: async () =>
      JSON.parse(await readFile(path.join(directory, "settings.json"), "utf8")),
    atomic: async (file, text) => writeFile(file, text),
    syncModels: async () => {
      await appendFile(path.join(directory, "calls"), "sync\n");
      await new Promise((r) => setTimeout(r, 50));
      const s = JSON.parse(
        await readFile(path.join(directory, "settings.json"), "utf8"),
      );
      if (s.fail) throw new Error("offline");
      return {
        at: new Date().toISOString(),
        count: 1,
        added: [],
        changed: false,
        providerPath: s.providerPath,
        configPath: s.configPath,
      };
    },
    release: async () => {
      await appendFile(path.join(directory, "calls"), "release\n");
      await writeFile(
        path.join(directory, "release.json"),
        JSON.stringify({ tag: "v1.0.0", checkedAt: Date.now() }),
      );
      return { tag: "v1.0.0" };
    },
    health: async () => ({ version: "v1.0.0" }),
  });
}
