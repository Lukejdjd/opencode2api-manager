# Gateway v1.5.1 fork-routing review

The reviewed source is the official v1.5.1 tag (release commit 6575c62).
The source ZIP SHA-256 is pinned in the Manager installer.

Compared with reviewed v1.5.0:
- internal/identity/request.go is byte-identical. The stable session, child session, and explicit parent handling are unchanged.
- upstream.go and warp.go pass the per-request environment to body shaping.
- gateway.go validates and strips client_environment before identity derivation and protocol conversion.
- rotation.go passes request context to body shaping.
- withClientEnvironment uses r.WithContext and removes only client_environment. It does not modify session headers or the history used for identity derivation.

The manifest adds exact hashes for all five reviewed routing files.
The v1.5.1 fixture must match this set and rejects changes to any guarded file.
The existing patch can be applied without changing the fork/subagent distinction.
The local installer runs enabled, disabled and explicit-parent behavior tests
before building and deploying, with executable backup and health-check rollback.

This review does not claim to remove upstream usage limits.
