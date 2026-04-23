# Source Check Record

Date started: 2026-04-23

## Goal

- Check planned source files for bugs.
- Find Chinese comments, strings, prompts, and user-facing text in those files.
- Record each checked file immediately so the same file is not checked twice by accident.
- Record bugs, Chinese text, and follow-up notes after each file is checked.

## Files Planned for Check

| File | Status | Checked At | Notes |
| --- | --- | --- | --- |
| `workflows/chat/run.ts` | Checked | 2026-04-23 | Bug and Chinese text were found in the previous focused check. Source changes are outside this tracker. |
| `src/model_caller.ts` | Checked | 2026-04-23 | No direct source-code bug or Chinese text was found in the previous focused check. |
| `src/workflow_loader.ts` | Checked | 2026-04-23 | Loader bugs fixed; tracked Chinese text translated to English. |
| `src/workflow_parser.ts` | Checked | 2026-04-23 | Parser validation bugs fixed; tracked Chinese text translated to English. |
| `src/workflow_engine.ts` | Checked | 2026-04-23 | Start-node and action-name logging bugs fixed; tracked Chinese text translated to English. |
| `src/core/workflow_runner.ts` | Checked | 2026-04-23 | Related start-node bug fixed; tracked Chinese text translated to English. |

Status values: `Planned`, `Checking`, `Checked`, `Needs follow-up`.

## Bugs Found

Record bugs here immediately after checking each file.

### `workflows/chat/run.ts`

