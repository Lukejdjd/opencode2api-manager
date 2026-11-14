// Actual Windows install/start/stop smoke test, isolated from user data.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
if (process.platform !== "win32")
  throw new Error("This smoke test requires Windows.");
const temp = mkdtempSync(path.join(os.tmpdir(), "oc2-manager-"));
const root = path.join(temp, "gateway with spaces");
mkdirSync(root);
const state = path.join(temp, "state");
const provider = path.join(temp, "opencode.jsonc");
writeFileSync(provider, "{}");
const env = { ...process.env, OPENCODE2API_MANAGER_DATA_DIR: state };
const run = (...args: string[]) =>
  execFileSync("node", ["cli/main.js", ...args], {
    env,
    encoding: "utf8",
    timeout: 480000,
  });
try {
  run(
    "settings",
    JSON.stringify({
      root,
      binary: path.join(root, "opencode2api.exe"),
      configPath: path.join(root, "config.json"),
      providerPath: provider,
      launchLabel: "",
    }),
  );
  console.log(run("install"));
  const status = JSON.parse(run("status"));
  if (!status.health?.ready) throw new Error("Installed gateway not ready.");
  console.log(run("connect"));
  console.log(run("sync"));
  if (status.health.version === "v1.4.7") {
    const configFile = path.join(root, "config.json");
    const configBefore = readFileSync(configFile, "utf8");
    const providerBefore = readFileSync(provider, "utf8");
    const patch = JSON.parse(run("install-fork-patch"));
    if (JSON.parse(run("status")).health?.version !== "v1.4.7-local-fork-affinity")
      throw new Error("Patched gateway did not start.");
    const restore = JSON.parse(run("restore-stock"));
    if (JSON.parse(run("status")).health?.version !== "v1.4.7")
      throw new Error("Restore did not launch the stock gateway.");
    if (!patch.backup || !restore.backup ||
      readFileSync(configFile, "utf8") !== configBefore ||
      readFileSync(provider, "utf8") !== providerBefore)
      throw new Error("Restore did not preserve configuration and backups.");
  }
  console.log(run("stop"));
  console.log(run("start"));
  console.log(run("stop"));
  console.log(
    "Windows official binary: checksum, ZIP extraction, setup, start, provider sync, stop/restart passed.",
  );
} finally {
  try {
    run("stop");
  } catch {}
  rmSync(temp, { recursive: true, force: true });
}
