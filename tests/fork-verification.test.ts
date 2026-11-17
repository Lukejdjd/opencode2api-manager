import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { verifyForkFile, matchForkSource } from "../service/fork-verification";
import { patchForkSource } from "../service/manager";

const original = (await readFile(new URL("./fixtures/fork-request.go", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const file = "internal/identity/request.go";
const routing = JSON.parse(await readFile(new URL("./fixtures/fork-routing.json", import.meta.url), "utf8"));

test("future release source qualifies by content without a version allowlist", () => {
  expect(matchForkSource(routing)).toBe("v1.5.0");
  expect(() => matchForkSource({ ...routing, [file]: original + "// changed" })).toThrow("needs patch review");
  expect(() => matchForkSource({ ...routing, "internal/gateway/warp.go": "" })).toThrow("needs patch review");
  expect(() => matchForkSource({ [file]: original })).toThrow("needs patch review");
});

test("reviewed releases accept the same pristine identity implementation", () => {
  for (const version of ["v1.4.7", "v1.4.8", "v1.5.0"])
    expect(() => verifyForkFile(version, file, original)).not.toThrow();
  expect(() => verifyForkFile("v1.4.9", file, original)).toThrow("needs patch review");
});

test("changed identity and already patched source are refused", () => {
  const changed = original.replace('r.Header.Get("x-opencode-session"),', 'r.Header.Get("different-session"),');
  expect(() => patchForkSource(changed, false, "")).toThrow("needs patch review");
  const patched = patchForkSource(original, false, "");
  expect(() => patchForkSource(patched, false, "")).toThrow("needs patch review");
  expect(() => verifyForkFile("v1.5.0", "internal/gateway/upstream.go", original)).toThrow("needs patch review");
});

test("platform patches accept CRLF source and preserve platform toggle behavior", () => {
  expect(patchForkSource(original.replace(/\n/g, "\r\n"), false, "")).toContain('os.Getenv("OPENCODE2API_INDEPENDENT_FORK_AFFINITY")');
  expect(patchForkSource(original, true, "/tmp/manager/settings.json")).toContain('os.ReadFile("/tmp/manager/settings.json")');
});
