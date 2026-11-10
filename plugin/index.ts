import type { Plugin as V1Plugin } from "@opencode-ai/plugin";
import type { Plugin as V2 } from "@opencode/plugin";
import { startPluginRuntime } from "./runtime";
const server: V1Plugin = async (input, options = {}) => {
  const stop = startPluginRuntime(
    "opencode-v1",
    { sync: options.sync !== false, check: options.check !== false },
    async (message) => {
      try {
        await input.client.app.log({
          body: { service: "opencode2api-manager", level: "warn", message },
        });
        await input.client.tui.showToast({
          body: {
            title: "opencode2api update",
            message,
            variant: "info",
            duration: 10000,
          },
        });
      } catch {}
    },
  );
  return { dispose: stop };
};
const setup: V2.Plugin["setup"] = (context) => {
  return startPluginRuntime(
    "opencode-v2",
    {
      sync: context.options.sync !== false,
      check: context.options.check !== false,
    },
    (message) => console.warn(`[opencode2api-manager] ${message}`),
  );
};
// Official dual-generation object: V1 calls server(), V2 calls setup().
export default { id: "opencode2api-manager", server, setup };
