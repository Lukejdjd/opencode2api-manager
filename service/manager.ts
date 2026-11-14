import { withManagerLock, assertLockValid } from "./lock";
import { warpObservations } from "./warp-observations";
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  copyFile,
  readdir,
  stat,
  rm,
  open,
  chmod,
  mkdtemp,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  REPO,
  parseConfig,
  edit,
  mergeCatalog,
  newer,
  assetName,
  validateArchiveEntries,
} from "./core";
import { command, ps, discoverMacBinary, control } from "./platform";
export type Settings = {
  root: string;
  binary: string;
  configPath: string;
  providerPath: string;
  launchLabel: string;
  autoSync: boolean;
  warpTermsAccepted: boolean;
  independentForkAffinity: boolean;
};
export const stateDir =
  process.env.OPENCODE2API_MANAGER_DATA_DIR ??
  path.join(os.homedir(), ".config", "opencode2api-manager");

const forkPatchVersion = "v1.4.7";
const forkPatchBuild = "v1.4.7-local-fork-affinity";
// v1.4.7 allows five minutes plus 30 seconds for its first WARP registration.
const macGatewayStartupSeconds = 350;

function supportsForkPatch() {
  return (process.platform === "win32" && process.arch === "x64") ||
    (process.platform === "darwin" && ["arm64", "x64"].includes(process.arch));
}

const macGoArchives = {
  arm64: ["arm64", "91a44a2b8a716600ad94a4f143e156116620db8828086a6e3602291be9bd0bb4"],
  x64: ["amd64", "2b799377704ef12db39bd254995d5c348c9cc8d86562ca817724390e56c38f43"],
} as const;

export function patchForkSource(original: string, mac: boolean, settingFile: string) {
  const anchor = '\t"net/http"\n';
  const insert = "\tif signal == \"\" {\n";
  if (!original.includes(anchor) || !original.includes(insert))
    throw new Error("Gateway source does not match the patch.");
  // launchd does not inherit the Manager environment. Read the persisted
  // settings once at gateway startup, without changing the LaunchAgent.
  const macSetting = `
var independentForkAffinity = func() bool {
  data, err := os.ReadFile(${JSON.stringify(settingFile)})
  if os.IsNotExist(err) { return true }
  if err != nil { return false }
  var state struct { Enabled *bool \`json:"independentForkAffinity"\` }
  if json.Unmarshal(data, &state) != nil { return false }
  return state.Enabled == nil || *state.Enabled
}()
`;
  return original.replace(anchor, anchor + '\t"os"\n').replace(insert, `\t// A fork can keep its own stable upstream affinity.
\tif ${mac ? "independentForkAffinity" : 'os.Getenv("OPENCODE2API_INDEPENDENT_FORK_AFFINITY") == "1"'} &&
\t\tr.Header.Get("x-opencode-parent-session-id") == "" &&
\t\tr.Header.Get("x-parent-session-id") == "" &&
\t\tjsonutil.StringAt(body, "metadata", "parent_session_id") == "" {
\t\tif ownID := r.Header.Get("x-opencode-session-id"); isOfficialSessionID(ownID) {
\t\t\tsignal = ownID
\t\t}
\t}
` + insert) + (mac ? macSetting : "");
}

