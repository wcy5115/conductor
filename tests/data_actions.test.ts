import { describe, expect, it } from "vitest";

import { DataProcessAction } from "../src/workflow_actions/data_actions";

describe("DataProcessAction", () => {
  it("merges processor output into the step result", async () => {
    const action = new DataProcessAction(
      (data) => ({
        summary: `Hello, ${String(data["name"] ?? "world")}`,
      }),
      "NEXT"
    );

    const result = await action.execute({
      data: { name: "Codex" },
      history: [],
      metadata: {},
    } as any);

    expect(result.nextStep).toBe("NEXT");
    expect(result.data).toEqual({ summary: "Hello, Codex" });
    expect(result.metadata["processed_keys"]).toEqual(["summary"]);
  });

  it("throws a clear error when the processor returns a non-object value", async () => {
    const action = new DataProcessAction(
      (() => null) as unknown as (data: Record<string, unknown>) => Record<string, unknown>
    );

    await expect(
      action.execute({
        data: {},
        history: [],
        metadata: {},
      } as any)
    ).rejects.toThrow(
      "Data processor 'DataProcessAction' must return a plain object, received null"
    );
  });
});
