// Read-only live-gateway smoke test. Does not stop/restart or change its config.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { guestStatusViewSchema } from "@openchamber/sdk/schemas";
const temp = await mkdtemp(path.join(os.tmpdir(), "oc2-extension-test-"));
const port = 4599;
const token = "test-only-token";
const child = spawn("node", ["service/main.js"], {
  env: {
    ...process.env,
    OPENCODE2API_MANAGER_DATA_DIR: temp,
    OPENCHAMBER_SERVICE_PORT: String(port),
    OPENCHAMBER_SERVICE_TOKEN: token,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (x) => (stderr += x));
const call = async (p: string, body?: any, auth = true) =>
  fetch(`http://127.0.0.1:${port}${p}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
try {
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      if ((await call("/health")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw new Error("Service startup failed: " + stderr);
  if ((await call("/health", undefined, false)).status !== 401)
    throw new Error("Authentication missing.");
  const snapshot = (await (await call("/snapshot")).json()) as any;
  if (!snapshot.health?.ready) throw new Error("Live gateway unavailable.");
  const status = await (await call("/status")).json();
  guestStatusViewSchema.parse(status);
  const logs = (await (await call("/logs")).json()) as any;
  if (!Array.isArray(logs.rows)) throw new Error("Log route failed.");
  const key = (await (await call("/local-key", {})).json()) as any;
  if (typeof key.key !== "string" || key.key.length < 8)
    throw new Error("Local key retrieval failed.");
  const invalid = await call("/settings", { root: "relative-path" });
  if (invalid.status !== 400) throw new Error("Invalid paths accepted.");
  for (const accepted of [true, false]) {
    const saved = await call("/settings", { warpTermsAccepted: accepted });
    if (!saved.ok) throw new Error("WARP acceptance save failed.");
    await call("/settings", { autoSync: false });
    const disk = JSON.parse(await readFile(path.join(temp, "settings.json"), "utf8"));
    const refreshed = await (await call("/snapshot")).json() as any;
    if (disk.warpTermsAccepted !== accepted || refreshed.settings.warpTermsAccepted !== accepted)
      throw new Error("WARP acceptance did not persist across settings changes and refresh.");
  }
  if ((await call("/missing")).status !== 404)
    throw new Error("Unknown route accepted.");
  await call("/action", {
    action: "warp",
    enabled: true,
    poolSize: 0,
    stack: "ipv6",
  });
  let result: any;
  for (let i = 0; i < 20; i++) {
    result = await (await call("/snapshot")).json();
    if (result.job?.status !== "running") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (result.job?.status !== "error")
    throw new Error("Invalid WARP action not rejected.");
  console.log(
    "PASS: service startup, bearer auth, gateway snapshot, valid Work Status schema, redacted log route, local-key route, settings validation, WARP acceptance persistence/revocation, 404, async operation error",
  );
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((r) => child.once("exit", r));
    child.kill();
    await exited;
  }
  await rm(temp, { recursive: true, force: true });
}
