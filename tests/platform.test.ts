import { test, expect } from "bun:test";
import { controlLaunchAgent } from "../service/platform";

test("a registered gateway restarts without unregistering its LaunchAgent", async () => {
  const calls: string[][] = [];
  await controlLaunchAgent("restart", "gui/501", "gateway", "/gateway.plist", async (_, args) => {
    calls.push(args);
    return "";
  });
  expect(calls).toEqual([
    ["print", "gui/501/gateway"],
    ["kickstart", "-k", "gui/501/gateway"],
  ]);
});

test("an unloaded gateway retries registration after transient teardown errors", async () => {
  const calls: string[][] = [];
  let attempts = 0;
  await controlLaunchAgent("restart", "gui/501", "gateway", "/gateway.plist", async (_, args) => {
    calls.push(args);
    if (args[0] === "print") throw new Error("not registered");
    if (++attempts < 3) throw new Error("bootstrap temporarily unavailable");
    return "";
  }, async () => {});
  expect(attempts).toBe(3);
  expect(calls.some((args) => args[0] === "kickstart")).toBe(false);
});

test("failed registration preserves the bootstrap error instead of kicking a missing service", async () => {
  await expect(controlLaunchAgent("start", "gui/501", "gateway", "/gateway.plist", async (_, args) => {
    throw new Error(args[0] === "print" ? "not registered" : "invalid plist");
  }, async () => {})).rejects.toThrow("invalid plist");
});
