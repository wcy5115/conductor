import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRun } = vi.hoisted(() => ({
  mockRun: vi.fn(),
}));

vi.mock("../src/workflow_actions/llm_actions.js", () => ({
  LLMCallAction: class {
    run(...args: unknown[]) {
      return mockRun(...args);
    }
  },
}));

import { LLMRetriableError } from "../src/exceptions";
import { ConcurrentAction } from "../src/workflow_actions/concurrent_actions";

describe("ConcurrentAction retriable error classification", () => {
  beforeEach(() => {
    mockRun.mockReset();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records LLMRetriableError as retriable_error instead of fatal_error", async () => {
    mockRun.mockRejectedValue(new LLMRetriableError("temporary outage"));

    const action = new ConcurrentAction(
      "items",
      [
        {
          type: "llm_call",
          model: "test-model",
          prompt_template: "Translate {item}",
          validate_json: false,
        },
      ],
      1,
      0,
      10,
      "outputs",
      undefined,
      false,
      "NEXT",
      "Concurrent",
      "parallel",
    );

    const result = await action.execute({
      data: { items: ["chunk 1"] },
      history: [],
      metadata: {},
    } as any);

    expect(result.nextStep).toBe("NEXT");
    expect(result.data["outputs_stats"]).toMatchObject({
      failed: 1,
      retriable_failed: 1,
      fatal_failed: 0,
    });
    expect(result.metadata["concurrent_stats"]).toMatchObject({
      failed: 1,
      retriable_failed: 1,
      fatal_failed: 0,
    });
  });
});
