/**
 * English-to-Chinese translation workflow runner.
 *
 * Usage:
 *   npx tsx workflows/english_to_chinese_translation/run.ts
 */

import "dotenv/config";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { WorkflowRunner } from "../../src/core/workflow_runner.js";

const INPUT_EPUB = String.raw``;
const BOOK_NAME = "";

const SUPPORTED_EXTENSIONS = new Set([".epub", ".txt"]);

async function main(): Promise<void> {
  if (!INPUT_EPUB || !BOOK_NAME) {
    console.error("Please fill in INPUT_EPUB and BOOK_NAME in this runner.");
    process.exit(1);
  }

  if (!fs.existsSync(INPUT_EPUB)) {
    console.error(`Input file not found: ${INPUT_EPUB}`);
    console.error("Please update INPUT_EPUB in this runner.");
    process.exit(1);
  }

  const ext = path.extname(INPUT_EPUB).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    console.error(`Unsupported file format: ${ext}; supported: ${[...SUPPORTED_EXTENSIONS].join(", ")}`);
    process.exit(1);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const yamlPath = path.join(__dirname, "workflow.yaml");

  const runner = await WorkflowRunner.fromYaml(yamlPath);
  const result = await runner.run({
    inputData: {
      input_epub: INPUT_EPUB,
      book_name: BOOK_NAME,
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
