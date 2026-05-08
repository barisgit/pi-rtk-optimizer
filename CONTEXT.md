# RTK Optimizer

This context defines the language for Pi integration with RTK. It keeps the package boundary clear: this project owns RTK optimization behavior, while other extensions own their own tool domains. The package remains named `pi-rtk-optimizer`.

## Language

**RTK Optimization**:
Token-oriented command rewriting and output compaction provided by RTK.
_Avoid_: Remote execution, SSH behavior

**Eligible Tool Call**:
A Pi tool call whose command or output may be optimized by RTK under this extension's rules.
_Avoid_: Every tool call, all tools

**Local Bash Rewrite**:
Using `rtk rewrite` to replace a local bash command before it runs.
_Avoid_: Local pipe compaction

**Remote Bash Pipe Compaction**:
Using local `rtk pipe` to compact output from a remote bash command after it runs.
_Avoid_: Remote rewrite

**Raw Output Escape Hatch**:
A user or agent request to bypass RTK optimization for upcoming eligible tool calls.
_Avoid_: Disable remote SSH, disable bash, per-command env flags

**RTK Control Tool**:
A model-callable tool named `rtk` that controls RTK optimization state for future tool calls.
_Avoid_: Human `/rtk` command, shell wrapper

**Disable Budget**:
The count of upcoming non-RTK-control tool calls that should bypass RTK optimization.
_Avoid_: Eligible-only counter, hidden eligibility counter

## Relationships

- **RTK Optimization** applies only to **Eligible Tool Calls**.
- Heuristic/non-RTK compaction techniques and their config flags are removed from the active product surface, not kept as fallback.
- Configuration names the three RTK paths explicitly: `localBashRewrite`, `remoteBashPipeCompaction`, and `builtinPipeCompaction`.
- Defaults enable local bash rewrite mode, remote bash pipe compaction, and builtin pipe compaction for `grep` and `find`.
- Suggest mode exists only for local bash rewrite; pipe compaction has no suggest mode.
- Builtin `grep` and `find` outputs use direct tool-name pipe filters: `grep` maps to `rtk pipe -f grep`, and `find` maps to `rtk pipe -f find`.
- `builtinPipeCompaction.tools` can only enable implemented builtin filters; unknown/unimplemented tool names are rejected in validation/settings UI or ignored with a `/rtk` warning when hand-edited, rather than creating dynamic behavior.
- Builtin `ls` is not optimized in v1 because current RTK has no `ls` pipe filter.
- Builtin `read` remains untouched unless explicitly revisited.
- **Local Bash Rewrite** is the only RTK behavior for local bash; local bash output is never post-piped, even when rewrite mode is off.
- **Remote Bash Pipe Compaction** never requires RTK to be installed on the remote host.
- Remote-side RTK detection/rewrite is out of scope for v1; remote RTK support may be added later.
- **Remote Bash Pipe Compaction** uses local `rtk rewrite` as a classifier for the original remote command, then maps the rewritten RTK command shape to a known `rtk pipe -f` filter.
- If `rtk rewrite` does not classify a remote bash command, the original output is kept.
- If `rtk pipe -f <filter>` exits non-zero, the original output is kept and only internal debug state should record the warning.
- Human-visible stats may report real RTK rewrite/pipe activity, but must not report removed heuristic compaction metrics.
- If the RTK binary is missing, no rewrite or pipe compaction occurs, but the **RTK Control Tool** still exists and reports RTK inactive.
- A **Raw Output Escape Hatch** bypasses all three RTK paths without changing remote execution behavior.
- A **Raw Output Escape Hatch** is controlled through the **RTK Control Tool**, not shell environment flags.
- The human `/rtk` UI shows the current **Disable Budget** when non-zero.
- A **Disable Budget** is consumed by all following tool calls except the **RTK Control Tool** itself.

## Example dialogue

> **Dev:** "Should the remote SSH extension own the RTK disable flag because it wraps bash?"
> **Domain expert:** "No — remote SSH owns where tools run; RTK Optimizer owns whether eligible outputs are optimized. Use a raw output escape hatch in RTK Optimizer instead."

## Flagged ambiguities

- "Disable RTK" means bypass **RTK Optimization**, not disable remote SSH or change how Pi tools execute.
- Direct pipe mapping is for **Remote Bash Pipe Compaction** and builtin search outputs, not for local bash.
- Removed heuristic compaction config such as `groupSearchOutput`, `compactGitOutput`, and `aggregateTestOutput` should not remain as active settings.
- The human `/rtk` command remains separate from the model-callable **RTK Control Tool**.
- The **RTK Control Tool** is named `rtk` and supports `action: "disable"` with `n` and `action: "enable"` to clear the budget.
- `action: "disable"` accepts `n` up to 20 and replaces the current **Disable Budget** instead of adding to it.
- `action: "enable"` reports the cleared budget count, and `action: "disable"` reports how many upcoming tool calls will bypass RTK.
- The **Disable Budget** counts all subsequent tool calls except calls to the **RTK Control Tool** itself, because agents cannot reliably know which calls are RTK-eligible.
- The **Disable Budget** decrements at tool-call start, even if the tool later fails.
- Parallel tool calls each consume budget in Pi dispatch order.
- Budgeted skips do not show UI notifications by default; the **RTK Control Tool** result is the user-visible status.
- The **Disable Budget** persists across turns until consumed or cleared, but is only in-memory and not restored across Pi reload/restart/resume.
