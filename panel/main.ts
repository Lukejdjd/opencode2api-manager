import { connectHost } from "@openchamber/sdk";
import {
  applyHostReady,
  mountButton,
  mountTextField,
  mountSelect,
  mountCheckbox,
  mountSwitch,
} from "@openchamber/sdk/ui";
const host = connectHost();
const root = document.querySelector<HTMLElement>("#root")!;
let mounted = false;
let current: any = null;
let busy = false;
let operationTimer: ReturnType<typeof setTimeout> | null = null;
function element(tag: string, text = "", parent: HTMLElement = root, cls = "") {
  const e = document.createElement(tag);
  e.textContent = text;
  if (cls) e.className = cls;
  parent.append(e);
  return e;
}
async function request(path: string, body?: any) {
  const r = await host.serviceRequest({
    method: body === undefined ? "GET" : "POST",
    path,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const d = JSON.parse(r.body);
  if (r.status >= 400) throw new Error(d.message ?? "Request failed.");
  return d;
}
function button(
  parent: HTMLElement,
  label: string,
  fn: () => Promise<void>,
  variant: any = "outline",
  disabled = false,
) {
  return mountButton(parent, {
    label,
    variant,
    disabled: busy || disabled,
    onClick: () =>
      void fn().catch((error) =>
        host.toast({ kind: "error", message: error.message }),
      ),
  });
}
async function refresh(force = false) {
  current = await request(
    force ? "/check" : "/snapshot",
    force ? {} : undefined,
  );
  busy = current.job?.status === "running";
  render();
  await host.setBadge(current.updateAvailable ? 1 : null);
  if (busy && !operationTimer)
    operationTimer = setTimeout(() => {
      operationTimer = null;
      void refresh();
    }, 1500);
}
async function action(action: string, extra: any = {}) {
  await request("/action", { action, ...extra });
  await refresh();
}
function render() {
  root.replaceChildren();
  element("div", "LOCAL GATEWAY", root, "eyebrow");
  element("h1", "opencode2api Manager");
  element(
    "p",
    "Your gateway, models, and updates—in one place.",
    root,
    "muted",
  );
  const x = current;
  if (!x) return;
  const status = element("section", "", root, "card");
  const grid = element("div", "", status, "grid");
  for (const [label, value] of [
    [
      "Gateway",
      x.health?.ready ? "Connected" : x.installed ? "Stopped" : "Not installed",
    ],
    ["Installed", x.health?.version ?? "—"],
    ["Latest", x.release.tag ?? "Unavailable"],
    ["Models", String(x.health?.models?.exposed ?? "—")],
  ]) {
    const item = element("div", "", grid, "metric");
    element("span", label, item);
    element("strong", value, item);
  }
  if (x.updateAvailable)
    element(
      "div",
      `${x.release.tag} is available. Review the release notes, then update when you’re ready.`,
      status,
      "notice",
    );
  if (x.release.stale || x.release.error)
    element(
      "p",
      "Release check unavailable. Showing the last known result, if any.",
      status,
      "muted",
    );
  const controls = element("div", "", status, "actions");
  button(controls, "Refresh", () => refresh());
  button(controls, "Check updates", () => refresh(true));
  if (x.release.url)
    button(controls, "Release notes", () => host.openUrl(x.release.url));
  if (!x.installed) {
    const c = element("section", "", root, "card");
    element("h2", "First-time setup", c);
    element(
      "p",
      `Download the official ${x.platform}/${x.arch} release, verify SHA-256, create a private local key, and start on 127.0.0.1:8080. WARP starts off. No admin rights required.`,
      c,
      "muted",
    );
    button(c, "Install and start", () => action("install"));
  } else {
    const c = element("section", "", root, "card");
    element("h2", "Gateway controls", c);
    element(
      "p",
      "Restarting or updating interrupts active gateway requests. Updates keep a backup and restore the old binary if the new version fails its readiness check.",
      c,
      "muted",
    );
    const a = element("div", "", c, "actions");
    button(a, "Start", () => action("start"), "outline", !!x.health);
    button(a, "Stop", () => action("stop"), "outline", !x.health);
    button(a, "Restart", () => action("restart"), "outline", !x.health);
    button(
      a,
      "Update gateway",
      () => action("update"),
      "default",
      !x.updateAvailable,
    );
  }
  if (x.job) {
    element(
      "div",
      x.job.status === "running"
        ? `${x.job.operation} in progress…`
        : x.job.status === "error"
          ? x.job.message
          : (x.job.result?.message ?? `${x.job.operation} completed.`),
      root,
      "notice",
    );
  }
  const models = element("section", "", root, "card");
  element("h2", "OpenCode & OpenChamber models", models);
  element(
    "p",
    "Add provider connects this gateway to OpenCode and OpenChamber once. After setup, use Sync now to refresh models. Custom names, variants, and missing models are preserved.",
    models,
    "muted",
  );
  const a = element("div", "", models, "actions");
  button(
    a,
    x.providerAdded ? "Provider added" : "Add provider",
    () => action("connect"),
    "outline",
    x.providerAdded || !x.health,
  );
  button(a, "Sync now", () => action("sync"), "outline", !x.health);
  const keyBox = element("div", "", models, "notice");
  keyBox.hidden = true;
  const keyToggle = button(
    a,
    "Show local key",
    async () => {
      if (!keyBox.hidden) {
        keyBox.hidden = true;
        keyBox.replaceChildren();
        keyToggle.update({ label: "Show local key" });
        return;
      }
      keyToggle.update({ disabled: true });
      try {
        const d = await request("/local-key", {});
        keyBox.replaceChildren();
        element(
          "p",
          "Keep this key private. Connect opencode2api once in Settings → Providers or OpenCode /connect.",
          keyBox,
        );
        element("div", d.key, keyBox, "key");
        keyBox.hidden = false;
        keyToggle.update({ label: "Hide local key" });
      } finally {
        keyToggle.update({ disabled: busy || !x.configured });
      }
    },
    "outline",
    !x.configured,
  );
  mountSwitch(element("div", "", models, "setting-group"), {
    label: "Automatic model sync",
    checked: x.settings.autoSync,
    description:
      "Every five minutes while OpenChamber or the OpenCode plugin is running. Both share one sync schedule.",
    disabled: busy,
    onChange: async (value: boolean) => {
      try {
        await request("/settings", { autoSync: value });
        await refresh();
      } catch (e: any) {
        await host.toast({ kind: "error", message: e.message });
      }
    },
  });
  if (x.sync)
    element(
      "p",
      `Last sync: ${new Date(x.sync.at).toLocaleString()} · ${x.sync.count} models`,
      models,
      "muted",
    );
  const warp = element("section", "", root, "card");
  element("h2", "WARP pool", warp);
  element(
    "p",
    x.health?.warp
      ? `${x.health.warp.active ?? 0} active · ${x.health.warp.standby ?? 0} standby · ${x.health.warp.cooling ?? 0} cooling`
      : "Only gateway free-model traffic uses this tunnel; other apps keep their connection.",
    warp,
    "muted",
  );
  let enabled = x.warp?.enabled ?? false,
    pool = String(x.warp?.pool_size ?? 4),
    stack = x.warp?.stack ?? "ipv6",
    accepted = x.settings.warpTermsAccepted === true;
  const warpToggle = mountSwitch(element("div", "", warp, "setting-group"), {
    label: "Use built-in WARP",
    checked: enabled,
    onChange: (v: boolean) => {
      enabled = v;
      warpToggle.update({ checked: v });
    },
  });
  mountTextField(element("div", "", warp, "field"), {
    label: "Maximum exits (1–32)",
    value: pool,
    onChange: (v: string) => (pool = v),
  });
  const stackSelect = mountSelect(element("div", "", warp, "field"), {
    label: "Network stack",
    value: stack,
    options: [
      { id: "ipv6", label: "IPv6 (recommended)" },
      { id: "ipv4", label: "IPv4" },
      { id: "dual", label: "Dual stack" },
    ],
    onChange: (v: string) => {
      stack = v;
      stackSelect.update({ value: v });
    },
  });
  const termsToggle = mountCheckbox(element("div", "", warp, "terms-group"), {
    label: "I accept the Cloudflare WARP terms",
    description: "Saved automatically on this computer. Read the terms below.",
    checked: accepted,
    onChange: async (v: boolean) => {
      termsToggle.update({ checked: v, disabled: true });
      try {
        await request("/settings", { warpTermsAccepted: v });
        accepted = v;
        x.settings.warpTermsAccepted = v;
      } catch (error: any) {
        await host.toast({ kind: "error", message: error.message });
      } finally {
        termsToggle.update({ checked: accepted, disabled: false });
      }
    },
  });
  const wa = element("div", "", warp, "actions");
  button(wa, "Read WARP terms", () =>
    host.openUrl("https://www.cloudflare.com/application/terms/"),
  );
  button(
    wa,
    "Apply and restart",
    () =>
      action("warp", {
        enabled,
        poolSize: Number(pool),
        stack,
        acceptWarpTerms: accepted,
      }),
    "outline",
    !x.health,
  );
  element(
    "p",
    "Rate-limit responses can retry the same request on another exit before an error is returned. Exhausted exits can still fail. Started streams are not replayed.",
    warp,
    "muted",
  );
  const settings = element("details", "", root, "card");
  element("summary", "Installation paths", settings);
  const draft = { ...x.settings };
  for (const [field, label] of [
    ["root", "Gateway folder"],
    ["binary", "Gateway executable"],
    ["configPath", "Gateway configuration"],
    ["providerPath", "OpenCode configuration"],
  ]) {
    const e = element("div", "", settings, "field");
    mountTextField(e, {
      label,
      value: draft[field!],
      mono: true,
      onChange: (v: string) => (draft[field!] = v),
    });
  }
  if (x.platform === "darwin")
    mountTextField(element("div", "", settings, "field"), {
      label: "Existing LaunchAgent label (blank for manager-started process)",
      value: draft.launchLabel,
      onChange: (v: string) => (draft.launchLabel = v),
    });
  button(settings, "Save paths", async () => {
    await request("/settings", draft);
    await refresh();
  });
  const logs = element("details", "", root, "card");
  element("summary", "Recent gateway events", logs);
  button(element("div", "", logs, "actions"), "Load events", async () => {
    const d = await request("/logs");
    logs.querySelector("pre")?.remove();
    element(
      "pre",
      d.rows.map((r: any) => JSON.stringify(r)).join("\n") ||
        d.message ||
        "No events yet.",
      logs,
    );
  });
}
host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (mounted) return;
  mounted = true;
  void refresh().catch((e) => {
    root.replaceChildren();
    element("h1", "opencode2api Manager");
    element("p", e.message);
    button(root, "Retry", () => refresh());
  });
});
host.onServiceEvent(() => void refresh());
