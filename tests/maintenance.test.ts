import { test, expect } from "bun:test";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  mkdir,
  utimes,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fixtureRunner } from "./maintenance-fixture";
import { withManagerLock } from "../service/lock";
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oc2-coordinator-"));
  await writeFile(
    path.join(dir, "settings.json"),
    JSON.stringify({
      configPath: path.join(dir, "gateway.json"),
      providerPath: path.join(dir, "opencode.jsonc"),
      autoSync: true,
    }),
  );
  return dir;
}
async function calls(dir: string) {
  return readFile(path.join(dir, "calls"), "utf8").catch(() => "");
}
function worker(dir: string, source: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.resolve("tests/maintenance-worker.ts"), dir, source],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let err = "";
    child.stderr.on("data", (x) => (err += x));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(err)),
    );
  });
}
test("OpenChamber + V1 + V2 + CLI processes make one sync and one release check", async () => {
  const dir = await fixture();
  try {
    await Promise.all(
      ["openchamber", "opencode-v1", "opencode-v2", "cli-watch"].map((s) =>
        worker(dir, s),
      ),
    );
    await worker(dir, "next-project");
    const text = await calls(dir);
    expect(text.split("sync\n").length - 1).toBe(1);
    expect(text.split("release\n").length - 1).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
test("failed attempts also throttle; expired interval allows failover", async () => {
  const dir = await fixture();
  try {
    const s = JSON.parse(
      await readFile(path.join(dir, "settings.json"), "utf8"),
    );
    s.fail = true;
    await writeFile(path.join(dir, "settings.json"), JSON.stringify(s));
    const run = fixtureRunner(dir);
    expect((await run("v1")).sync?.status).toBe("failed");
    expect((await run("openchamber")).sync?.status).toBe("recent");
    const file = path.join(dir, "maintenance.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    for (const j of Object.values(state.jobs) as any[]) j.attemptedAt -= 300001;
    await writeFile(file, JSON.stringify(state));
    expect((await run("v2")).sync?.status).toBe("failed");
    expect((await calls(dir)).split("sync\n").length - 1).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("global autoSync=false applies to every interface", async () => {
  const dir = await fixture();
  try {
    const s = JSON.parse(
      await readFile(path.join(dir, "settings.json"), "utf8"),
    );
    s.autoSync = false;
    await writeFile(path.join(dir, "settings.json"), JSON.stringify(s));
    expect((await fixtureRunner(dir)("plugin")).sync?.status).toBe("disabled");
    expect(await calls(dir)).not.toContain("sync\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("manual sync timestamp prevents immediate background duplicate", async () => {
  const dir = await fixture();
  try {
    const s = JSON.parse(
      await readFile(path.join(dir, "settings.json"), "utf8"),
    );
    await writeFile(
      path.join(dir, "sync.json"),
      JSON.stringify({ ...s, at: new Date().toISOString() }),
    );
    expect((await fixtureRunner(dir)("plugin")).sync?.status).toBe("recent");
    expect(await calls(dir)).not.toContain("sync\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("a stale process lock is recovered; active lock is not stolen", async () => {
  const dir = await fixture();
  try {
    const lock = path.join(dir, "operation.lock");
    await mkdir(lock);
    const old = new Date(Date.now() - 180000);
    await utimes(lock, old, old);
    await withManagerLock(dir, async () => {
      await expect(withManagerLock(dir, async () => {})).rejects.toThrow(
        "Another manager operation",
      );
    });
    await withManagerLock(dir, async () => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
