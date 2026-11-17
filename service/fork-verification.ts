import { createHash } from "node:crypto";
import manifest from "./fork-source-manifest";

export function verifyForkFile(version: string, file: string, source: string) {
  const files = manifest[version as keyof typeof manifest];
  const expected = files?.[file as keyof typeof files];
  const actual = createHash("sha256").update(source.replace(/\r\n/g, "\n")).digest("hex");
  if (!expected || actual !== expected)
    throw new Error("This gateway version needs patch review. Session routing source changed or is unverified: " + file);
}

export const forkSourceFiles = Object.keys(manifest["v1.5.0"]);

export const forkBehaviorTest = `package identity

import (
  "net/http/httptest"
  "testing"
)

func TestManagerForkAffinity(t *testing.T) {
  parent := CanonicalSessionID("manager-parent")
  fork := CanonicalSessionID("manager-fork")
  for _, tc := range []struct { name, enabled, parentHeader, want string }{
    {"fork", "1", "", fork},
    {"disabled", "0", "", parent},
    {"subagent", "1", "x-parent-session-id", parent},
    {"opencode-subagent", "1", "x-opencode-parent-session-id", parent},
  } {
    t.Run(tc.name, func(t *testing.T) {
      t.Setenv("OPENCODE2API_INDEPENDENT_FORK_AFFINITY", tc.enabled)
      r := httptest.NewRequest("POST", "/", nil)
      r.Header.Set("x-opencode-session", parent)
      r.Header.Set("x-opencode-session-id", fork)
      if tc.parentHeader != "" { r.Header.Set(tc.parentHeader, parent) }
      first := DeriveRequestIDs(r, map[string]any{}, "manager")
      second := DeriveRequestIDs(r, map[string]any{}, "manager")
      if first.Session != tc.want || second.Session != tc.want {
        t.Fatalf("unexpected affinity: %s / %s; want %s", first.Session, second.Session, tc.want)
      }
    })
  }
}
`;