export async function installForkPatch() {
  if (!supportsForkPatch())
    throw new Error("The local gateway patch supports macOS ARM64/x64 and Windows x64.");
  const mac = process.platform === "darwin";
  const s = await settings();
  const version = (await health())?.version;
  if (version !== forkPatchVersion && version !== forkPatchBuild)
    throw new Error("Start gateway v1.4.7 before building its local patch.");
  await verifyGatewayLauncher(s);
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode2api-fork-"));
  const exec = promisify(execFile);
  async function archive(url: string, name: string, sha256: string) {
    const bytes = await download(url, 150 * 1024 * 1024, [
      "codeload.github.com", "go.dev", "dl.google.com",
    ]);
    if (createHash("sha256").update(bytes).digest("hex") !== sha256)
      throw new Error("Local patch archive checksum mismatch.");
    const file = path.join(dir, name);
    await writeFile(file, bytes, { flag: "wx" });
    await exec(mac ? "/usr/bin/tar" : "tar.exe", ["-xf", file, "-C", dir], { timeout: 120000, windowsHide: true });
  }
  try {
    await archive(
      "https://codeload.github.com/jasonxu114514/opencode2api/zip/refs/tags/v1.4.7",
      "source.zip",
      "678398f1a99ae629dcd35d926017d4872b3986261feb5344022311d1bc4826b9",
    );
    const source = path.join(dir, "opencode2api-1.4.7");
    const file = path.join(source, "internal", "identity", "request.go");
    const original = await readFile(file, "utf8");
    await writeFile(file, patchForkSource(original, mac, path.join(stateDir, "settings.json")));
    let go = mac ? "go" : "go.exe";
    try {
      await exec(go, ["version"], { timeout: 5000, windowsHide: true });
    } catch {
      if (mac) {
        const [arch, sha] = macGoArchives[process.arch as keyof typeof macGoArchives];
        const name = `go1.27.4.darwin-${arch}.tar.gz`;
        await archive("https://go.dev/dl/" + name, name, sha);
      } else await archive(
        "https://go.dev/dl/go1.27.4.windows-amd64.zip",
        "go.zip",
        "178ab98950ac69ab25069307dc6ade79f3816e414cce95b4da166a115cde1e7e",
      );
      go = path.join(dir, "go", "bin", mac ? "go" : "go.exe");
    }
    const built = path.join(dir, mac ? "opencode2api" : "opencode2api.exe");
    await exec(go, ["build", "-trimpath", "-ldflags", "-s -w -X main.version=" + forkPatchBuild,
      "-o", built, "./cmd/opencode2api"], {
      cwd: source,
      timeout: 300000,
      windowsHide: true,
      env: { ...process.env, CGO_ENABLED: "0", GOWORK: "off" },
    });
    const old = await replaceGatewayBinary(s, built, version, forkPatchBuild);
    return { message: "Local gateway patch installed.", backup: old };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function verifyGatewayLauncher(s: Settings) {
  if (process.platform === "darwin" && s.launchLabel) {
    const plist = path.join(os.homedir(), "Library", "LaunchAgents", s.launchLabel + ".plist");
    if (await discoverMacBinary(plist) !== s.binary)
      throw new Error("The LaunchAgent executable does not match Manager settings.");
    const job = await command("/bin/launchctl", ["print", `gui/${process.getuid!()}/${s.launchLabel}`]);
    // Confirm this is the loaded executable before touching the live service.
    if (!job.split("\n").some(line => line.trim() === "program = " + s.binary))
      throw new Error("The loaded LaunchAgent does not start the configured gateway.");
  }
}

async function replaceGatewayBinary(s: Settings, binary: string, previous: string, expected: string) {
  await verifyGatewayLauncher(s);
  const mac = process.platform === "darwin";
  const restartInPlace = mac && !!s.launchLabel;
  const timeout = mac ? macGatewayStartupSeconds : 45;
  const log = path.join(s.root, "manager-gateway.log");
  const staged = s.binary + ".manager-" + randomBytes(6).toString("hex");
  const mode = (await stat(s.binary)).mode & 0o777;
  const old = await backup(s.binary);
  let replaced = false;
  let stopped = false;
  try {
    await copyFile(binary, staged);
    if (mac) await chmod(staged, mode);
    assertLockValid();
    if (!restartInPlace) {
      await control("stop", s, stateDir, log);
      stopped = true;
      await waitStopped();
    }
    await rename(staged, s.binary);
    replaced = true;
    await control(restartInPlace ? "restart" : "start", s, stateDir, log);
    await waitHealthy(expected, timeout);
    return old;
  } catch (cause) {
    if (!stopped && !replaced) throw cause;
    try {
      if (replaced) {
        if (!restartInPlace) {
          await control("stop", s, stateDir, log).catch(() => {});
          await waitStopped();
        }
        await copyFile(old, staged);
        if (mac) await chmod(staged, mode);
        await rename(staged, s.binary);
      }
      await control(restartInPlace ? "restart" : "start", s, stateDir, log);
      await waitHealthy(previous, timeout);
    } catch {
      throw new Error(`Gateway replacement failed and rollback could not be verified. Binary backup: ${old}`, { cause });
    }
    throw new Error(`Gateway replacement failed; previous binary restored. Binary backup: ${old}`, { cause });
  } finally {
    await rm(staged, { force: true });
  }
}

export async function restoreStockGateway() {
  if (!supportsForkPatch() || (await health())?.version !== forkPatchBuild)
    throw new Error("Start the locally patched gateway before restoring stock.");
  const s = await settings();
  await verifyGatewayLauncher(s);
  const staged = await stageRelease(forkPatchVersion);
  try {
    const old = await replaceGatewayBinary(s, staged.binary, forkPatchBuild, forkPatchVersion);
    return { message: `Stock gateway ${forkPatchVersion} restored. Provider settings were preserved.`, backup: old };
  } finally {
    await rm(staged.dir, { recursive: true, force: true });
  }
}

export async function atomic(file: string, text: string, original?: string) {
  assertLockValid();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if (original !== undefined && (await readFile(file, "utf8")) !== original)
    throw new Error("File changed during this operation. Try again.");
  const temp = file + ".manager-" + randomBytes(6).toString("hex");
  try {
    await writeFile(temp, text, { mode: 0o600, flag: "wx" });
    if (original !== undefined && (await readFile(file, "utf8")) !== original)
      throw new Error("Concurrent edit detected.");
    assertLockValid();
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}
export async function settings(): Promise<Settings> {
  const home = os.homedir(),
    legacy = path.join(home, "Documents", "Codex", "Services", "opencode2api");
  const root = existsSync(path.join(legacy, "config.json"))
    ? legacy
    : process.platform === "win32"
      ? path.join(
          process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
          "opencode2api",
        )
      : path.join(home, ".local", "share", "opencode2api");
  const oc = path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"),
    "opencode",
  );
  let saved: any = {};
  try {
    saved = JSON.parse(
      await readFile(path.join(stateDir, "settings.json"), "utf8"),
    );
  } catch {}
  const defaults: Settings = {
    root,
    binary: path.join(
      root,
      process.platform === "win32" ? "opencode2api.exe" : "opencode2api",
    ),
    configPath: path.join(root, "config.json"),
    providerPath: path.join(
      oc,
      existsSync(path.join(oc, "opencode.jsonc"))
        ? "opencode.jsonc"
        : existsSync(path.join(oc, "opencode.json"))
          ? "opencode.json"
          : "opencode.jsonc",
    ),
    launchLabel: "",
    autoSync: true,
    warpTermsAccepted: false,
    independentForkAffinity: true,
  };
  if (process.platform === "darwin" && !saved.binary) {
    const agents = path.join(home, "Library", "LaunchAgents");
    if (existsSync(agents)) {
      for (const name of await readdir(agents)) {
        if (
          !name.endsWith(".plist") ||
          !name.includes("opencode2api") ||
          name.includes("sync")
        )
          continue;
        try {
          const binary = await discoverMacBinary(path.join(agents, name));
          if (
            typeof binary === "string" &&
            path.basename(binary) === "opencode2api"
          ) {
            defaults.binary = binary;
            defaults.launchLabel = name.slice(0, -6);
            break;
          }
        } catch {}
      }
    }
  }
  return { ...defaults, ...saved };
}
export async function saveSettings(value: any) {
  const previous = await settings();
  const next = { ...previous };
  for (const key of ["root", "binary", "configPath", "providerPath"] as const) {
    if (typeof value[key] === "string") {
      if (!path.isAbsolute(value[key]))
        throw new Error(`${key} must be an absolute path.`);
      next[key] = path.normalize(value[key]);
    }
  }
  if (value.launchLabel !== undefined) {
    if (
      typeof value.launchLabel !== "string" ||
      !/^([a-zA-Z0-9_.-]{1,120})?$/.test(value.launchLabel)
    )
      throw new Error("Invalid LaunchAgent label.");
    next.launchLabel = value.launchLabel;
  }
  if (value.autoSync !== undefined) next.autoSync = value.autoSync === true;
  if (value.independentForkAffinity !== undefined) {
    if (typeof value.independentForkAffinity !== "boolean")
      throw new Error("Invalid fork affinity setting.");
    next.independentForkAffinity = value.independentForkAffinity;
  }
  if (value.warpTermsAccepted !== undefined) {
    if (typeof value.warpTermsAccepted !== "boolean")
      throw new Error("Invalid WARP terms acceptance.");
    next.warpTermsAccepted = value.warpTermsAccepted;
  }
  await atomic(
    path.join(stateDir, "settings.json"),
    JSON.stringify(next, null, 2),
  );
  return next;
}
async function request(
  url: string,
  options: RequestInit = {},
  max = 5 * 1024 * 1024,
) {
  const r = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!r.ok) throw new Error(`Request failed (HTTP ${r.status}).`);
  const bytes = await limited(r, max);
  return JSON.parse(bytes.toString("utf8"));
}
async function limited(r: Response, max: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  if (!r.body) throw new Error("Empty response.");
  for await (const x of r.body as any) {
    size += x.length;
    if (size > max) throw new Error("Download exceeds size limit.");
    chunks.push(Buffer.from(x));
  }
  return Buffer.concat(chunks);
}
export async function health() {
  try {
    return await request("http://127.0.0.1:8080/healthz");
  } catch {
    return null;
  }
}
async function gatewayKey(s: Settings) {
  const c = parseConfig(await readFile(s.configPath, "utf8"));
  const key = c.server_keys?.[0];
  if (typeof key !== "string" || !key)
    throw new Error("Gateway has no local API key.");
  return key;
}
async function catalog(s: Settings) {
  return (
    await request("http://127.0.0.1:8080/v1/models", {
      headers: { Authorization: `Bearer ${await gatewayKey(s)}` },
    })
  ).data;
}
let releaseCache: any = null;
export async function release(force = false) {
  {
    try {
      const diskCache = JSON.parse(
        await readFile(path.join(stateDir, "release.json"), "utf8"),
      );
      if (!releaseCache || diskCache.checkedAt > releaseCache.checkedAt)
        releaseCache = diskCache;
    } catch {}
  }
  if (!force && releaseCache && Date.now() - releaseCache.checkedAt < 3600000)
    return releaseCache;
  try {
    const r = await request(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "opencode2api-manager",
        },
      },
    );
    if (r.draft || r.prerelease || !/^v\d+\.\d+\.\d+$/.test(r.tag_name))
      throw new Error("No stable release found.");
    releaseCache = {
      tag: r.tag_name,
      url: `https://github.com/${REPO}/releases/tag/${r.tag_name}`,
      notes: String(r.body ?? "").slice(0, 20000),
      assets: r.assets,
      checkedAt: Date.now(),
    };
    await atomic(
      path.join(stateDir, "release.json"),
      JSON.stringify(releaseCache),
    );
    return releaseCache;
  } catch {
    if (releaseCache) return { ...releaseCache, stale: true };
    return { error: "Release check unavailable. Try again later." };
  }
}
export async function snapshot(force = false) {
  const s = await settings();
  const [h, r] = await Promise.all([health(), release(force)]);
  let warp: any = null;
  try {
    const c = parseConfig(await readFile(s.configPath, "utf8"));
    warp = c.warp ?? { enabled: false, pool_size: 2, stack: "ipv6" };
  } catch {}
  let sync: any = null;
  try {
    sync = JSON.parse(await readFile(path.join(stateDir, "sync.json"), "utf8"));
  } catch {}
  let providerAdded = false;
  try {
    const c = parseConfig(await readFile(s.providerPath, "utf8"));
    providerAdded = !!(c.providers?.opencode2api || c.provider?.opencode2api);
  } catch {}
  return {
    platform: process.platform,
    arch: process.arch,
    settings: s,
    forkPatchSupported: supportsForkPatch() &&
      (h?.version === forkPatchVersion || h?.version === forkPatchBuild),
    forkPatchInstalled: h?.version === forkPatchBuild,
    installed: existsSync(s.binary),
    configured: existsSync(s.configPath),
    providerAdded,
    health: h,
    release: {
      tag: r.tag,
      url: r.url,
      notes: r.notes,
      checkedAt: r.checkedAt,
      stale: r.stale,
      error: r.error,
    },
    updateAvailable: !!h && newer(r.tag ?? "", h.version === forkPatchBuild ? forkPatchVersion : h.version ?? ""),
    warp,
    sync,
  };
}
export async function backup(file: string) {
  const dest = path.join(
    stateDir,
    "backups",
    `${Date.now()}-${randomBytes(3).toString("hex")}-${path.basename(file)}`,
  );
  await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
  await copyFile(file, dest);
  await chmod(dest, 0o600);
  return dest;
}
export async function syncModels() {
  const s = await settings();
  const rows = await catalog(s);
  const original = await readFile(s.providerPath, "utf8");
  const merged = mergeCatalog(original, rows);
  if (merged.text !== original) {
    await backup(s.providerPath);
    await atomic(s.providerPath, merged.text, original);
  }
  const result = {
    at: new Date().toISOString(),
    providerPath: s.providerPath,
    configPath: s.configPath,
    count: merged.count,
    added: merged.added,
    changed: merged.text !== original,
  };
  await atomic(path.join(stateDir, "sync.json"), JSON.stringify(result));
  return result;
}
export async function connectProvider(legacy = false) {
  const s = await settings();
  let original = "{}\n";
  try {
    original = await readFile(s.providerPath, "utf8");
  } catch {}
  const c = parseConfig(original);
  if (c.providers?.opencode2api || c.provider?.opencode2api)
    return {
      ...(await syncModels()),
      message: "Provider already added. Models refreshed.",
    };
  const provider = legacy
    ? {
        name: "opencode2api Local",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:8080/v1" },
        models: {},
      }
    : {
        name: "opencode2api Local",
        package: "aisdk:@ai-sdk/openai-compatible",
        settings: { baseURL: "http://127.0.0.1:8080/v1" },
        models: {},
      };
  let next = edit(
    original,
    [legacy ? "provider" : "providers", "opencode2api"],
    provider,
  );
  next = mergeCatalog(next, await catalog(s)).text;
  if (existsSync(s.providerPath)) await backup(s.providerPath);
  await atomic(
    s.providerPath,
    next,
    existsSync(s.providerPath) ? original : undefined,
  );
  return {
    message:
      "Provider and models configured. Connect its local key once in Settings → Providers or OpenCode /connect.",
  };
}
export async function readLocalKey() {
  return { key: await gatewayKey(await settings()) };
}
export async function serviceControl(action: "start" | "stop" | "restart") {
  const s = await settings();
  if (!existsSync(s.binary))
    throw new Error("Gateway not installed. Use Install first.");
  await control(action, s, stateDir, path.join(s.root, "manager-gateway.log"));
  if (action !== "stop") await waitHealthy(undefined, process.platform === "darwin" ? macGatewayStartupSeconds : 45);
  return { message: `Gateway ${action} completed.` };
}
async function waitStopped() {
  for (let i = 0; i < 50; i++) {
    if (!(await health())) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Gateway did not stop.");
}
async function waitHealthy(version?: string, seconds = 45) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const h = await health();
    if (h?.ready && (!version || h.version === version)) return h;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `Gateway did not become ready within ${seconds} seconds. Check logs.`,
  );
}
export async function setWarp(value: any) {
  if (
    typeof value.enabled !== "boolean" ||
    !Number.isInteger(value.poolSize) ||
    value.poolSize < 1 ||
    value.poolSize > 32 ||
    !["ipv6", "ipv4", "dual"].includes(value.stack)
  )
    throw new Error("Invalid WARP settings.");
  const s = await settings();
  if (value.enabled && value.acceptWarpTerms !== true && !s.warpTermsAccepted)
    throw new Error(
      "Read and accept Cloudflare WARP terms before enabling its tunnel.",
    );
  const old = await readFile(s.configPath, "utf8");
  const c = parseConfig(old);
  const next = edit(old, ["warp"], {
    ...c.warp,
    enabled: value.enabled,
    pool_size: value.poolSize,
    stack: value.stack,
    source_ipv6: c.warp?.source_ipv6 ?? "",
  });
  await backup(s.configPath);
  await atomic(s.configPath, next, old);
  try {
    await serviceControl("restart");
  } catch (error) {
    await atomic(s.configPath, old);
    const reason = error instanceof Error ? error.message : "Unknown restart error.";
    try {
      await serviceControl("restart");
    } catch (restoreError) {
      const detail = restoreError instanceof Error ? restoreError.message : "Unknown restart error.";
      throw new Error(
        `WARP change failed: ${reason} Previous configuration restored, but restarting it also failed: ${detail}`,
      );
    }
    throw new Error(
      `WARP change failed: ${reason} Previous configuration restored and gateway restarted.`,
    );
  }
  return { message: "WARP settings saved and gateway restarted." };
}
async function download(url: string, max: number, extraHosts: string[] = []) {
  let current = url;
  for (let i = 0; i < 6; i++) {
    const u = new URL(current);
    if (
      u.protocol !== "https:" ||
      ![
        "github.com",
        "release-assets.githubusercontent.com",
        "objects.githubusercontent.com",
        ...extraHosts,
      ].includes(u.hostname)
    )
      throw new Error("Unexpected release download host.");
    const r = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(120000),
    });
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      current = new URL(r.headers.get("location") ?? "", current).href;
      continue;
    }
    if (!r.ok) throw new Error(`Release download failed (${r.status}).`);
    return limited(r, max);
  }
  throw new Error("Too many download redirects.");
}
export async function stageRelease(version?: string) {
  const r = version ? { tag: version, stale: false, assets: undefined } : await release(true);
  if (!r.tag || r.stale)
    throw new Error("Cannot update without a fresh release check.");
  const name = assetName(process.platform, process.arch, r.tag);
  if (!version && (
    !r.assets?.some((a: any) => a.name === name) ||
    !r.assets?.some((a: any) => a.name === name + ".sha256")
  ))
    throw new Error("No official archive/checksum for this platform.");
  const base = `https://github.com/${REPO}/releases/download/${r.tag}/`;
  const bytes = await download(base + name, 150 * 1024 * 1024);
  const sum = (await download(base + name + ".sha256", 4096))
    .toString("utf8")
    .trim()
    .split(/\s+/)[0];
  if (
    !/^[a-fA-F0-9]{64}$/.test(sum ?? "") ||
    createHash("sha256").update(bytes).digest("hex") !== sum!.toLowerCase()
  )
    throw new Error("Checksum verification failed.");
  const dir = path.join(stateDir, "staging", randomBytes(8).toString("hex"));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const archive = path.join(dir, name);
  await writeFile(archive, bytes);
  const out = path.join(dir, "unpacked");
  await mkdir(out);
  if (process.platform === "win32")
    await ps(
      'Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead($env:OC2_ARCHIVE); try { foreach($e in $z.Entries) { if($e.FullName -match "(^[/\\\\]|^[A-Za-z]:|(^|[/\\\\])\\.\\.([/\\\\]|$))") { throw "Unsafe ZIP path" } } } finally { $z.Dispose() }; Expand-Archive -LiteralPath $env:OC2_ARCHIVE -DestinationPath $env:OC2_DEST',
      { OC2_ARCHIVE: archive, OC2_DEST: out },
    );
  else {
    const entries = (await command("tar", ["-tzf", archive])).split("\n");
    validateArchiveEntries(entries);
    const verbose = await command("tar", ["-tvzf", archive]);
    if (verbose.split("\n").some((x) => /^[lh]/.test(x)))
      throw new Error("Archive links are not supported.");
    await command("tar", ["-xzf", archive, "-C", out]);
  }
  async function find(dir: string): Promise<string[]> {
    let found: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink())
        throw new Error("Archive contains a symbolic link.");
      if (e.isDirectory()) found.push(...(await find(p)));
      else if (
        e.name ===
        (process.platform === "win32" ? "opencode2api.exe" : "opencode2api")
      )
        found.push(p);
    }
    return found;
  }
  const bins = await find(out);
  if (bins.length !== 1)
    throw new Error("Archive must contain exactly one gateway binary.");
  if (process.platform !== "win32") await chmod(bins[0]!, 0o755);
  return { binary: bins[0]!, version: r.tag, dir };
}
export async function install() {
  const s = await settings();
  if (existsSync(s.binary) || existsSync(s.configPath))
    throw new Error(
      "Existing installation/config detected. Use Update or configure its paths instead.",
    );
  if (await health())
    throw new Error("Port 8080 already has a running gateway.");
  const staged = await stageRelease();
  await mkdir(s.root, { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(s.binary), { recursive: true });
  await copyFile(staged.binary, s.binary);
  if (process.platform !== "win32") await chmod(s.binary, 0o755);
  const c = {
    listen: "127.0.0.1:8080",
    server_keys: ["oc2-" + randomBytes(32).toString("hex")],
    zen_keys: [],
    go_keys: [],
    anonymous: true,
    proxies: ["direct"],
    models: { refresh_seconds: 300, free_only: true, active_probes: false },
    retry: { max_attempts: 3, timeout_seconds: 300 },
    warp: { enabled: false, pool_size: 4, stack: "ipv6", source_ipv6: "" },
    webui: { enabled: false },
  };
  await atomic(s.configPath, JSON.stringify(c, null, 2) + "\n");
  await saveSettings(s);
  await control("start", s, stateDir, path.join(s.root, "manager-gateway.log"));
  await waitHealthy(staged.version);
  await rm(staged.dir, { recursive: true, force: true });
  return {
    message:
      "Installed and started. Next: Add provider, then connect its local key. WARP starts off; enable it separately after accepting its terms.",
  };
}
export async function update() {
  const s = await settings();
  if (!existsSync(s.binary)) return install();
  if (!(await health()))
    throw new Error(
      "Start the gateway before updating so rollback can be verified.",
    );
  const staged = await stageRelease();
  const oldVersion = (await health())?.version;
  if ((oldVersion === forkPatchBuild ? forkPatchVersion : oldVersion) === staged.version) {
    await rm(staged.dir, { recursive: true, force: true });
    return { message: "Already up to date." };
  }
  await backup(s.configPath);
  const old = await backup(s.binary);
  const replacement = s.binary + ".manager-new";
  await copyFile(staged.binary, replacement);
  if (process.platform !== "win32") await chmod(replacement, 0o755);
  try {
    await control(
      "stop",
      s,
      stateDir,
      path.join(s.root, "manager-gateway.log"),
    );
    await rename(replacement, s.binary);
    await control(
      "start",
      s,
      stateDir,
      path.join(s.root, "manager-gateway.log"),
    );
    await waitHealthy(staged.version);
  } catch {
    try {
      await control(
        "stop",
        s,
        stateDir,
        path.join(s.root, "manager-gateway.log"),
      );
    } catch {}
    await copyFile(old, s.binary);
    if (process.platform !== "win32") await chmod(s.binary, 0o755);
    try {
      await control(
        "start",
        s,
        stateDir,
        path.join(s.root, "manager-gateway.log"),
      );
      await waitHealthy(oldVersion);
    } catch {
      throw new Error(
        "Update failed; old binary restored but restart needs attention.",
      );
    }
    throw new Error("Update failed; previous binary restored and restarted.");
  } finally {
    await rm(replacement, { force: true });
    await rm(staged.dir, { recursive: true, force: true });
  }
  return { message: `Updated to ${staged.version}.` };
}
async function gatewayLogTail(limit: number) {
  const s = await settings();
  const file = existsSync(path.join(s.root, "service.log"))
    ? path.join(s.root, "service.log")
    : path.join(s.root, "manager-gateway.log");
  const f = await open(file, "r");
  try {
    const size = (await f.stat()).size;
    const buffer = Buffer.alloc(Math.min(size, limit));
    const { bytesRead } = await f.read(buffer, 0, buffer.length, size - buffer.length);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await f.close();
  }
}
export async function warpPool() {
  const h = await health();
  if (!h?.warp) return { counts: null, observations: null };
  const { active, standby, cooling } = h.warp;
  const log = await gatewayLogTail(1024 * 1024).catch(() => "");
  return {
    counts: { active, standby, cooling },
    observations: h.version === "v1.4.7" && log ? warpObservations(log) : null,
  };
}
export async function logs() {
  try {
    const rows = (await gatewayLogTail(64000))
      .split("\n")
      .slice(-100)
      .flatMap((line) => {
        try {
          const x = JSON.parse(line);
          return [
            {
              time: x.time,
              level: x.level,
              event: x.event,
              component: x.component,
              status: x.status,
              model: x.model,
              attempts: x.attempts,
              duration_ms: x.duration_ms,
              outcome: x.outcome,
            },
          ];
        } catch {
          return [];
        }
      });
    return { rows };
  } catch {
    return { rows: [], message: "No structured gateway logs yet." };
  }
}
export async function exclusive<T>(fn: () => Promise<T>) {
  return withManagerLock(stateDir, fn);
}
