# RTK optimization boundaries

RTK optimization belongs in `pi-rtk-optimizer`, while `pi-remote-ssh` remains responsible only for where tools execute. The extension uses RTK-owned mechanisms directly: local bash is optimized only through `rtk rewrite`, remote bash output is optionally compacted locally through `rtk pipe` after classification by local `rtk rewrite`, and builtin `grep`/`find` output is piped by exact tool identity.

## Considered options

- Put RTK controls in `pi-remote-ssh`: rejected because RTK optimization is not remote execution, and coupling it to SSH would make the remote extension own unrelated local behavior.
- Add per-tool disable parameters or shell env flags: rejected because they require schema/tool-surface changes across unrelated tools or command-string parsing.
- Keep heuristic compactors as fallback: rejected because RTK should own compaction behavior; heuristic/non-RTK compaction and its config surface should be removed.

## Consequences

A model-callable `rtk` control tool owns the raw-output escape hatch with `action: "disable"` and `action: "enable"`. The disable budget counts all subsequent tool calls except the `rtk` control tool itself, because agents cannot reliably know which calls are RTK-eligible. Remote-side RTK detection/rewrite is intentionally out of scope for v1 and can be added later as a separate decision.
