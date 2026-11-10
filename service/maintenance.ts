import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import * as manager from "./manager";
import { ManagerBusyError } from "./lock";
export const SYNC_INTERVAL_MS = 300000;
export const CHECK_INTERVAL_MS = 3600000;
type RecordState = { attemptedAt: number; status: string };
export type MaintenanceResult = {
  status: "completed" | "busy";
  sync?: { status: string; result?: unknown };
  release?: { status: string; tag?: string };
  notice?: { tag: string; installed: string; url: string };
};
export async function targetID(configPath: string, providerPath: string) {
  const canonical = async (p: string) => {
    const r = await realpath(p).catch(() => path.resolve(p));
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return createHash("sha256")
    .update(
      JSON.stringify(
        await Promise.all([canonical(configPath), canonical(providerPath)]),
      ),
    )
    .digest("hex");
}
async function readJSON(file: string) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {};
  }
}
/** At most one attempt per target/interval, even when clients start sequentially. */
export function createMaintenanceRunner(
  manager: Pick<
    typeof import("./manager"),
    | "stateDir"
    | "exclusive"
    | "settings"
    | "atomic"
    | "syncModels"
    | "release"
    | "health"
  >,
) {
  return async function runMaintenance(
    source: string,
    options: { sync?: boolean; check?: boolean } = {},
  ): Promise<MaintenanceResult> {
    try {
      return await manager.exclusive(async () => {
        const s = await manager.settings();
        const id = await targetID(s.configPath, s.providerPath);
        const file = path.join(manager.stateDir, "maintenance.json");
        const state = await readJSON(file);
        state.jobs ??= {};
        const now = Date.now();
        const result: MaintenanceResult = { status: "completed" };
        const due = (job: RecordState | undefined, interval: number) =>
          !job || now - job.attemptedAt >= interval || job.attemptedAt > now;
        if (options.sync !== false && s.autoSync) {
          const job = state.jobs[id];
          const last = await readJSON(path.join(manager.stateDir, "sync.json"));
          const recentManual =
            last.providerPath === s.providerPath &&
            last.configPath === s.configPath &&
            now - Date.parse(last.at) >= 0 &&
            now - Date.parse(last.at) < SYNC_INTERVAL_MS;
          if (recentManual || !due(job, SYNC_INTERVAL_MS)) {
            result.sync = { status: "recent" };
          } else {
            state.jobs[id] = { attemptedAt: now, status: "running", source };
            await manager.atomic(file, JSON.stringify(state));
            try {
              const synced = await manager.syncModels();
              state.jobs[id].status = "ok";
              result.sync = { status: "synced", result: synced };
            } catch {
              state.jobs[id].status = "failed";
              result.sync = { status: "failed" };
            }
          }
        } else result.sync = { status: "disabled" };
        if (options.check !== false) {
          const cached = await readJSON(
            path.join(manager.stateDir, "release.json"),
          );
          if (
            !due(state.release, CHECK_INTERVAL_MS) ||
            (Number.isFinite(cached.checkedAt) &&
              now - cached.checkedAt >= 0 &&
              now - cached.checkedAt < CHECK_INTERVAL_MS)
          ) {
            result.release = { status: "recent", tag: cached.tag };
          } else {
            state.release = { attemptedAt: now, status: "running", source };
            await manager.atomic(file, JSON.stringify(state));
            const r = await manager.release(true);
            state.release.status = r.error || r.stale ? "failed" : "ok";
            result.release = { status: state.release.status, tag: r.tag };
          }
          const currentRelease = await readJSON(
            path.join(manager.stateDir, "release.json"),
          );
          const lastNotice = state.notices?.[id];
          // Emit once per release per target, across plugin instances and projects.
          if (currentRelease.tag && lastNotice !== currentRelease.tag) {
            const h = await manager.health();
            const { newer } = await import("./core");
            if (h?.version && newer(currentRelease.tag, h.version)) {
              state.notices ??= {};
              state.notices[id] = currentRelease.tag;
              result.notice = {
                tag: currentRelease.tag,
                installed: h.version,
                url: currentRelease.url,
              };
            }
          }
        }
        state.lastSource = source;
        state.checkedAt = now;
        await manager.atomic(file, JSON.stringify(state));
        return result;
      });
    } catch (error) {
      if (error instanceof ManagerBusyError) return { status: "busy" };
      throw error;
    }
  };
}
export const scheduledMaintenance = createMaintenanceRunner(manager);
