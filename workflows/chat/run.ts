/**
 * Simple chat workflow runner
 *
 * Usage:
 *   npx tsx workflows/chat/run.ts
 */

// dotenv loads environment variables, such as API keys, from a local .env file.
import "dotenv/config";

// path is Node.js's built-in path helper, used here to locate simple.yaml next to this file.
import path from "path";

// fileURLToPath converts import.meta.url, a file:// URL, into a normal filesystem path.
// Example: fileURLToPath(import.meta.url) returns the absolute path of the current file.
import { fileURLToPath } from "url";

// WorkflowRunner wraps the full flow: load YAML, create the engine, run steps, and print a report.
import { WorkflowRunner } from "../../src/core/workflow_runner.js";

// ============================================================
// Configuration
// ============================================================

// MODEL is the short model alias. It must match a key in models.yaml.
const MODEL = "fast";

// USER_INPUT is the prompt sent to the model.
const USER_INPUT = "Hello. Please introduce yourself in one sentence.";

// ============================================================
// Main function
// ============================================================

async function main(): Promise<void> {
  // Step 1: Locate the directory of this file and build the path to simple.yaml.
  // import.meta.url returns the current module URL, such as file:///D:/xxx/run.ts.
  // fileURLToPath converts that URL into a system path, such as D:/xxx/run.ts.
  // path.dirname returns only the directory part, such as D:/xxx/.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const yamlPath = path.join(__dirname, "simple.yaml");

  // Step 2: Create a WorkflowRunner instance from the YAML file.
  const runner = await WorkflowRunner.fromYaml(yamlPath);

  // Step 3: Run the workflow with initial data.
  // simple.yaml references {user_input} in prompt and {model} in model.
  // These values are passed through inputData, and the engine replaces the template placeholders.
  const result = await runner.run({
    inputData: {
      user_input: USER_INPUT,
      model: MODEL,
    },
  });

  // Step 4: Exit with an error code when the workflow fails.
  if (result.status === "failed") {
    console.error(`Workflow failed: ${result.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
