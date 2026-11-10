import { test, expect } from "bun:test";
import plugin from "../plugin/index";
import { startPluginRuntime } from "../plugin/runtime";
import type { Plugin as V1 } from "@opencode-ai/plugin";
import type { Plugin as V2 } from "@opencode/plugin";
const v1: V1 = plugin.server;
const v2: V2.Plugin = plugin;
test("single export exposes both official plugin entrypoints", () => {
  expect(typeof v1).toBe("function");
  expect(typeof v2.setup).toBe("function");
  expect(plugin.id).toBe("opencode2api-manager");
});
test("setup is asynchronous/nonblocking and dispose prevents future ticks", async () => {
  let calls = 0;
  const stop = startPluginRuntime("test", {}, () => {}, {
    intervalMs: 10,
    run: async () => {
      calls++;
      return { status: "completed" };
    },
  });
  expect(calls).toBe(0);
  await new Promise((r) => setTimeout(r, 35));
  expect(calls).toBeGreaterThan(0);
  await stop();
  const count = calls;
  await new Promise((r) => setTimeout(r, 35));
  expect(calls).toBe(count);
});
test("missing gateway does not throw out of the plugin or leak unhandled rejection", async () => {
  let calls = 0;
  const stop = startPluginRuntime("test", {}, () => {}, {
    intervalMs: 10,
    run: async () => {
      calls++;
      throw new Error("offline");
    },
  });
  await new Promise((r) => setTimeout(r, 30));
  await stop();
  expect(calls).toBeGreaterThan(0);
});
test("runtime does not overlap its own pending maintenance", async () => {
  let inflight = 0,
    max = 0;
  const stop = startPluginRuntime("test", {}, () => {}, {
    intervalMs: 1,
    run: async () => {
      inflight++;
      max = Math.max(max, inflight);
      await new Promise((r) => setTimeout(r, 20));
      inflight--;
      return { status: "busy" };
    },
  });
  await new Promise((r) => setTimeout(r, 65));
  await stop();
  expect(max).toBe(1);
});
