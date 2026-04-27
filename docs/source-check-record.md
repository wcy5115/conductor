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
| `src/llm_client.ts` | Needs follow-up | 2026-04-27 | Multimodal usage-estimation bug is intentionally deferred; tracked Chinese text translated to English. |
| `src/exceptions.ts` | Checked | 2026-04-27 | Cost currency wording fixed; tracked Chinese text translated to English. |
| `src/cost_calculator.ts` | Checked | 2026-04-27 | Final total-cost rounding bug fixed; no Chinese text found. |
| `src/workflow_loader.ts` | Checked | 2026-04-23 | Loader bugs fixed; tracked Chinese text translated to English. |
| `src/workflow_parser.ts` | Checked | 2026-04-23 | Parser validation bugs fixed; tracked Chinese text translated to English. |
| `src/workflow_engine.ts` | Checked | 2026-04-23 | Start-node and action-name logging bugs fixed; tracked Chinese text translated to English. |
| `src/index.ts` | Checked | 2026-04-27 | Package entry exports fixed; no Chinese text found. |
| `src/core/workflow_runner.ts` | Checked | 2026-04-23 | Related start-node bug fixed; tracked Chinese text translated to English. |
| `src/utils.ts` | Checked | 2026-04-27 | Image preprocessing now fails loudly for requested local images that cannot be included; tracked Chinese text translated to English. |
| `src/workflow_actions/utils.ts` | Checked | 2026-04-27 | Zero-cost metadata now includes the project currency field; tracked Chinese text translated to English. |
| `src/workflow_actions/llm_actions.ts` | Checked | 2026-04-23 | Multimodal prompt interpolation bug fixed; tracked Chinese text translated to English. |
| `src/workflow_actions/io_actions.ts` | Checked | 2026-04-24 | Merge action empty-input result-shape bug fixed; tracked Chinese text translated to English. |
| `src/workflow_actions/data_actions.ts` | Checked | 2026-04-24 | Processor output validation bug fixed; tracked comments translated to English and cleaned up from corrupted encoding. |
| `src/workflow_actions/pdf_actions.ts` | Needs follow-up | 2026-04-24 | Result file list/count still ignores the current `page_range`; tracked comments and user-facing strings were translated to English. |
| `src/pdf_to_images.ts` | Checked | 2026-04-25 | Page-range start validation bug fixed; tracked comments and user-facing strings translated to English. |
| `src/workflow_actions/ebook_actions.ts` | Checked | 2026-04-26 | Merge/resume bugs fixed; tracked comments, logs, errors, and default action names translated to English. |
| `src/workflow_actions/concurrent_actions.ts` | Checked | 2026-04-26 | Resume output-list bug fixed; tracked comments, logs, and error messages translated to English. |
| `src/workflow_actions/base.ts` | Checked | 2026-04-26 | Error-history key-shape bug fixed; tracked comments, logs, and examples translated to English. |

Status values: `Planned`, `Checking`, `Checked`, `Needs follow-up`.

## Bugs Found

Record bugs here immediately after checking each file.

### `workflows/chat/run.ts`

