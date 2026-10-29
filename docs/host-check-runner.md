# Host check runner

Core 0.5.0 provides `runChecks(config, {runAgent})` from `src/host/check-runner.mjs` (packaged as `dist/host/check-runner.js`). The CLI is `node scripts/check-runner.mjs <config.json>` or the built `node dist/check-runner.js <config.json>`. It runs explicitly configured local checks; Graph dispatch does not execute commands from run input.

## Command configuration

Resolve cwd and logDir on the host. Commands use executable plus literal argument arrays (`shell: false`). On Windows use actual executables; for npm scripts use Node with the installed npm CLI path, or an explicitly reviewed platform wrapper. The runner is not a sandbox: the host controls executable permissions, workspace isolation, environment and output redaction. Logs can contain command output; publish them only after host review.

Example `examples/check-runner.json` runs a harmless Node smoke check from the repository root:

```sh
node scripts/check-runner.mjs examples/check-runner.json
```

Configuration fields:

| Field | Meaning |
| --- | --- |
| `cwd`, `logDir` | Existing work directory and output parent directory |
| `setup` | Optional array of setup steps, once per invocation |
| `worker` | Optional step before each check round; must pass |
| `checks` | Nonempty array of command or agent steps, each with a unique safe `id` |
| `maxAttempts` | 1–20, default 3 |
| `timeoutMs` | Per-step bound, default 60000, maximum 3600000 |
| `maxOutputBytes` | Per-step captured output bound, default 1048576, maximum 16777216 |

Command step: `{id, type:"command", executable, args, retryExitCodes?:[1]}`. Exit 0 passes; configured nonzero codes request retry; other exits, spawn errors, signals, timeout or output overflow stop. Configure test-failure codes deliberately: a tool that also uses exit 1 for infrastructure errors needs an adapter that distinguishes them. Setup/worker failure stops immediately. Without a worker, a failed check returns retry after one round. With a worker, checks repeat up to the bound. Retrying never implies passing.

Every command receives `POLYFORGE_CHECK_ATTEMPT` and `POLYFORGE_CHECK_FEEDBACK` (path to a JSON file with previous failed check summaries and log paths). Setup has attempt 0. The worker reads previous feedback without changing the configured checks or turning log text into commands. The runner attempts process-tree termination on timeout, cancellation and output overflow. The host still owns execution isolation and must reconcile a running manifest after host restart.

## Background observation and recovery

`startChecks(config, options)` starts the same runner without waiting for completion and returns `{manifestPath, completion, cancel}`. The caller can await `completion` later without starting another process. `readCheckResult(manifestPath)` reads the durable status, active step and `unreadCompletion`; after consuming the log, pass `{acknowledge:true}` to clear the unread marker. A manifest still marked `running` after restart returns `requiresHostReconciliation:true`. The host must determine whether that execution survived or was interrupted before choosing a new attempt. Per-step `deadlineAt` is recorded before execution and does not reset when the caller switches to background observation.

## Agent adapter

The library accepts `runAgent({id, attempt, feedback, cwd, signal})`. The host maps the step ID to its trusted agent prompt/runtime. Return exactly `{status:"pass"|"retry"|"stop", summary:"observed result"}`; extra fields, strings, missing summaries and unknown statuses stop. The callback must honor AbortSignal and cancel external work. The CLI intentionally accepts only command steps; it does not provision an agent runtime or credentials.

## Results and Graph handoff

Every invocation creates its own `check-run-*` directory with setup/attempt logs, feedback and `manifest.json`. The manifest records commands, exit codes, observations, bounds and final pass/retry/stop. CLI exits are 0/1/2 respectively. Configuration/I/O failures return nonzero and must be treated as stop; storage failure may prevent a final manifest.

Publish logs and manifest through the host artifact store with immutable IDs/digests. Pin the candidate after worker changes and run final verification against that candidate. Include actual command/browser/manual/report observations in acceptance criterion rows. A runner pass covers only configured checks; independent review and acceptance completeness remain separate. No Graph decisions, PR mutations, merges or production actions are performed by the runner itself.
