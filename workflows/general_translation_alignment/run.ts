/**
 * General translation and alignment workflow runner.
 *
 * Usage:
 *   npx tsx workflows/general_translation_alignment/run.ts
 */

import "dotenv/config";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { WorkflowRunner } from "../../src/core/workflow_runner.js";

// ============================================================
// User settings
// Fill in these values before running the workflow.
// ============================================================

const INPUT_FILE_PATH = String.raw``;
const BOOK_NAME = "";
const SOURCE_LANGUAGE = "";
const TARGET_LANGUAGE = "";

const SUPPORTED_EXTENSIONS = new Set([".epub", ".txt"]);

async function main(): Promise<void> {
  if (!INPUT_FILE_PATH || !BOOK_NAME || !SOURCE_LANGUAGE || !TARGET_LANGUAGE) {
    console.error("Please fill in INPUT_FILE_PATH, BOOK_NAME, SOURCE_LANGUAGE, and TARGET_LANGUAGE in this runner.");
    process.exit(1);
  }

  if (!fs.existsSync(INPUT_FILE_PATH)) {
    console.error(`Input file not found: ${INPUT_FILE_PATH}`);
    console.error("Please update INPUT_FILE_PATH in this runner.");
    process.exit(1);
  }

  const ext = path.extname(INPUT_FILE_PATH).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    console.error(`Unsupported file format: ${ext}; supported: ${[...SUPPORTED_EXTENSIONS].join(", ")}`);
    process.exit(1);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const yamlPath = path.join(__dirname, "workflow.yaml");

  const runner = await WorkflowRunner.fromYaml(yamlPath);
  const result = await runner.run({
    inputData: {
      input_epub: INPUT_FILE_PATH,
      book_name: BOOK_NAME,
      source_language: SOURCE_LANGUAGE,
      target_language: TARGET_LANGUAGE,
    },
    cleanupOnSuccess: false,
  });

  if (result.status === "failed") {
    console.error(`Workflow failed: ${result.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