- `MODEL` was set to `gpt35`, but `models.yaml` does not define a `gpt35` alias.(That doesn't matter)
- Follow-up: confirm the approved source change separately before treating this bug as fixed in source.

### `src/model_caller.ts`

- No bugs found in the previous focused check.

### `src/workflow_loader.ts`

- Fixed on 2026-04-23: the loader now validates that every non-`END` node referenced by `workflow_graph` has a matching entry in `steps`.
- Fixed on 2026-04-23: `_createLLMActionV2` received `_stepName` but did not use it. LLM actions now receive the YAML step name.

### `src/workflow_parser.ts`

- Fixed on 2026-04-23: malformed bracket syntax is now rejected. Unmatched `[` and unexpected `]` throw `Invalid workflow_graph bracket syntax`.
- Fixed on 2026-04-23: empty dictionary graphs now throw `Invalid workflow_graph: dictionary form cannot be empty`.
- Fixed on 2026-04-23: dictionary branch arrays now reject non-string items instead of silently ignoring nested values.

### `src/workflow_engine.ts`

- Fixed on 2026-04-23: `runWorkflow()` defaulted to `startStep: "1"` even when the parsed `WorkflowGraph` had a different `startNode`. It now uses `workflowGraph.startNode` when no explicit `startStep` is provided.
- Fixed on 2026-04-23: step names used for structured logging could be wrong when actions were registered as bound functions. Registered actions now carry an explicit display name, so logs use names such as `Log_A` instead of `bound run`.

### `src/core/workflow_runner.ts`

- Fixed on 2026-04-23: `WorkflowRunner.run()` forced `startStep: "1"`, bypassing the engine's `workflowGraph.startNode` default for YAML workflows whose first node is not `1`.

## Chinese Text Found

Record Chinese comments, strings, prompts, and user-facing text here before translating them.

### `workflows/chat/run.ts`

- Chinese comments were found.
- The sample prompt was written in Chinese.
- The failure message was written in Chinese.
- Follow-up: confirm the approved source change separately before treating this text as translated in source.

### `src/model_caller.ts`

- No Chinese text found in the previous focused check.

### `src/workflow_loader.ts`

- Translated on 2026-04-23: tracked comments and user-facing strings in this file were translated to English.

### `src/workflow_parser.ts`

- Translated on 2026-04-23: tracked comments and user-facing error messages in this file were translated to English.

### `src/workflow_engine.ts`

- Translated on 2026-04-23: tracked comments and user-facing logs/errors in this file were translated to English.

### `src/core/workflow_runner.ts`

- Translated on 2026-04-23: tracked comments and user-facing logs/errors in this file were translated to English.

## Check Log

Add one entry per checked file. Each entry should record what was checked and point to the detailed sections above, so bug details are not duplicated.

### 2026-04-23 - `workflows/chat/run.ts`

- Checked model alias usage and visible text in the chat workflow runner.
- Bug details: see `Bugs Found` > `workflows/chat/run.ts`.
- Chinese text details: see `Chinese Text Found` > `workflows/chat/run.ts`.
- Follow-up needed: handle source-code changes only after approval.

### 2026-04-23 - `src/model_caller.ts`

- Checked model-loading behavior related to `models.yaml`, `models.mock.yaml`, and environment variable placeholders.
- Bug details: see `Bugs Found` > `src/model_caller.ts`.
- Chinese text details: see `Chinese Text Found` > `src/model_caller.ts`.
- Follow-up needed: none recorded.

### 2026-04-23 - `src/workflow_loader.ts`

- Checked YAML loading, workspace creation, path placeholder resolution, graph parsing handoff, action creation, and action registration.
- Bug details: see `Bugs Found` > `src/workflow_loader.ts`.
- Chinese text details: see `Chinese Text Found` > `src/workflow_loader.ts`.
- Follow-up needed: no loader bug follow-up remains; Chinese text remains untranslated.

### 2026-04-23 - `src/workflow_parser.ts`

- Checked graph data structure behavior, string graph parsing, dictionary graph parsing, branch handling, and output key generation.
- Bug details: see `Bugs Found` > `src/workflow_parser.ts`.
- Chinese text details: see `Chinese Text Found` > `src/workflow_parser.ts`.
- Follow-up needed: no parser validation bug follow-up remains; Chinese text remains untranslated.

### 2026-04-23 - `src/workflow_engine.ts`

- Checked workflow execution loop, default start step handling, context updates, structured logging calls, and error paths.
- Bug details: see `Bugs Found` > `src/workflow_engine.ts`.
- Chinese text details: see `Chinese Text Found` > `src/workflow_engine.ts`.
- Follow-up needed: none for the checked engine bugs.

### 2026-04-23 - `src/core/workflow_runner.ts`

- Checked the higher-level YAML runner path that calls `engine.runWorkflow()`.
- Bug details: see `Bugs Found` > `src/core/workflow_runner.ts`.
- Chinese text details: see `Chinese Text Found` > `src/core/workflow_runner.ts`.
- Follow-up needed: none for the start-node path.

## Verification

- `npm.cmd run typecheck` passed.
- `npm.cmd test -- workflow_parser` passed after rerunning outside the sandbox because the first sandboxed Vitest run failed with `spawn EPERM`.
- A small runtime check confirmed the `workflowGraph.startNode` bug in `src/workflow_engine.ts`.
- `npm.cmd test -- workflow_engine` passed after rerunning outside the sandbox because the first sandboxed Vitest run failed with `spawn EPERM`.
- `npm.cmd test -- workflow_runner` passed after rerunning outside the sandbox because the first sandboxed Vitest run failed with `spawn EPERM`.
- `npm.cmd test -- workflow_engine` passed after adding action-name logging coverage.
- `npm.cmd test -- workflow_runner` passed after adding a YAML-runner assertion that the structured step log uses `Log_A` instead of `bound run`.
- `npm.cmd test -- workflow_parser` passed with 28 tests after adding parser validation regression tests. The first sandboxed Vitest run failed with `spawn EPERM`, so it was rerun outside the sandbox.
- `npm.cmd run typecheck` passed after the parser validation fixes.
- `npm.cmd test -- workflow_loader` passed after adding graph-to-steps validation coverage. The first sandboxed Vitest run failed with `spawn EPERM`, so it was rerun outside the sandbox.
- `npm.cmd run typecheck` passed after the loader validation fix.
- `npm.cmd test -- workflow_runner` passed after the loader validation fix.
- Tracked language cleanup verification on 2026-04-23:
  - `rg -n "[\p{Han}]"` returned no matches in `src/workflow_loader.ts`, `src/workflow_parser.ts`, `src/workflow_engine.ts`, `src/core/workflow_runner.ts`, and `tests/workflow_parser.test.ts`.
  - `npm.cmd test -- workflow_parser` passed with 28 tests after translating the parser test names and strings.
  - `npm.cmd test -- workflow_engine` passed after translating tracked engine strings.
  - `npm.cmd test -- workflow_loader` passed after translating tracked loader strings.
  - `npm.cmd test -- workflow_runner` passed after translating tracked runner strings.
  - `npm.cmd run typecheck` passed after the tracked language cleanup.
