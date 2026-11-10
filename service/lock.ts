import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
const ownership = new AsyncLocalStorage<{ compromised: boolean }>();
export class ManagerBusyError extends Error {
  constructor() {
    super("A model sync, update check, or gateway action is already in progress. Wait a moment, then try again.");
    this.name = "ManagerBusyError";
  }
}
export function assertLockValid() {
  if (ownership.getStore()?.compromised)
    throw new Error("Manager lock was lost; operation cancelled.");
}
/** Same constants and lock path for every bundled interface/process. */
export async function withManagerLock<T>(
  directory: string,
  fn: () => Promise<T>,
): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const state = { compromised: false };
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(path.join(directory, "operation"), {
      realpath: false,
      lockfilePath: path.join(directory, "operation.lock"),
      stale: 120000,
      update: 10000,
      retries: 0,
      onCompromised: () => {
        state.compromised = true;
      },
    });
  } catch (error: any) {
    if (error.code === "ELOCKED") throw new ManagerBusyError();
    throw error;
  }
  try {
    return await ownership.run(state, async () => {
      const result = await fn();
      assertLockValid();
      return result;
    });
  } finally {
    if (!state.compromised) await release();
  }
}
