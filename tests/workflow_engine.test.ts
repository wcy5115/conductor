import { describe, expect, it } from "vitest";

import { WorkflowEngine, StepResult } from "../src/workflow_engine";
import { WorkflowGraph } from "../src/workflow_parser";
import type { StructuredLogger } from "../src/core/logging";

describe("WorkflowEngine", () => {
  it("starts at workflowGraph.startNode when startStep is omitted", async () => {
    const graph = new WorkflowGraph();
    graph.startNode = "A";
    graph.addEdge("A", "END");

    const engine = new WorkflowEngine(graph);
    engine.registerAction("A", () => new StepResult("END", { visited: "A" }));

    const context = await engine.runWorkflow();

    expect(context.history.map((entry) => entry["stepId"])).toEqual(["A"]);
    expect(context.data["visited"]).toBe("A");
    expect(context.metadata["startStep"]).toBe("A");
  });

  it("uses an explicit startStep before workflowGraph.startNode", async () => {
    const graph = new WorkflowGraph();
    graph.startNode = "A";
    graph.addEdge("A", "END");
    graph.addEdge("B", "END");

    const engine = new WorkflowEngine(graph);
    engine.registerAction("A", () => new StepResult("END", { visited: "A" }));
    engine.registerAction("B", () => new StepResult("END", { visited: "B" }));

    const context = await engine.runWorkflow({ startStep: "B" });

    expect(context.history.map((entry) => entry["stepId"])).toEqual(["B"]);
    expect(context.data["visited"]).toBe("B");
    expect(context.metadata["startStep"]).toBe("B");
  });

  it("uses the registered action name for structured step logs", async () => {
    const stepStarts: Array<{ stepId: string; stepName: string }> = [];
    const logger = {
      workflowStart: () => undefined,
      stepStart: (stepId: string, stepName: string) => {
        stepStarts.push({ stepId, stepName });
      },
      stepEnd: () => undefined,
      workflowEnd: () => undefined,
      info: () => undefined,
    } as unknown as StructuredLogger;

    const engine = new WorkflowEngine();
    const boundAction = function run() {
      return new StepResult("END");
    }.bind({});
    engine.registerAction("A", boundAction, "ConfiguredActionName");

    await engine.runWorkflow({ startStep: "A", workflowLogger: logger });

    expect(stepStarts).toEqual([
      { stepId: "A", stepName: "ConfiguredActionName" },
    ]);
  });
});
