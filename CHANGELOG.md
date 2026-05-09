# Changelog

## [0.1.2] - 2026-05-09

### Fixed

- Preserved exhausted retriable LLM/API failures as `retriable_error` inside
  concurrent steps instead of flattening them into `fatal_error`.
- Applied the same `llm_call` retry parameters to both top-level and
  concurrent LLM calls.


## [0.1.1] - 2026-05-08

### Changed

- Normalized quoted English-to-Chinese workflow input paths by trimming whitespace
  and removing matching wrapping single or double quotes before validation and
  execution.


## [0.1.0] - 2026-05-06

Initial public preview.

### Added

- YAML-defined workflow graphs for LLM orchestration.
- TypeScript workflow runner for loading and executing workflow files.
- Model alias configuration through `models.yaml`.
- Environment-based API key loading with `.env.example`.
- Concurrent chunk processing for long translation workflows.
- Resume-friendly artifact output under `data/`.
- General translation and translation-alignment workflow examples.
- Chinese-to-English and English-to-Chinese example workflows.
- PDF OCR and PDF-to-JSON example workflows.
- Mock LLM support for local tests and demos.
- Built-in validators for JSON and PDF page output.
- Test coverage for core workflow engine, actions, model calls, and utilities.

### Changed

- Prepared example runners for public use by removing local machine paths.
- Updated provider documentation to match the current OpenRouter default.
- Strengthened ignore rules for local environment files.

