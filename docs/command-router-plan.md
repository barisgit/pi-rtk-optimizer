# Command Router Plan

## Goal

Add a neutral pre-execution command strategy layer for Pi tool calls, without turning `pi-prune-router`, `pi-remote-ssh`, or `pi-rtk-optimizer` into god packages.

The command router answers one question before a command runs:

> Given this command and target, should Pi run it raw, through RTK, through Snip, or through another execution strategy?

Post-output pruning remains a separate concern handled by `pi-prune-router`.

## Current Architecture Assessment

Current shape is workable, not broken:

- `pi-remote-ssh` owns native SSH transport and knows how to execute commands remotely.
- `pi-prune-router` owns captured text/document pruning after execution.
- `pi-rtk-optimizer` owns RTK-specific command rewriting and the `rtk-read` prune provider.

The missing abstraction is a neutral pre-execution strategy registry. Without it, RTK/Snip/raw fallback logic will become implicit across packages.

## Boundary Model

```txt
tool_call:bash
  -> command router chooses execution strategy
  -> transport executes local or remote command
  -> tool_result optionally goes to prune router
```

### Command Router

Owns:

- command strategy registration
- priority/fallback ordering
- deciding raw vs RTK vs Snip vs future strategies
- preserving command identity before execution

Does not own:

- SSH/session mechanics
- captured-output semantic pruning
- RTK or Snip implementation details

### Transport Layer

Owned by local bash support and `pi-remote-ssh`.

Owns:

- local execution
- remote execution
- session/cwd/env/timeout handling

Does not own:

- deciding whether RTK or Snip is the best optimization strategy

### Prune Router

Owned by `pi-prune-router`.

Owns:

- captured text/document provider selection
- fallback across prune providers
- artifacts/timeouts

Does not own:

- command execution
- local/remote transport

### Strategy Providers

Examples:

- `pi-rtk-optimizer`
  - registers RTK execution strategy
  - registers `rtk-read` prune provider
- future `pi-snip-optimizer`
  - registers Snip execution strategy
- default/raw strategy
  - no package-specific dependency

## Proposed Request Shape

```ts
export interface CommandExecutionRequest {
  tool: "bash";
  command: string;
  cwd?: string;
  session?: string;
  target: "local" | "remote";
  timeoutMs?: number;
}
```

## Proposed Strategy Shape

```ts
export interface CommandStrategyRegistration {
  name: string;
  priority: number;
  canPlan(request: CommandExecutionRequest): boolean | Promise<boolean>;
  plan(request: CommandExecutionRequest): CommandExecutionPlan | Promise<CommandExecutionPlan>;
}

export interface CommandExecutionPlan {
  strategy: string;
  command: string;
  transport?: "default" | "local" | "remote";
  postPrune?: boolean;
  diagnostics?: string[];
}
```

Initial strategies:

```txt
rtk strategy   priority 100
snip strategy  priority 50   future
raw strategy   priority 0
```

## Event Sketch

Use neutral event names so the first implementation can live in whichever package currently intercepts bash, without locking ownership there forever.

```ts
export const COMMAND_REGISTER_STRATEGY_EVENT = "command:register-strategy";
export const COMMAND_UNREGISTER_STRATEGY_EVENT = "command:unregister-strategy";
export const COMMAND_PLAN_EVENT = "command:plan";
```

The implementation can start inside `pi-rtk-optimizer` or `pi-remote-ssh` if that is where the relevant hook currently lives, but the event names/types should remain command-router-neutral.

## Execution Flow

```txt
1. Bash tool call arrives.
2. Build CommandExecutionRequest from original input.
3. Ask registered strategies in priority order for a plan.
4. Execute the chosen plan using the normal local/remote transport.
5. If output is still too large/noisy, send captured result to pi-prune-router.
```

Important: RTK/Snip execution strategies must run before execution. `pi-prune-router` can only help after output already exists.

## RTK Strategy

`pi-rtk-optimizer` should register an RTK strategy.

Possible plan output:

```ts
{
  strategy: "rtk",
  command: `rtk ${originalCommand}`,
  transport: "default",
  postPrune: true
}
```

Notes:

- For remote sessions, the rewritten command still executes on the remote target through the existing remote transport.
- Availability probing can be added later and cached per target/session, e.g. `command -v rtk`.
- If RTK has its own remote-aware mode that should bypass SSH transport, model that as a separate plan/transport only after it is proven necessary.

## Snip Strategy

Do not implement Snip as a prune provider yet.

Current upstream Snip has command-proxy execution but no generic `pipe`/`apply` mode for already-captured output.

Future Snip strategy can plan:

```ts
{
  strategy: "snip",
  command: `snip run -- ${originalCommand}`,
  transport: "default",
  postPrune: true
}
```

Only enable this for commands where wrapping is safe and Snip is available on the target.

## Fallback Rules

Recommended initial behavior:

1. Try highest-priority strategy that can safely plan.
2. If no strategy can plan, run raw.
3. Avoid automatic re-execution fallback for commands with possible side effects.
4. For safe/read-only commands, later allow retry fallback such as RTK -> Snip -> raw.
5. Always allow post-output pruning after execution when output exceeds thresholds.

Side-effect safety should be conservative. Tests, builds, searches, listings, and status commands are safer than mutation commands.

## Incremental Implementation Plan

### Phase 1: Document and types only

- Add this plan.
- Add shared command-router event/type definitions in the package that first hosts the implementation.
- Do not change execution behavior yet.

### Phase 2: Minimal router

- Add strategy registry.
- Add raw default strategy.
- Add tests proving priority ordering and local/remote request normalization.

### Phase 3: RTK strategy

- Move existing RTK command rewrite logic behind the strategy interface.
- Register RTK strategy from `pi-rtk-optimizer`.
- Preserve current behavior.
- Add tests for local and remote command planning.

### Phase 4: Post-output prune hook

- If captured output exceeds configured thresholds, send it to `pi-prune-router`.
- Keep this best-effort and artifact-backed.

### Phase 5: Snip strategy

- Add only after Snip availability and safe wrapping behavior are verified.
- Keep Snip execution-side, not provider-side, unless upstream adds pipe/apply support.

### Phase 6: Extract if needed

If multiple packages need to share the registry, extract the neutral code to a dedicated `pi-command-router` package.

Do not extract prematurely if one package can host the first implementation cleanly.

## Open Questions

- Which package currently has the earliest reliable hook for local and remote bash calls?
- Should strategy fallback ever re-run a command, or only choose once before execution?
- How should Pi classify commands as read-only vs side-effectful?
- Should target availability checks be synchronous, cached, or explicit user-triggered?
- What output-size threshold should trigger post-output pruning by default?
