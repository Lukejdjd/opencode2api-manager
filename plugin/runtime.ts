import { scheduledMaintenance } from "../service/maintenance";
export type RuntimeOptions = { sync?: boolean; check?: boolean };
export type Reporter = (message: string) => void | Promise<void>;
/** A lightweight wakeup; the on-disk coordinator owns actual scheduled work. */
export function startPluginRuntime(
  source: string,
  options: RuntimeOptions = {},
  report: Reporter = () => {},
  dependencies: { run?: typeof scheduledMaintenance; intervalMs?: number } = {},
) {
  const run = dependencies.run ?? scheduledMaintenance;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  const tick = () => {
    if (stopped || pending) return;
    pending = (async () => {
      try {
        const result = await run(source, options);
        if (!stopped && result.notice)
          await report(
            `opencode2api ${result.notice.installed} → ${result.notice.tag} available. ${result.notice.url} — update explicitly through the manager.`,
          );
      } catch (error) {
        if (!stopped) {
          try {
            await report(
              `Background check unavailable (${error instanceof Error ? error.name : "Error"}). Run the manager status command for details.`,
            );
          } catch {}
        }
      } finally {
        pending = undefined;
        if (!stopped) {
          timer = setTimeout(tick, dependencies.intervalMs ?? 60000);
          timer.unref?.();
        }
      }
    })();
  };
  // Setup returns immediately. No gateway, GitHub, or disk IO delays plugin loading.
  timer = setTimeout(tick, 0);
  timer.unref?.();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (pending) await pending;
  };
}