- `MODEL` was set to `gpt35`, but `models.yaml` does not define a `gpt35` alias.(That doesn't matter)
- Follow-up: confirm the approved source change separately before treating this bug as fixed in source.

### `src/model_caller.ts`

- No bugs found in the previous focused check.

### `src/llm_client.ts`

- `callLlmApi()` underestimates prompt tokens when an API response does not include `usage` and the request uses multimodal message content. Its fallback estimation only reads messages whose `content` is a plain string, so text blocks inside `MessageContent[]` are ignored. This can underreport prompt tokens and cost for providers that omit `usage`.
- Deferred on 2026-04-27 by user request; this bug remains recorded for later work.

### `src/utils.ts`

- Fixed on 2026-04-27: `processMessagesWithImages()` now throws when a requested `{ type: "image", path: ... }` block points to a missing file or the image cannot be converted. This prevents `callLlmApi()` from continuing with an incomplete multimodal payload.

### `src/workflow_actions/utils.ts`

- Fixed on 2026-04-27: `createZeroCostInfo()` now returns `currency: "CNY"`, and `safeGetCostInfo()` fills a missing currency with `CNY` while preserving any existing currency value. This keeps zero-cost metadata consistent with `calculateCost()` and `aggregateCosts()`.

### `src/exceptions.ts`

- Fixed on 2026-04-27: `CostInfo.total_cost` no longer describes the value as USD. The exception comments now match the current project cost system, which uses CNY and displays values with `¥`.

### `src/cost_calculator.ts`

- Fixed on 2026-04-27: `calculateCost()` and `aggregateCosts()` now round final `total_cost` values without letting binary floating-point artifacts such as `0.30000000000000004` round the value one extra tick upward.

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

### `src/index.ts`

- Fixed on 2026-04-27: `package.json` declares `dist/index.js` and `dist/index.d.ts` as the package entry points, but `src/index.ts` only ran `console.log("conductor")` and exported no public API. The entry file now re-exports the main runner, engine, loader, parser, model, action, validator, and utility APIs without the console side effect.

### `src/core/workflow_runner.ts`

- Fixed on 2026-04-23: `WorkflowRunner.run()` forced `startStep: "1"`, bypassing the engine's `workflowGraph.startNode` default for YAML workflows whose first node is not `1`.

### `src/workflow_actions/llm_actions.ts`

- Fixed on 2026-04-23: the multimodal branch now renders prompt templates with `context.data` before calling the model. It keeps instruction lines that contain `{item}`, replaces other placeholders, and omits only the raw image-path value from the text prompt.

### `src/workflow_actions/io_actions.ts`

- Fixed on 2026-04-24: `MergeJsonFilesAction` now keeps a stable result shape on empty-input branches. When the input directory is missing or no files match, it still returns `${outputKey}_count` and `${outputKey}_file`, and it writes an empty output JSON file so downstream steps can use a real file path.

### `src/workflow_actions/data_actions.ts`

- Fixed on 2026-04-24: `DataProcessAction.execute()` now validates custom processor output before constructing the step result. Non-object returns such as `null` or arrays now throw a direct validation error instead of failing later with unclear runtime errors.

### `src/workflow_actions/pdf_actions.ts`

- `PDFToImagesAction.execute()` currently scans the whole output directory for `page_XXXX.jpg` files after conversion and returns every match. If `page_range` targets only part of a PDF, or the directory already contains images from an earlier run, `${outputKey}_files` and `${outputKey}_count` can include stale pages that were not requested in the current step.

### `src/pdf_to_images.ts`

- Fixed on 2026-04-25: `parsePageRange()` now rejects range expressions whose start page is greater than the PDF page count. For example, with a 10-page PDF, `11-20` now throws a direct validation error instead of finishing successfully with no generated pages.

### `src/workflow_actions/ebook_actions.ts`

- Fixed on 2026-04-25: `MergeToEpubAction.execute()` now reads concurrent stats from `${alignedKey}_stats` when `alignedKey` points at a result array such as `4_response`, and it can fall back to the result array length when stats are not present.
- Fixed on 2026-04-25: `MergeToEpubAction.execute()` now creates a small default cover image for `nodepub`, verifies that the `.epub` file exists before returning its path, and reports `output_epub: null` with `epub_created: false` if ePub generation falls back to TXT only.
- Fixed on 2026-04-25: `EpubExtractAction.execute()` now restores cached chunks using the configured `saveToFile.filename_template` instead of the hard-coded `chunk_\d+\.txt` pattern.

### `src/workflow_actions/concurrent_actions.ts`

- Fixed on 2026-04-26: `ConcurrentAction.execute()` now preserves already-completed save-to-file output entries when resume skips cached files. Cached files still count as skipped in stats, but their `{ saved_file, item }` entries are included in `${outputKey}` so downstream steps receive a complete output list.

### `src/workflow_actions/base.ts`

- Fixed on 2026-04-26: `BaseAction.run()` now writes failed action records to `context.history` with the same `stepId` key used by normal workflow history entries. This keeps failed action records discoverable by consumers that read `entry["stepId"]` or use `WorkflowContext.getStepResult()`.

## Chinese Text Found

Record Chinese comments, strings, prompts, and user-facing text here before translating them.

### `workflows/chat/run.ts`

- Chinese comments were found.
- The sample prompt was written in Chinese.
- The failure message was written in Chinese.
- Follow-up: confirm the approved source change separately before treating this text as translated in source.

### `src/model_caller.ts`

- No Chinese text found in the previous focused check.

### `src/llm_client.ts`

- Translated on 2026-04-27: module documentation, section headings, interface comments, inline comments, log messages, thrown error messages, and usage examples in `src/llm_client.ts`; focused comments, test names, assertions, and sample strings in `tests/llm_client.test.ts`.

### `src/utils.ts`

- Translated on 2026-04-27: tracked module comments, section headings, function documentation, inline comments, log messages, thrown error messages, and focused utility test comments/names were translated to English.

### `src/workflow_actions/utils.ts`

- Translated on 2026-04-27: tracked module comments, function documentation, inline comments, log messages, error formatting labels, thrown error messages, and focused utility test names were translated to English.

### `src/exceptions.ts`

- Translated on 2026-04-27: tracked module comments, interface comments, field comments, usage example text, constructor comments, `toString()` comments, and `toString()` output labels were translated to English.

### `src/cost_calculator.ts`

- No Chinese text found during the focused check on 2026-04-27.

### `src/workflow_loader.ts`

- Translated on 2026-04-23: tracked comments and user-facing strings in this file were translated to English.

### `src/workflow_parser.ts`

- Translated on 2026-04-23: tracked comments and user-facing error messages in this file were translated to English.

### `src/workflow_engine.ts`

- Translated on 2026-04-23: tracked comments and user-facing logs/errors in this file were translated to English.

### `src/index.ts`

- No Chinese text found during the focused check on 2026-04-27.

### `src/core/workflow_runner.ts`

- Translated on 2026-04-23: tracked comments and user-facing logs/errors in this file were translated to English.

### `src/workflow_actions/llm_actions.ts`

- Translated on 2026-04-23: tracked comments, examples, log messages, thrown error messages, and JSON-retry prompt text in this file were translated to English.

### `src/workflow_actions/io_actions.ts`

- Translated on 2026-04-24: tracked comments, default strings, log messages, and thrown error messages in this file were translated to English.

### `src/workflow_actions/data_actions.ts`

- Translated on 2026-04-24: tracked comments in this file were rewritten in English, and the previously mojibake comment text was removed.

### `src/workflow_actions/pdf_actions.ts`

- Translated on 2026-04-24: tracked comments, the default action name string, the template-resolution error message, and the progress log messages were translated to English.

### `src/pdf_to_images.ts`

- Translated on 2026-04-25: tracked comments, user-facing log messages, and thrown error messages were translated to English.

### `src/workflow_actions/ebook_actions.ts`

- Translated on 2026-04-26: tracked comments, documentation comments, default action names, log messages, and thrown error messages were translated to English.

### `src/workflow_actions/concurrent_actions.ts`

- Translated on 2026-04-26: tracked comments, documentation comments, log messages, and thrown error messages were translated to English.

### `src/workflow_actions/base.ts`

- Translated on 2026-04-26: tracked comments, documentation comments, log messages, and examples were translated to English.

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

### 2026-04-27 - `src/llm_client.ts`

- Checked request construction, safety gating, retry handling, response parsing, usage fallback estimation, the `chat()` wrapper, focused tests, and the image-message preprocessing handoff.
- Bug details: see `Bugs Found` > `src/llm_client.ts`.
- Chinese text details: see `Chinese Text Found` > `src/llm_client.ts`.
- Follow-up needed: fix the deferred multimodal usage-estimation fallback later; tracked Chinese text translation is done.

### 2026-04-27 - `src/exceptions.ts`

- Checked the cost-carrying exception type, its `CostInfo` and `UsageInfo` interfaces, constructor behavior, `name` assignment, and `toString()` output.
- Bug details: see `Bugs Found` > `src/exceptions.ts`.
- Chinese text details: see `Chinese Text Found` > `src/exceptions.ts`.
- Follow-up needed: none for the tracked `src/exceptions.ts` work.

### 2026-04-27 - `src/cost_calculator.ts`

- Checked model pricing lookup, per-call cost calculation, cost formatting, aggregate cost calculation, token estimation, deprecated compatibility functions, and existing cost tests.
- Bug details: see `Bugs Found` > `src/cost_calculator.ts`.
- Chinese text details: see `Chinese Text Found` > `src/cost_calculator.ts`.
- Follow-up needed: none for the tracked `src/cost_calculator.ts` work.

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

### 2026-04-27 - `src/index.ts`

- Checked the package entry source file and compared it with the package metadata entry points.
- Bug details: see `Bugs Found` > `src/index.ts`.
- Chinese text details: see `Chinese Text Found` > `src/index.ts`.
- Follow-up needed: none for the tracked package entry bug.

### 2026-04-27 - `src/utils.ts`

- Checked file saving, image Base64 conversion, MIME lookup, multimodal image preprocessing, JSON cleanup/parsing, and the internal JSON helper functions.
- Bug details: see `Bugs Found` > `src/utils.ts`.
- Chinese text details: see `Chinese Text Found` > `src/utils.ts`.
- Follow-up needed: none for the tracked `src/utils.ts` work.

### 2026-04-27 - `src/workflow_actions/utils.ts`

- Checked JSON file validation, resume output-file validation, atomic writes, directory setup, cost helpers, error formatting, path-template formatting, and deep data lookup.
- Bug details: see `Bugs Found` > `src/workflow_actions/utils.ts`.
- Chinese text details: see `Chinese Text Found` > `src/workflow_actions/utils.ts`.
- Follow-up needed: none for the tracked `src/workflow_actions/utils.ts` work.

### 2026-04-23 - `src/core/workflow_runner.ts`

- Checked the higher-level YAML runner path that calls `engine.runWorkflow()`.
- Bug details: see `Bugs Found` > `src/core/workflow_runner.ts`.
- Chinese text details: see `Chinese Text Found` > `src/core/workflow_runner.ts`.
- Follow-up needed: none for the start-node path.

### 2026-04-23 - `src/workflow_actions/llm_actions.ts`

- Checked `LLMCallAction` and `ConditionalLLMAction`, with extra attention on multimodal prompt handling, JSON-retry behavior, and user-facing strings.
- Bug details: see `Bugs Found` > `src/workflow_actions/llm_actions.ts`.
- Chinese text details: see `Chinese Text Found` > `src/workflow_actions/llm_actions.ts`.
- Follow-up needed: none for the tracked `llm_actions.ts` work.

### 2026-04-24 - `src/workflow_actions/io_actions.ts`

- Checked `SaveDataAction`, `LogAction`, `ReadFileAction`, and `MergeJsonFilesAction`, with extra attention on result-shape consistency and user-facing strings.
- Bug details: see `Bugs Found` > `src/workflow_actions/io_actions.ts`.
- Chinese text details: see `Chinese Text Found` > `src/workflow_actions/io_actions.ts`.
- Follow-up needed: none for the tracked `io_actions.ts` work.

### 2026-04-24 - `src/workflow_actions/data_actions.ts`

- Checked `DataProcessAction` and `ConditionalBranchAction`, with extra attention on custom function outputs, branch routing, and comment text state.
- Bug details: see `Bugs Found` > `src/workflow_actions/data_actions.ts`.
- Chinese text details: see `Chinese Text Found` > `src/workflow_actions/data_actions.ts`.
- Follow-up needed: none for the tracked `data_actions.ts` work.

### 2026-04-24 - `src/workflow_actions/pdf_actions.ts`

- Checked `PDFToImagesAction`, with extra attention on template resolution, output file discovery, page-range behavior, and user-facing text state.
- Bug details: see `Bugs Found` > `src/workflow_actions/pdf_actions.ts`.
- Chinese text details: see `Chinese Text Found` > `src/workflow_actions/pdf_actions.ts`.
- Follow-up needed: the returned file list/count still needs a future fix so it reflects the current requested pages; tracked text translation is done.

### 2026-04-25 - `src/pdf_to_images.ts`

- Checked `isImageValid()`, `parsePageRange()`, and `convertPdfToImages()`, with extra attention on page-range validation, resume behavior, output file naming, and user-facing text state.
- Bug details: see `Bugs Found` > `src/pdf_to_images.ts`.
- Chinese text details: see `Chinese Text Found` > `src/pdf_to_images.ts`.
- Follow-up needed: none for the tracked `src/pdf_to_images.ts` work.

### 2026-04-25 - `src/workflow_actions/ebook_actions.ts`

- Checked `calculateTokens()`, `forceTruncateAtTarget()`, `splitBySentences()`, `EpubExtractAction`, `MergeToEpubAction`, and `ParseTranslationAction`, with extra attention on resume behavior, concurrent result handoff, ePub output reporting, and language state.
- Bug details: see `Bugs Found` > `src/workflow_actions/ebook_actions.ts`.
- Chinese text details: see `Chinese Text Found` > `src/workflow_actions/ebook_actions.ts`.
- Follow-up needed: none for the tracked `src/workflow_actions/ebook_actions.ts` work.

### 2026-04-26 - `src/workflow_actions/concurrent_actions.ts`

- Checked `_createActionFromConfig()` and `ConcurrentAction.execute()`, with extra attention on save-to-file resume behavior, skipped item handling, result collection, cost collection, and language state.
- Bug details: see `Bugs Found` > `src/workflow_actions/concurrent_actions.ts`.
- Chinese text details: see `Chinese Text Found` > `src/workflow_actions/concurrent_actions.ts`.
- Follow-up needed: none for the tracked `src/workflow_actions/concurrent_actions.ts` work.

### 2026-04-26 - `src/workflow_actions/base.ts`

- Checked `BaseAction.run()` and `BaseAction.toString()`, with extra attention on metadata injection, error handling, cost preservation, history records, and language state.
- Bug details: see `Bugs Found` > `src/workflow_actions/base.ts`.
- Chinese text details: see `Chinese Text Found` > `src/workflow_actions/base.ts`.
- Follow-up needed: none for the tracked `src/workflow_actions/base.ts` work.

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
- `rg -n "[\p{Han}]"` returned no matches in `src/workflow_actions/llm_actions.ts` after the tracked language cleanup.
- `npm.cmd run typecheck` passed after the `src/workflow_actions/llm_actions.ts` multimodal prompt fix.
- `npm.cmd test -- llm_actions` passed after rerunning outside the sandbox because the first sandboxed Vitest run failed with `spawn EPERM`.
- `npm.cmd run typecheck` passed after the `src/workflow_actions/io_actions.ts` merge result-shape fix.
- `npm.cmd test -- io_actions` passed with 2 tests after rerunning outside the sandbox because the first sandboxed Vitest run failed with `spawn EPERM`.
- `rg -n "[\p{Han}]"` returned no matches in `src/workflow_actions/io_actions.ts` and `tests/io_actions.test.ts` after the tracked language cleanup.
- `npm.cmd run typecheck` passed after translating the tracked `src/workflow_actions/io_actions.ts` text to English.
- `npm.cmd test -- io_actions` passed with 2 tests after rerunning outside the sandbox because the first sandboxed Vitest run failed with `spawn EPERM`.
- `npm.cmd run typecheck` passed after the `src/workflow_actions/data_actions.ts` processor-output validation fix.
- `npm.cmd test -- data_actions` passed with 2 tests after rerunning outside the sandbox because the first sandboxed Vitest run failed with `spawn EPERM`.
- `rg -n --pcre2 "[^\x00-\x7F]"` returned no matches in `src/workflow_actions/data_actions.ts` and `tests/data_actions.test.ts` after the tracked English cleanup.
- `rg -n "[\p{Han}]"` returned no matches in `src/workflow_actions/data_actions.ts` and `tests/data_actions.test.ts` after the tracked English cleanup.
- `npm.cmd run typecheck` passed after translating the tracked `src/workflow_actions/data_actions.ts` comments to English.
- `npm.cmd test -- data_actions` passed with 2 tests after rerunning outside the sandbox because the first sandboxed Vitest run failed with `spawn EPERM`.
- `rg -n "[\p{Han}]"` returned no matches in `src/workflow_actions/pdf_actions.ts` or the updated `docs/source-check-record.md` entry after the tracked `pdf_actions.ts` English cleanup.
- `npm.cmd run typecheck` passed after translating the tracked `src/workflow_actions/pdf_actions.ts` comments and user-facing strings to English.
- `npm.cmd run typecheck` passed after fixing the `src/pdf_to_images.ts` page-range start validation bug.
- `npm.cmd test -- pdf_to_images` passed with 1 test after rerunning outside the sandbox because the first sandboxed Vitest run failed with `spawn EPERM`.
- `rg -n "[\p{Han}]"` returned no matches in `src/pdf_to_images.ts` and `tests/pdf_to_images.test.ts` after the tracked English cleanup.
- `npm.cmd run typecheck` passed after translating the tracked `src/pdf_to_images.ts` comments and user-facing strings to English.
- `npm.cmd test -- pdf_to_images` passed with 1 test after rerunning outside the sandbox because the first sandboxed Vitest run failed with `spawn EPERM`.
- `rg -n "[\p{Han}]"` found Chinese comments, default action names, logs, and error strings in `src/workflow_actions/ebook_actions.ts` during the focused check.
- Local `node_modules/nodepub/src/index.js` shows `cover` is required and must be non-empty, confirming the empty-cover ePub generation bug in `src/workflow_actions/ebook_actions.ts`.
- `npm.cmd run typecheck` passed after fixing the tracked `src/workflow_actions/ebook_actions.ts` merge/resume bugs.
- `npm.cmd test -- ebook_actions` passed with 2 tests after rerunning outside the sandbox because the first sandboxed Vitest run failed with `spawn EPERM`.
- `rg -n "[\p{Han}]"` returned no matches in `src/workflow_actions/ebook_actions.ts` and `tests/ebook_actions.test.ts` after the tracked English cleanup.
- `npm.cmd run typecheck` passed after translating the tracked `src/workflow_actions/ebook_actions.ts` text to English.
- `npm.cmd test -- ebook_actions` passed with 2 tests after rerunning outside the sandbox because the first sandboxed Vitest run failed with `spawn EPERM`.
- `npm.cmd run typecheck` passed after adding Arabic question mark and Devanagari sentence-ending punctuation to the ebook sentence splitter.
- `npm.cmd test -- ebook_actions` passed with 3 tests after rerunning outside the sandbox because the first sandboxed Vitest run failed with `spawn EPERM`.
- `rg -n "[\p{Han}]" src/workflow_actions/concurrent_actions.ts` found Chinese comments, logs, and thrown error messages during the focused check.
- A focused code read of `src/workflow_actions/concurrent_actions.ts` and `src/concurrent_utils.ts` confirmed the resume output-list bug: cached output files are returned as skipped with `null`, while the final output array keeps only successful items.
- `npm.cmd test -- concurrent_actions` passed with 1 test after rerunning outside the sandbox because the first sandboxed Vitest run failed with `spawn EPERM`.
- `npm.cmd run typecheck` passed after fixing the `src/workflow_actions/concurrent_actions.ts` resume output-list bug.
- `rg -n "[\p{Han}]"` returned no matches in `src/workflow_actions/concurrent_actions.ts` and `tests/concurrent_actions.test.ts` after the tracked English cleanup.
- `npm.cmd run typecheck` passed after translating the tracked `src/workflow_actions/concurrent_actions.ts` text to English.
- `npm.cmd test -- concurrent_actions` passed with 1 test after rerunning outside the sandbox because the first sandboxed Vitest run failed with `spawn EPERM`.
- `rg -n "[\p{Han}]" src/workflow_actions/base.ts` found Chinese comments, logs, and examples during the focused check.
- A focused code read of `src/workflow_actions/base.ts` and `src/workflow_engine.ts` confirmed the error-history key-shape bug: `BaseAction.run()` writes `step_id` on failure, while normal history entries use `stepId`.
- `rg -n "[\p{Han}]"` returned no matches in `src/workflow_actions/base.ts` and `tests/base_action.test.ts` after the tracked English cleanup.
- `npm.cmd run typecheck` passed after fixing the `src/workflow_actions/base.ts` error-history key-shape bug.
- `npm.cmd test -- base_action` passed with 2 tests after rerunning outside the sandbox because the first sandboxed Vitest run failed with `spawn EPERM`.
- `rg -n "[\p{Han}]" src/index.ts` returned no matches during the focused `src/index.ts` check.
- `package.json` declares `dist/index.js` and `dist/index.d.ts` as package entry points, confirming that `src/index.ts` is the source for the published entry file.
- `npm.cmd run typecheck` passed after fixing `src/index.ts`.
- `npm.cmd run build` passed after fixing `src/index.ts`, confirming the package entry and declarations compile.
- `node -e "import('./dist/index.js')..."` succeeded after fixing `src/index.ts` and confirmed the built package entry exposes exported API names. It also printed the existing model-config load message from `src/model_caller.ts`, which is outside this focused entry-file fix.
- `rg -n "[\p{Han}]" src/exceptions.ts` found Chinese comments and string output labels during the focused `src/exceptions.ts` check.
- `models.yaml` and `src/cost_calculator.ts` confirm the current cost system uses CNY/`¥`, while `src/exceptions.ts` documents `CostInfo.total_cost` as USD.
- `rg -n "[\p{Han}]" src/exceptions.ts` returned no matches after translating the tracked `src/exceptions.ts` text to English.
- `npm.cmd run typecheck` passed after fixing the `src/exceptions.ts` currency wording and tracked language.
- `rg -n "[\p{Han}]" src/utils.ts` found Chinese comments, logs, and thrown error messages during the focused `src/utils.ts` check.
- A focused code read of `src/utils.ts`, `src/llm_client.ts`, and existing utility tests confirmed the image preprocessing risk: `processMessagesWithImages()` skips missing or failed local image blocks, and existing tests do not cover this helper.
- `rg -n "[\p{Han}]" src/utils.ts tests/utils.test.ts` returned no matches after the tracked English cleanup.
- `npm.cmd run typecheck` passed after fixing the tracked `src/utils.ts` image preprocessing bug and English cleanup.
- `npm.cmd test -- utils` passed with 17 tests after rerunning outside the sandbox because the first sandboxed Vitest run failed with `spawn EPERM`.
- `rg -n "[\p{Han}]" src/workflow_actions/utils.ts` found Chinese comments, logs, error labels, and thrown error messages during the focused `src/workflow_actions/utils.ts` check.
- A focused code read of `src/workflow_actions/utils.ts`, `src/workflow_actions/concurrent_actions.ts`, and `src/cost_calculator.ts` confirmed the zero-cost metadata mismatch: `createZeroCostInfo()` omits `currency: "CNY"`, while `calculateCost()` and `aggregateCosts()` include it and `ConcurrentAction.execute()` uses the zero-cost helper when no costs are collected.
- `rg -n "[\p{Han}]" src/workflow_actions/utils.ts tests/workflow_actions_utils.test.ts` returned no matches after the tracked English cleanup.
- `npm.cmd run typecheck` passed after fixing the tracked `src/workflow_actions/utils.ts` zero-cost metadata bug and English cleanup.
- `npm.cmd test -- workflow_actions_utils` passed with 5 tests after rerunning outside the sandbox because the first sandboxed Vitest run failed with `spawn EPERM`.
- `rg -n "[\p{Han}]" src/cost_calculator.ts` returned no matches during the focused `src/cost_calculator.ts` check.
- `node -e "console.log(0.1 + 0.2); console.log(0.0001 + 0.0002)"` confirmed JavaScript can expose floating-point artifacts (`0.30000000000000004`, `0.00030000000000000003`) that the current total-cost additions can leak into returned metadata.
- `npm.cmd run typecheck` passed after fixing the tracked `src/cost_calculator.ts` total-cost rounding bug.
- `npm.cmd test -- cost_calculator` passed with 30 tests after rerunning outside the sandbox because the first sandboxed Vitest run failed with `spawn EPERM`.
- `rg -n "[\p{Han}]" src/cost_calculator.ts tests/cost_calculator.test.ts` returned no matches after the tracked `src/cost_calculator.ts` fix.
- `rg -n "[\p{Han}]" src/llm_client.ts` found Chinese module documentation, comments, log messages, thrown error messages, and examples during the focused check.
- A focused code read of `src/llm_client.ts`, `src/utils.ts`, and `tests/llm_client.test.ts` confirmed the multimodal usage-estimation bug: text blocks inside array-based message content are ignored when API usage data is missing, and current tests cover plain string estimation but not multimodal text-block estimation.
- `rg -n "[\p{Han}]" src/llm_client.ts tests/llm_client.test.ts` returned no matches after the tracked English cleanup.
- `npm.cmd run typecheck` passed after translating the tracked `src/llm_client.ts` and `tests/llm_client.test.ts` text to English.
- `npm.cmd test -- llm_client` passed with 37 tests after rerunning outside the sandbox because the first sandboxed Vitest run failed with `spawn EPERM`.
