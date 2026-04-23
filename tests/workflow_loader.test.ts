import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as fs from "fs";
import * as path from "path";

import { WorkflowLoader } from "../src/workflow_loader";

const PROJECT_NAME = `workflow_loader_missing_step_${process.pid}`;
const TEMP_DIR = path.join(__dirname, "_tmp_workflow_loader");
const YAML_PATH = path.join(TEMP_DIR, "workflow.yaml");
const DATA_DIR = path.join(process.cwd(), "data", PROJECT_NAME);

function cleanup(): void {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

function waitForStreamClose(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

describe("WorkflowLoader", () => {
  beforeEach(() => {
    cleanup();
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  });

  afterEach(async () => {
    await waitForStreamClose();
    cleanup();
  });

  it("throws when workflow_graph references a step missing from steps", () => {
    fs.writeFileSync(
      YAML_PATH,
      [
        `project_name: "${PROJECT_NAME}"`,
        'workflow_graph: "1 -> missing_step -> END"',
        "steps:",
        "  1:",
        '    type: "log"',
        '    message: "started"',
        "",
      ].join("\n"),
      "utf-8",
    );

    const loader = new WorkflowLoader();

    expect(() => loader.loadFromYaml(YAML_PATH)).toThrow(
      "referenced step(s) missing from steps: missing_step",
    );
  });
});
