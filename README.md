# Conductor

Conductor is a YAML-driven LLM workflow orchestration engine, currently focused on translating entire books.

It lets you describe multi-step AI workflows in YAML, then run them from small TypeScript entry files. The current project focuses on long-document translation workflows, especially workflows that split books or text files into chunks, process those chunks concurrently with an LLM, and merge the results back into an EPUB.

## Status

This project is in early development. The core workflow engine, concurrent processing, model configuration, and translation examples are usable, but the public interface is still being refined.

## Features

- YAML-defined workflow graphs
- TypeScript workflow runners
- LLM model aliases configured in `models.yaml`
- `.env`-based API key loading
- Concurrent chunk processing with progress output
- Resume-friendly artifact files for long runs
- TXT and EPUB input support for ebook-style workflows
- EPUB output generation
- Built-in tests for the workflow engine and actions

## Requirements

- Node.js 20 or newer
- npm
- An API key for at least one configured LLM provider (OpenRouter, DeepSeek, SiliconFlow, or another provider in your config)

## Installation

```bash
npm install
```

Create your local environment file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Then open `.env`, enable real LLM calls, and fill in the API key for the provider you want to use.

For translation workflows, the default model alias is `deepseek-v4-flash-nonthinking`. It can use SiliconFlow, DeepSeek, or OpenRouter as the provider. OpenRouter is enabled by default in `models.yaml`. You can switch providers in `models.yaml`, or edit `models.yaml` and the workflow YAML files to add other providers.

```env
LLM_API_ENABLE=true
OPENROUTER_API_KEY=
SILICONFLOW_API_KEY=
DEEPSEEK_API_KEY=
ALIYUNCS_API_KEY=
MOONSHOT_API_KEY=
BYTEDANCE_API_KEY=
```

Never commit `.env`.

## Quick Start

The recommended first workflow is the general translation workflow:

```text
workflows/general_translation/
```

Open `workflows/general_translation/run.ts` and fill in the user settings.

Here is an example:

```ts
const INPUT_FILE_PATH = String.raw`C:\path\to\your\book.txt`;
const BOOK_NAME = "my_book";
const SOURCE_LANGUAGE = "English";
const TARGET_LANGUAGE = "Chinese";
```

Then run:

```bash
npx tsx workflows/general_translation/run.ts
```

The workflow will:

1. Extract and split the input file.
2. Translate each chunk concurrently.
3. Merge the translated chunks into an EPUB.

Generated files are written under:

```text
data/general_translation/
```

The final EPUB is written under:

```text
data/general_translation/results/
```

## Translation With Alignment

For sentence-level aligned output, use:

```text
workflows/general_translation_alignment/
```

Fill in `workflows/general_translation_alignment/run.ts`, then run:

```bash
npx tsx workflows/general_translation_alignment/run.ts
```

This workflow outputs each translated sentence next to its matching source sentence. It is useful for bilingual reading, language learning, and translation review.

## Project Layout

```text
src/
  core/                  Core workflow runner and terminal output
  workflow_actions/      Built-in workflow actions
  validators/            Output validators
  cli/                   Utility commands

workflows/
  general_translation/            General translation workflow
  general_translation_alignment/  General translation and alignment workflow
  chinese_to_english_translation/ Chinese-to-English example workflow
  english_to_chinese_translation/ English-to-Chinese example workflow
  pdf_ocr_concurrent/             PDF OCR example workflow
  pdf_to_json_20pages/            PDF-to-JSON example workflow

models.yaml             Real model aliases and provider settings
models.mock.yaml        Optional mock model aliases for tests and demos
.env.example            Example environment variables
data/                   Local workflow outputs, ignored by Git
```

## How Workflows Work

A workflow usually has two files:

- `workflow.yaml` describes the workflow steps.
- `run.ts` provides user settings and starts the workflow.

The YAML file defines the graph, step types, model calls, file paths, concurrency, and output behavior. The TypeScript runner stays small and passes runtime values such as the input file path and book name.

## Resume Behavior

Conductor saves intermediate chunks under `data/<workflow_name>/artifacts/`.

If a long workflow stops halfway through, running it again can reuse completed artifact files instead of starting every chunk from zero. This is useful for long books and expensive LLM calls.

Keep these artifacts until you have checked the final output. After you no longer need to resume that run, you can safely delete that workflow's folder under `data/`.

Important: artifacts belong to the current run settings. If you change the input file, language, prompt, model, or workflow logic, delete that workflow's folder under `data/` before running again. Otherwise Conductor may reuse old artifacts from the previous run.

If you want a completely fresh run, delete that workflow's folder under `data/` before running the workflow again.

## Useful Commands

Run TypeScript type checking:

```bash
npm run typecheck
```

Run tests:

```bash
npm test
```

Build the project:

```bash
npm run build
```

## Model Configuration

Model aliases live in `models.yaml`.

Workflow YAML files refer to model aliases instead of hard-coding provider details:

```yaml
model: "deepseek-v4-flash-nonthinking"
```

To add or change a model, update `models.yaml`, then use that alias in your workflow.

## Notes For Contributors

- Keep API keys and private input files out of Git.
- Keep generated output under `data/`.
- Prefer adding reusable actions under `src/workflow_actions/`.
- Prefer adding user-facing examples under `workflows/`.
- Run `npm run typecheck` and `npm test` before submitting changes.

## License

MIT
