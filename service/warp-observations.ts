import { isIP } from "node:net";

const minimumCooldownMs = 30 * 60 * 1000;

export function warpObservations(log: string, now = Date.now()) {
  const active = new Map<string, string>();
  const cooling = new Map<string, number>();
  let lastReady: { id: string; address: string; at: number } | undefined;
  for (const line of log.split("\n")) {
    let row: { component?: string; time?: string; msg?: string };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.component !== "warp" || typeof row.msg !== "string") continue;
    const at = Date.parse(row.time ?? "");
    if (!Number.isFinite(at) || at > now) continue;
    const message = row.msg;
    const ready = /^OpenCode WARP\/\w+ egress ([\w-]+) ready at (\S+)$/.exec(message);
    if (ready && isIP(ready[2]!)) {
      lastReady = { id: ready[1]!, address: ready[2]!, at };
      active.set(lastReady.id, lastReady.address);
      continue;
    }
    if (/^OpenCode WARP\/\w+ pool ready \(/.test(message)) {
      active.clear();
      cooling.clear();
      if (lastReady && at - lastReady.at < 1000)
        active.set(lastReady.id, lastReady.address);
      lastReady = undefined;
      continue;
    }
    const retired = /^(?:Rotating OpenCode WARP egress|OpenCode WARP egress) ([\w-]+) (\(|scaled down at)/.exec(message);
    if (retired) {
      const id = retired[1]!;
      const address = active.get(id);
      active.delete(id);
      if (address && retired[2] === "(" && at + minimumCooldownMs > now)
        cooling.set(address, at + minimumCooldownMs);
      continue;
    }
    const replaced = /^OpenCode WARP egress ([\w-]+) replaced by ([\w-]+) at (\S+) /.exec(message);
    if (replaced && isIP(replaced[3]!)) {
      active.delete(replaced[1]!);
      active.set(replaced[2]!, replaced[3]!);
    }
  }
  const addresses = [...new Set(active.values())];
  return {
    active: addresses,
    cooling: [...cooling]
      .filter(([address]) => !addresses.includes(address))
      .map(([address, estimatedUntil]) => ({ address, estimatedUntil }))
      .sort((a, b) => a.estimatedUntil - b.estimatedUntil),
  };
}
