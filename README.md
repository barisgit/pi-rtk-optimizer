# pi-rtk-optimizer

[![npm version](https://img.shields.io/npm/v/pi-rtk-optimizer?style=flat-square)](https://www.npmjs.com/package/pi-rtk-optimizer) [![License](https://img.shields.io/github/license/MasuRii/pi-rtk-optimizer?style=flat-square)](LICENSE)

> RTK command rewriting and RTK pipe compaction extension for the Pi coding agent.

**pi-rtk-optimizer** integrates Pi with the installed `rtk` CLI while keeping RTK as the source of truth. Local bash commands can be rewritten before execution through `rtk rewrite`; remote bash and builtin `grep`/`find` results can be compacted after execution through local `rtk pipe`.

## Features

### Local bash rewrite

- Rewrites local `bash` commands through `rtk rewrite` in `rewrite` mode.
- Supports `suggest` mode for notifications without mutation.
- Leaves local bash output unpiped; local bash is rewrite-only or nothing.
- Skips rewrite when the command already starts with `rtk`.
- Uses a runtime guard when the `rtk` binary is unavailable.

### Remote bash pipe compaction

- Never rewrites remote bash commands in v1.
- Does not require RTK on the remote host.
- Classifies the original remote command with local `rtk rewrite`.
- Derives a known `rtk pipe -f <filter>` from the rewritten RTK command shape.
- Keeps original output when classification fails or `rtk pipe` exits non-zero.

### Builtin pipe compaction

Builtin pipe compaction is available but disabled by default because Pi builtin tools already apply limits and structured formatting.

- Builtin `grep` can map to `rtk pipe -f grep` when explicitly enabled.
- Builtin `find` can map to `rtk pipe -f find` when explicitly enabled.
- Builtin `read` is untouched.
- Builtin `ls` is untouched in v1 because RTK has no `ls` pipe filter.

### Model-callable control tool

The extension registers a model-callable `rtk` tool:

```text
rtk({ action: "disable", n: 3 })
rtk({ action: "enable" })
```

`disable` bypasses all RTK optimization for the next `n` tool calls, where `n` is 1 through 20. The budget counts all subsequent tool calls except the `rtk` control tool itself. `enable` clears the budget early.

Use this when raw, unoptimized output is required.

### Human command

The `/rtk` slash command remains the human settings/status surface.

## Installation

### Local extension folder

Place this folder in one of the following locations:

```text
~/.pi/agent/extensions/pi-rtk-optimizer
$PI_CODING_AGENT_DIR/extensions/pi-rtk-optimizer
.pi/extensions/pi-rtk-optimizer
```

Pi auto-discovers extensions in these paths on startup.

### npm package

```bash
pi install npm:pi-rtk-optimizer
```

### Git repository

```bash
pi install git:github.com/MasuRii/pi-rtk-optimizer
```

## Usage

Open the interactive settings modal:

```text
/rtk
```

Subcommands:

| Command | Description |
|---------|-------------|
| `/rtk` | Open settings modal |
| `/rtk show` | Display current configuration, runtime status, and disable budget |
| `/rtk path` | Show config file path |
| `/rtk verify` | Check whether `rtk` binary is available |
| `/rtk stats` | Show RTK rewrite/pipe activity metrics for the current session |
| `/rtk clear-stats` | Reset RTK activity metrics |
| `/rtk reset` | Reset all settings to defaults |
| `/rtk help` | Display usage help |

## Configuration

Configuration is stored at:

```text
Default global path: ~/.pi/agent/extensions/pi-rtk-optimizer/config.json
Actual global path: $PI_CODING_AGENT_DIR/extensions/pi-rtk-optimizer/config.json when PI_CODING_AGENT_DIR is set
```

A starter template is included at `config/config.example.json`.

### Configuration options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch for RTK optimization |
| `guardWhenRtkMissing` | boolean | `true` | Bypass RTK paths when the local `rtk` binary is unavailable |
| `localBashRewrite.mode` | string | `"rewrite"` | `"rewrite"` or `"suggest"` for local bash only |
| `localBashRewrite.showNotifications` | boolean | `true` | Show rewrite notices in TUI |
| `remoteBashPipeCompaction.enabled` | boolean | `true` | Compact remote bash output through local `rtk pipe` when classified |
| `builtinPipeCompaction.enabled` | boolean | `false` | Compact implemented builtin tool outputs through local `rtk pipe` |
| `builtinPipeCompaction.tools` | string[] | `["grep", "find"]` | Implemented builtin filters to enable |

Unknown builtin tool names are ignored by normalization; only implemented filters can be enabled.

### Example configuration

```json
{
  "enabled": true,
  "guardWhenRtkMissing": true,
  "localBashRewrite": {
    "mode": "rewrite",
    "showNotifications": true
  },
  "remoteBashPipeCompaction": {
    "enabled": true
  },
  "builtinPipeCompaction": {
    "enabled": false,
    "tools": ["grep", "find"]
  }
}
```

Legacy `mode`, `showRewriteNotifications`, and `outputCompaction.enabled` are normalized into the new explicit config shape for compatibility.

## Technical details

### Architecture

```text
index.ts                       # Pi auto-discovery entrypoint
src/
├── index.ts                   # Extension bootstrap, hooks, and model-callable rtk tool
├── config-store.ts            # Config load/save with normalization
├── config-modal.ts            # TUI settings modal and /rtk handler
├── command-rewriter.ts        # Local bash rewrite decision adapter
├── rtk-rewrite-provider.ts    # Calls rtk rewrite
├── output-compactor.ts        # RTK pipe-only result compaction
├── output-metrics.ts          # RTK rewrite/pipe activity tracking
├── runtime-guard.ts           # Runtime availability guard helpers
├── rtk-command-environment.ts # RTK_DB_PATH scoping for rewritten commands
├── rewrite-pipeline-safety.ts # Shell-safety fixups for rewritten commands
├── shell-env-prefix.ts        # Environment assignment parsing helpers
└── tool-execution-sanitizer.ts# Strips RTK self-diagnostics from streamed bash output
```

### Event hooks

- `tool_call`: consumes disable budget and rewrites eligible local bash commands.
- `tool_result`: applies RTK pipe compaction to eligible remote bash and builtin `grep`/`find` outputs.
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`: tracks bash commands for streamed RTK self-diagnostic cleanup.
- `before_agent_start`: refreshes RTK runtime status.
- `session_start` / `agent_end`: refreshes config and clears in-session tracking state.
- Registered `/rtk` command: handles settings, status, verification, stats, and reset.
- Registered `rtk` tool: lets the model disable or re-enable RTK optimization for raw-output workflows.

## Development

```bash
npm run typecheck
npm test
npm run check
```

## License

MIT
