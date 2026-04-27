/**
 * Unit tests for src/cost_calculator.ts.
 *
 * These tests cover the pure calculation helpers:
 *   - calculateCost()
 *   - formatCost()
 *   - aggregateCosts()
 *   - estimateTokensFromText()
 *
 * ceilTo4() is private, so it is covered through public calculation behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock model_caller so cost tests can control pricing without reading the real
// models.yaml file.
vi.mock("../src/model_caller", () => ({
  getModelPricingInfo: vi.fn().mockReturnValue(null),
}));

import { getModelPricingInfo } from "../src/model_caller";
import {
  calculateCost,
  formatCost,
  aggregateCosts,
  estimateTokensFromText,
} from "../src/cost_calculator";
import type { CostResult } from "../src/cost_calculator";

// ============================================================
// calculateCost()
// ============================================================

describe("calculateCost", () => {
  beforeEach(() => {
    vi.mocked(getModelPricingInfo).mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns zero cost when pricing is unavailable", () => {
    const result = calculateCost("test-model", 100, 50, 150);
    expect(result.input_cost).toBe(0);
    expect(result.output_cost).toBe(0);
    expect(result.total_cost).toBe(0);
  });

  it("marks pricing_available as false when pricing is unavailable", () => {
    const result = calculateCost("unknown-model", 200, 100, 300);
    expect(result.pricing_available).toBe(false);
  });

  it("still records token usage when pricing is unavailable", () => {
    const result = calculateCost("some-model", 500, 200, 700);
    expect(result.input_tokens).toBe(500);
    expect(result.output_tokens).toBe(200);
    expect(result.total_tokens).toBe(700);
  });

  it("returns zero cost for zero tokens", () => {
    const result = calculateCost("test-model", 0, 0, 0);
    expect(result.total_cost).toBe(0);
    expect(result.input_tokens).toBe(0);
    expect(result.output_tokens).toBe(0);
    expect(result.total_tokens).toBe(0);
  });

  it("uses CNY as the normalized currency", () => {
    const result = calculateCost("any-model", 0, 0, 0);
    expect(result.currency).toBe("CNY");
  });

  it("calculates cost when pricing is available", () => {
    vi.mocked(getModelPricingInfo).mockReturnValue({
      input: 1.0,
      output: 2.0,
      currency: "CNY",
    });

    const result = calculateCost("priced-model", 1_000_000, 1_000_000, 2_000_000);
    expect(result.input_cost).toBe(1.0);
    expect(result.output_cost).toBe(2.0);
    expect(result.total_cost).toBe(3.0);
    expect(result.pricing_available).toBe(true);
    expect(result.model).toBe("priced-model");
  });

  it("rounds small calculated costs up to four decimal places", () => {
    vi.mocked(getModelPricingInfo).mockReturnValue({
      input: 0.0001,
      output: 0.0002,
      currency: "CNY",
    });

    const result = calculateCost("priced-model", 12345, 67890, 80235);
    expect(result.input_cost).toBe(0.0001);
    expect(result.output_cost).toBe(0.0001);
    expect(result.total_cost).toBe(0.0002);
    expect(result.pricing_available).toBe(true);
  });

  it("handles large token counts", () => {
    vi.mocked(getModelPricingInfo).mockReturnValue({
      input: 10.0,
      output: 20.0,
      currency: "CNY",
    });

    const result = calculateCost("priced-model", 10_000_000, 5_000_000, 15_000_000);
    expect(result.total_cost).toBe(200.0);
    expect(result.input_tokens).toBe(10_000_000);
    expect(result.output_tokens).toBe(5_000_000);
  });

  it("keeps total cost free of floating-point artifacts", () => {
    vi.mocked(getModelPricingInfo).mockReturnValue({
      input: 0.1,
      output: 0.2,
      currency: "CNY",
    });

    const result = calculateCost("priced-model", 1_000_000, 1_000_000, 2_000_000);
    expect(result.input_cost).toBe(0.1);
    expect(result.output_cost).toBe(0.2);
    expect(result.total_cost).toBe(0.3);
  });

  it("returns zero cost for zero tokens even when pricing is available", () => {
    vi.mocked(getModelPricingInfo).mockReturnValue({
      input: 1.0,
      output: 2.0,
      currency: "CNY",
    });

    const result = calculateCost("priced-model", 0, 0, 0);
    expect(result.total_cost).toBe(0);
    expect(result.pricing_available).toBe(true);
  });
});

// ============================================================
// formatCost()
// ============================================================

describe("formatCost", () => {
  it("formats an integer with four decimal places", () => {
    expect(formatCost(1)).toBe("¥1.0000");
  });

  it("pads a short decimal to four decimal places", () => {
    expect(formatCost(0.123)).toBe("¥0.1230");
  });

  it("formats zero", () => {
    expect(formatCost(0)).toBe("¥0.0000");
  });

  it("rounds when more than four decimal places are provided", () => {
    expect(formatCost(0.12345)).toBe("¥0.1235");
  });
});

// ============================================================
// aggregateCosts()
// ============================================================

describe("aggregateCosts", () => {
  it("returns zero totals for an empty list", () => {
    const result = aggregateCosts([]);
    expect(result.input_cost).toBe(0);
    expect(result.output_cost).toBe(0);
    expect(result.total_cost).toBe(0);
    expect(result.input_tokens).toBe(0);
    expect(result.output_tokens).toBe(0);
    expect(result.total_tokens).toBe(0);
    expect(result.count).toBe(0);
    expect(result.pricing_available).toBe(false);
  });

  it("passes through a single cost record", () => {
    const single: CostResult = {
      input_cost: 0.001,
      output_cost: 0.002,
      total_cost: 0.003,
      currency: "CNY",
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      pricing_available: true,
    };
    const result = aggregateCosts([single]);
    expect(result.input_cost).toBe(0.001);
    expect(result.output_cost).toBe(0.002);
    expect(result.total_cost).toBe(0.003);
    expect(result.input_tokens).toBe(100);
    expect(result.output_tokens).toBe(50);
    expect(result.total_tokens).toBe(150);
    expect(result.count).toBe(1);
    expect(result.pricing_available).toBe(true);
  });

  it("sums multiple cost records", () => {
    const cost1: CostResult = {
      input_cost: 0.001,
      output_cost: 0.002,
      total_cost: 0.003,
      currency: "CNY",
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      pricing_available: true,
    };
    const cost2: CostResult = {
      input_cost: 0.003,
      output_cost: 0.004,
      total_cost: 0.007,
      currency: "CNY",
      input_tokens: 300,
      output_tokens: 200,
      total_tokens: 500,
      pricing_available: true,
    };
    const result = aggregateCosts([cost1, cost2]);

    expect(result.input_tokens).toBe(400);
    expect(result.output_tokens).toBe(250);
    expect(result.total_tokens).toBe(650);
    expect(result.input_cost).toBe(0.004);
    expect(result.output_cost).toBe(0.006);
    expect(result.total_cost).toBe(0.01);
    expect(result.count).toBe(2);
  });

  it("marks pricing_available true when any record has pricing", () => {
    const withPricing: CostResult = {
      input_cost: 0.001,
      output_cost: 0.001,
      total_cost: 0.002,
      currency: "CNY",
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      pricing_available: true,
    };
    const withoutPricing: CostResult = {
      input_cost: 0,
      output_cost: 0,
      total_cost: 0,
      currency: "CNY",
      input_tokens: 200,
      output_tokens: 100,
      total_tokens: 300,
      pricing_available: false,
    };
    const result = aggregateCosts([withPricing, withoutPricing]);
    expect(result.pricing_available).toBe(true);
  });

  it("rounds tiny summed costs up to four decimal places", () => {
    const tiny1: CostResult = {
      input_cost: 0.00001,
      output_cost: 0.00001,
      total_cost: 0.00002,
      currency: "CNY",
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      pricing_available: true,
    };
    const tiny2: CostResult = {
      input_cost: 0.00002,
      output_cost: 0.00002,
      total_cost: 0.00004,
      currency: "CNY",
      input_tokens: 2,
      output_tokens: 2,
      total_tokens: 4,
      pricing_available: true,
    };
    const result = aggregateCosts([tiny1, tiny2]);

    expect(result.input_cost).toBe(0.0001);
    expect(result.output_cost).toBe(0.0001);
    expect(result.total_cost).toBe(0.0002);
    expect(result.count).toBe(2);
  });

  it("keeps aggregate total cost free of floating-point artifacts", () => {
    const cost: CostResult = {
      input_cost: 0.0001,
      output_cost: 0.0002,
      total_cost: 0.0003,
      currency: "CNY",
      input_tokens: 1,
      output_tokens: 2,
      total_tokens: 3,
      pricing_available: true,
    };
    const result = aggregateCosts([cost]);

    expect(result.input_cost).toBe(0.0001);
    expect(result.output_cost).toBe(0.0002);
    expect(result.total_cost).toBe(0.0003);
  });

  it("marks pricing_available false when no record has pricing", () => {
    const noPricing1: CostResult = {
      input_cost: 0,
      output_cost: 0,
      total_cost: 0,
      currency: "CNY",
      input_tokens: 50,
      output_tokens: 30,
      total_tokens: 80,
      pricing_available: false,
    };
    const noPricing2: CostResult = {
      input_cost: 0,
      output_cost: 0,
      total_cost: 0,
      currency: "CNY",
      input_tokens: 60,
      output_tokens: 40,
      total_tokens: 100,
      pricing_available: false,
    };
    const result = aggregateCosts([noPricing1, noPricing2]);
    expect(result.pricing_available).toBe(false);
  });
});

// ============================================================
// estimateTokensFromText()
// ============================================================

describe("estimateTokensFromText", () => {
  it("returns 0 for empty text", () => {
    expect(estimateTokensFromText("")).toBe(0);
  });

  it("estimates CJK-only text", () => {
    expect(estimateTokensFromText("\u4f60\u597d\u4e16\u754c")).toBe(1);
  });

  it("estimates longer CJK text", () => {
    const text = "\u8fd9\u662f\u4e00\u4e2a\u7528\u6765\u6d4b\u8bd5\u7684\u4e2d\u6587\u53e5\u5b50";
    expect(estimateTokensFromText(text)).toBe(3);
  });

  it("estimates English-only text without spaces", () => {
    expect(estimateTokensFromText("HelloWorld")).toBe(1);
  });

  it("estimates English-only text with spaces", () => {
    expect(estimateTokensFromText("Hello World")).toBe(1);
  });

  it("estimates short mixed CJK and English text", () => {
    expect(estimateTokensFromText("\u4f60\u597dHello")).toBe(1);
  });

  it("estimates longer mixed CJK and English text", () => {
    expect(estimateTokensFromText("\u4f60\u597dHello\u4e16\u754cWorld")).toBe(2);
  });

  it("ignores numbers and punctuation", () => {
    expect(estimateTokensFromText("12345!@#$%")).toBe(0);
  });

  it("counts only CJK and English characters in mixed punctuation text", () => {
    expect(estimateTokensFromText("\u6d4b\u8bd5123abc!")).toBe(0);
  });
});
