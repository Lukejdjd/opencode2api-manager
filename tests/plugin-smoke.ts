// Load the built package through both real OpenCode hosts, without inference.
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";
const require = createRequire(import.meta.url);
function binary(version: 1 | 2) {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const pkg =
    version === 2
      ? `@opencode/cli-${platform}-${process.arch}`
      : `opencode-${platform}-${process.arch}`;
  return path.join(
    path.dirname(require.resolve(pkg + "/package.json")),
    "bin",
    process.platform === "win32" ? "opencode.exe" : "opencode",
  );
}
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "oc2-native-plugins-")));
let success = false;
try {
  const pkg = path.join(root, "packed-plugin");
  await mkdir(path.join(pkg, "plugin"), { recursive: true });
  await cp("plugin/index.js", path.join(pkg, "plugin", "index.js"));
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  await writeFile(
    path.join(pkg, "package.json"),
    JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      type: manifest.type,
      main: manifest.main,
      exports: manifest.exports,
    }),
  );
  for (const version of ([1, 2] as const).filter(v => !process.argv[2] || String(v) === process.argv[2])) {
    const testRoot = path.join(root, `v${version}`);
    const project = path.join(testRoot, "project");
    const configDir = path.join(testRoot, "config", "opencode");
    const state = path.join(testRoot, "manager");
    await mkdir(configDir, { recursive: true });
    await mkdir(project, { recursive: true });
    await mkdir(state, { recursive: true });
    const config = path.join(configDir, "opencode.json");
    await writeFile(
      config,
      JSON.stringify(
        version === 1
          ? { plugin: [[pkg, { sync: false, check: false }]] }
          : {
              plugins: [
                { package: pkg, options: { sync: false, check: false } },
              ],
            },
      ),
    );
    await writeFile(
      path.join(state, "settings.json"),
      JSON.stringify({
        root: project,
        binary: path.join(project, "unused"),
        configPath: path.join(project, "gateway.json"),
        providerPath: config,
        launchLabel: "",
        autoSync: false,
      }),
    );
    const password = randomBytes(16).toString("hex");
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      ...(process.platform === "win32"
        ? {
            SystemRoot: process.env.SystemRoot,
            COMSPEC: process.env.COMSPEC,
            APPDATA: process.env.APPDATA,
            LOCALAPPDATA: process.env.LOCALAPPDATA,
            TEMP: process.env.TEMP,
          }
        : {}),
      XDG_CONFIG_HOME: path.join(testRoot, "config"),
      XDG_DATA_HOME: path.join(testRoot, "data"),
      XDG_STATE_HOME: path.join(testRoot, "state"),
      XDG_CACHE_HOME: path.join(testRoot, "cache"),
      OPENCODE_CONFIG: config,
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENCODE_DB: path.join(testRoot, "test.db"),
      OPENCODE_PASSWORD: password,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE2API_MANAGER_DATA_DIR: state,
    };
    const child = spawn(
      binary(version),
      [
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        "0",
        "--log-level",
        version === 1 ? "DEBUG" : "debug",
        "--print-logs",
      ],
      {
        cwd: project,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let output = "";
    child.stdout.on("data", (x) => (output += x));
    child.stderr.on("data", (x) => (output += x));
    child.on("error", (e) => (output += e.message));
    try {
      const deadline = Date.now() + 60000;
      let base = "";
      let activated = false;
      let lastResponse = "";
      let initialized = false;
      while (Date.now() < deadline) {
        if (child.exitCode !== null)
          throw new Error(`V${version} exited: ${output.slice(-3000)}`);
        base = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? "";
        if (base) {
          try {
            if (!initialized) {
              const r = await fetch(
                base +
                  (version === 1
                    ? "/session?directory=" + encodeURIComponent(project)
                    : "/api/session"),
                {
                  method: "POST",
                  headers: {
                    Authorization:
                      "Basic " +
                      Buffer.from("opencode:" + password).toString("base64"),
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify(
                    version === 1
                      ? { title: "Plugin smoke" }
                      : {
                          location: { directory: project },
                          title: "Plugin smoke",
                        },
                  ),
                  signal: AbortSignal.timeout(20000),
                },
              );
              const configResponse = await fetch(
                base +
                  (version === 1
                    ? "/config?directory=" + encodeURIComponent(project)
                    : "/api/config?location%5Bdirectory%5D=" +
                      encodeURIComponent(project)),
                {
                  headers: {
                    Authorization:
                      "Basic " +
                      Buffer.from("opencode:" + password).toString("base64"),
                  },
                },
              );
              await writeFile(
                path.join(testRoot, "effective-config.json"),
                await configResponse.text(),
              );
              initialized = true;
            }
            const endpoint =
              version === 1
                ? `/provider?directory=${encodeURIComponent(project)}`
                : `/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(project)}`;
            const response = await fetch(base + endpoint, {
              headers: {
                Authorization:
                  "Basic " +
                  Buffer.from("opencode:" + password).toString("base64"),
              },
              signal: AbortSignal.timeout(3000),
            });
            const responseText = await response.text();
            lastResponse = response.status + " " + responseText.slice(0, 1600);
            const record = JSON.parse(
              await readFile(path.join(state, "maintenance.json"), "utf8"),
            );
            if (record.lastSource === `opencode-v${version}`) {
              const inventory = version === 2 ? JSON.parse(responseText) : null;
              if (version === 1 || inventory?.data?.some(
                (p: any) => p.id === "opencode2api-manager" && p.state?.status === "active",
              )) {
                activated = true;
                break;
              }
            }
          } catch {}
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      if (!activated)
        throw new Error(
          `V${version} did not activate the plugin. Last API: ${lastResponse} Logs: ${output.slice(-4500)}`,
        );
      console.log(
        `PASS: built package activated through real OpenCode ${version === 1 ? "1.18.29 (server)" : "2.2.3 (setup)"}; no inference or service mutation`,
      );
    } finally {
      child.kill();
      await Promise.race([
        new Promise((r) => child.once("exit", r)),
        new Promise((r) => setTimeout(r, 4000)),
      ]);
      await writeFile(path.join(testRoot, "host.log"), output);
    }
  }
  success = true;
} finally {
  if (success) await rm(root, { recursive: true, force: true });
  else console.error("Isolated test diagnostics:", root);
}
