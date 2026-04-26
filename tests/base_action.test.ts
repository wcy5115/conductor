import { describe, expect, it, vi } from "vitest";

import { StepResult, WorkflowContext } from "../src/workflow_engine";
import { BaseAction } from "../src/workflow_actions/base";

class FailingAction extends BaseAction {
  async execute(): Promise<StepResult> {
    throw new Error("boom");
  }
}

class CostFailingAction extends BaseAction {
  constructor() {
    super("CostFailingAction");
    this._lastCostInfo = { total_cost: 0.25, currency: "USD" };
  }

  async execute(): Promise<StepResult> {
    throw new Error("validation failed");
  }
}

describe("BaseAction", () => {
  it("records failed actions with the same stepId key used by workflow history", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const context = new WorkflowContext({ workflowId: "test" });
    const action = new FailingAction("BrokenAction");

    await expect(action.run(context)).rejects.toThrow("boom");

    expect(context.history).toHaveLength(1);
    expect(context.history[0]).toMatchObject({
      stepId: "error",
      data: {},
      metadata: {
        action_name: "BrokenAction",
        error: "Error: boom",
        failed: true,
      },
    });
    expect(context.history[0]?.["step_id"]).toBeUndefined();
    expect(context.getStepResult("error")).toBe(context.history[0]);

    vi.restoreAllMocks();
  });

  it("preserves recorded cost metadata when an action fails", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const context = new WorkflowContext({ workflowId: "test" });

    await expect(new CostFailingAction().run(context)).rejects.toThrow(
      "validation failed"
    );

    expect(context.history[0]?.["metadata"]).toMatchObject({
      action_name: "CostFailingAction",
      cost: { total_cost: 0.25, currency: "USD" },
      failed: true,
    });

    vi.restoreAllMocks();
  });
});
