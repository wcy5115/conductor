import { describe, expect, it } from "vitest";

import {
  createZeroCostInfo,
  formatErrorContext,
  formatPathTemplate,
  safeGetCostInfo,
} from "../src/workflow_actions/utils";

describe("workflow action utilities", () => {
  it("returns CNY in zero-cost metadata", () => {
    expect(createZeroCostInfo()).toMatchObject({
      input_cost: 0,
      output_cost: 0,
      total_cost: 0,
      currency: "CNY",
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      pricing_available: false,
    });
  });

  it("fills missing cost metadata fields without overwriting existing currency", () => {
    const cost = safeGetCostInfo({
      cost: {
        total_cost: 0.12,
        completion_tokens: 42,
        currency: "USD",
      },
    });

    expect(cost).toMatchObject({
      total_cost: 0.12,
      input_cost: 0,
      output_cost: 0,
      input_tokens: 0,
      output_tokens: 42,
      total_tokens: 0,
      currency: "USD",
    });
  });

  it("uses CNY when cost metadata has no currency", () => {
    expect(safeGetCostInfo({ cost: { total_cost: 0 } })).toMatchObject({
      currency: "CNY",
    });
  });

  it("formats path templates with zero-padded numbers", () => {
    expect(formatPathTemplate("page_{index:04d}.json", { index: 3 })).toBe(
      "page_0003.json",
    );
  });

  it("formats error context in English", () => {
    const error = new TypeError("bad input");

    expect(formatErrorContext(error, "chapter 1", { type: "llm_call", model: "gpt" }, 2)).toBe(
      "Error: TypeError: TypeError: bad input | Item index: 2 | Item: chapter 1 | Step type: llm_call | Model: gpt",
    );
  });
});
