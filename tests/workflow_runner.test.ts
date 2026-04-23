import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as fs from "fs";
import * as path from "path";

import { WorkflowRunner } from "../src/core/workflow_runner";

const PROJECT_NAME = `workflow_runner_start_node_${process.pid}`;
const TEMP_DIR = path.join(__dirname, "_tmp_workflow_runner");
const YAML_PATH = path.join(TEMP_DIR, "workflow.yaml");
const DATA_DIR = path.join(process.cwd(), "data", PROJECT_NAME);
let runner: WorkflowRunner | undefined;

function cleanup(): void {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

function closeRunnerLogger(): void {
  const runnerWithLogger = runner as
    | { logger?: { close: () => void } }
    | undefined;
  runnerWithLogger?.logger?.close();
  runner = undefined;
}

function waitForStreamClose(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

describe("WorkflowRunner", () => {
  beforeEach(() => {
    cleanup();
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  });

  afterEach(async () => {
    closeRunnerLogger();
    await waitForStreamClose();
    cleanup();
  });

  it("runs a YAML workflow from workflowGraph.startNode when it is not step 1", async () => {
    fs.writeFileSync(
      YAML_PATH,
      [
        `project_name: "${PROJECT_NAME}"`,
        'workflow_graph: "A -> END"',
        "steps:",
        "  A:",
        '    type: "log"',
        '    message: "started at A"',
        '    level: "INFO"',
        "",
      ].join("\n"),
      "utf-8",
    );

    runner = await WorkflowRunner.fromYaml(YAML_PATH);
    const result = await runner.run({ inputData: {} });

    expect(result.status).toBe("success");
    expect(result.context?.metadata["startStep"]).toBe("A");
    expect(result.context?.history.map((entry) => entry["stepId"])).toEqual(["A"]);

    closeRunnerLogger();
    await waitForStreamClose();

    const logPath = path.join(DATA_DIR, "logs", "workflow.jsonl");
    const stepStartLog = fs
      .readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry["event_type"] === "step_start");
    const stepStartData = stepStartLog?.["data"] as
      | Record<string, unknown>
      | undefined;

    expect(stepStartData?.["step_name"]).toBe("Log_A");
  });
});
