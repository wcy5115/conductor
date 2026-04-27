/**
 * Cost calculation utilities.
 *
 * This module records token usage and estimates LLM call costs. Prices are
 * based on a "per one million tokens" unit and currently normalize results to
 * CNY, matching the existing public return type.
 *
 * Main exports:
 *   - calculateCost(): cost for one LLM call.
 *   - aggregateCosts(): combined cost for several calls.
 *   - formatCost(): display a number as a fixed-width currency string.
 *
 * Pricing data comes from MODEL_MAPPINGS through model_caller.ts.
 */

import { getModelPricingInfo } from "./model_caller.js";

// Temporary console-backed logger until the project-level logger is introduced.
const logger = {
  info: (msg: string) => console.info(msg),
  warn: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
  debug: (msg: string) => console.debug(msg),
};

// ============================================================
// Types
// ============================================================

/**
 * Cost summary for one or more LLM calls.
 */
export interface CostResult {
  input_cost: number;
  output_cost: number;
  total_cost: number;
  currency: "CNY";
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  pricing_available: boolean;
  model?: string;
  count?: number;
}

/**
 * Model pricing metadata from models.yaml.
 *
 * Values are prices per one million tokens.
 */
export interface PricingInfo {
  input: number;
  output: number;
  currency?: string;
}

// ============================================================
// Internal helpers
// ============================================================

/**
 * Round up to four decimal places.
 *
 * Math.ceil is intentional here: for cost accounting, rounding up prevents tiny
 * fractional costs from disappearing over many calls.
 */
function ceilTo4(value: number): number {
  const scaled = value * 10000;
  const nearestInteger = Math.round(scaled);
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 10;

  // Treat near-integers as exact so binary floating-point dust does not round
  // values like 0.30000000000000004 up to 0.3001.
  if (Math.abs(scaled - nearestInteger) <= tolerance) {
    return nearestInteger / 10000;
  }

  return Math.ceil(scaled) / 10000;
}

// ============================================================
// Public cost functions
// ============================================================

/**
 * Calculate the cost of one LLM call.
 *
 * Formula:
 *   cost = (tokens / 1_000_000) * price_per_million_tokens
 *
 * The function still returns token usage when no pricing is configured. In that
 * case all cost fields are zero and pricing_available is false.
 */
export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
): CostResult {
  const pricing = getModelPricingInfo(model);

  if (!pricing) {
    logger.warn(`Model '${model}' has no pricing configured; returning zero cost`);
    return {
      input_cost: 0,
      output_cost: 0,
      total_cost: 0,
      currency: "CNY",
      input_tokens: promptTokens,
      output_tokens: completionTokens,
      total_tokens: totalTokens,
      pricing_available: false,
    };
  }

  const inputCost = ceilTo4((promptTokens / 1_000_000) * pricing.input);
  const outputCost = ceilTo4((completionTokens / 1_000_000) * pricing.output);
  const totalCost = ceilTo4(inputCost + outputCost);

  logger.debug(
    `Cost [${model}]: input ${promptTokens} tokens=${formatCost(inputCost)}, ` +
      `output ${completionTokens} tokens=${formatCost(outputCost)}, ` +
      `total=${formatCost(totalCost)}`,
  );

  return {
    input_cost: inputCost,
    output_cost: outputCost,
    total_cost: totalCost,
    currency: "CNY",
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    total_tokens: totalTokens,
    pricing_available: true,
    model,
  };
}

/**
 * Format a cost value with four decimal places.
 */
export function formatCost(cost: number): string {
  return `¥${cost.toFixed(4)}`;
}

/**
 * Aggregate cost records from several LLM calls.
 *
 * Costs are rounded again after summing to avoid floating-point artifacts such
 * as 0.00030000000000000004.
 */
export function aggregateCosts(costList: CostResult[]): CostResult {
  if (costList.length === 0) {
    return {
      input_cost: 0,
      output_cost: 0,
      total_cost: 0,
      currency: "CNY",
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      pricing_available: false,
      count: 0,
    };
  }

  let totalInputCost = 0;
  let totalOutputCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalTokens = 0;

  for (const cost of costList) {
    totalInputCost += cost.input_cost;
    totalOutputCost += cost.output_cost;
    totalInputTokens += cost.input_tokens;
    totalOutputTokens += cost.output_tokens;
    totalTokens += cost.total_tokens;
  }

  totalInputCost = ceilTo4(totalInputCost);
  totalOutputCost = ceilTo4(totalOutputCost);
  const totalCost = ceilTo4(totalInputCost + totalOutputCost);

  logger.info(
    `Cost summary (${costList.length} calls): ` +
      `input ${totalInputTokens} tokens=${formatCost(totalInputCost)}, ` +
      `output ${totalOutputTokens} tokens=${formatCost(totalOutputCost)}, ` +
      `total=${formatCost(totalCost)}`,
  );

  return {
    input_cost: totalInputCost,
    output_cost: totalOutputCost,
    total_cost: totalCost,
    currency: "CNY",
    input_tokens: totalInputTokens,
    output_tokens: totalOutputTokens,
    total_tokens: totalTokens,
    pricing_available: costList.some((c) => c.pricing_available),
    count: costList.length,
  };
}

// ============================================================
// Token estimation
// ============================================================

/**
 * Estimate token count from plain text.
 *
 * This is a rough fallback for providers that do not return a usage object.
 * The CJK path is intentionally kept because the translator may process CJK
 * source text, even though the source code itself should not contain visible
 * Chinese prose.
 */
export function estimateTokensFromText(text: string): number {
  if (!text) return 0;

  const cjkCount = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const englishCount = (text.match(/[a-zA-Z]/g) ?? []).length;

  const cjkTokens = cjkCount * 0.3;
  const englishTokens = (englishCount / 3.0) * 0.3;
  const total = Math.floor(cjkTokens + englishTokens);

  logger.debug(
    `Token estimate: CJK ${cjkCount} chars * 0.3=${cjkTokens.toFixed(1)}, ` +
      `English ${englishCount} letters / 3 * 0.3=${englishTokens.toFixed(1)}, ` +
      `total~${total}`
  );

  return total;
}

// ============================================================
// Deprecated compatibility functions
// ============================================================

/**
 * Add model pricing at runtime.
 *
 * @deprecated Configure pricing in models.yaml and load it through
 * model_caller.ts instead.
 */
export function addModelPricing(
  model: string,
  inputPrice: number,
  outputPrice: number,
  _currency = "CNY",
): void {
  logger.warn(
    `addModelPricing() is deprecated; configure pricing in models.yaml instead. ` +
      `Attempted to add pricing for '${model}': input ${formatCost(inputPrice)}/M, output ${formatCost(outputPrice)}/M`,
  );
}

/**
 * Get pricing metadata for a model.
 *
 * @deprecated Use getModelPricingInfo() from model_caller.ts directly.
 */
export function getModelPricing(model: string): PricingInfo | null {
  return getModelPricingInfo(model);
}
