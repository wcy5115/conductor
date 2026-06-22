/**
 * Custom Exception Classes
 *
 * This module defines exception types related to LLM calls in workflows.
 *
 * Core design principle: LLM calls incur costs even when they fail (API has already consumed tokens),
 * so exception objects must carry cost information to prevent cost data loss during retries/failures.
 *
 * Typical scenarios:
 *   1. Call GPT-4 to generate text → format validation fails → throw LLMValidationError (with cost of this call)
 *   2. Upper layer catches and decides to retry → retry also fails → cumulative cost recorded in final exception
 *   3. Whether ultimately successful or failed, all incurred costs are never lost
 */

// ============================================================
// CostInfo — Cost information for LLM calls
// ============================================================

/**
 * Cost information for LLM calls
 *
 * Corresponds to billing data returned by LLM APIs, standardized into a unified structure.
 * Fields are consistent with createZeroCostInfo in utils.ts (but this is a strongly-typed interface).
 */
export interface CostInfo {
  total_cost: number;         // Total cost (USD), = input_cost + output_cost
  input_cost: number;         // Cost of input (prompt) portion
  output_cost: number;        // Cost of output (completion) portion
  total_tokens: number;       // Total token count (= prompt_tokens + completion_tokens)
  pricing_available: boolean; // Whether pricing info is available (false means cost is estimated or default zero)
}

// ============================================================
// UsageInfo — Token usage information for LLM calls
// ============================================================

/**
 * Token usage information for LLM calls
 *
 * Corresponds to the usage field returned by LLM APIs.
 * Field naming follows OpenAI API conventions (prompt_tokens / completion_tokens).
 */
export interface UsageInfo {
  prompt_tokens: number;      // Tokens consumed by input (prompt)
  completion_tokens: number;  // Tokens consumed by output (completion)
  total_tokens: number;       // Total tokens (= prompt_tokens + completion_tokens)
}

// ============================================================
// LLMValidationError — LLM validation failure exception
// ============================================================

/**
 * LLM Validation Failure Exception
 *
 * Thrown when LLM output fails format validation (e.g., JSON parse failure, missing required fields).
 * Extends standard Error with additional cost and usage information.
 *
 * Why not use a plain Error?
 *   A plain Error only has message and cannot carry cost data.
 *   But LLM calls incur API costs even when output is invalid, so costs must be recorded.
 *
 * Usage example:
 *   throw new LLMValidationError(
 *     "JSON parse failed: Unexpected token",
 *     { total_cost: 0.03, input_cost: 0.01, output_cost: 0.02, total_tokens: 500, pricing_available: true },
 *     { prompt_tokens: 200, completion_tokens: 300, total_tokens: 500 },
 *     2,              // Already retried 2 times
 *     originalError   // Original SyntaxError
 *   );
 */
export class LLMValidationError extends Error {
  // readonly means immutable after construction, ensuring exception info is not accidentally modified
  readonly cost_info: CostInfo;        // Cumulative cost info (includes total cost of all retries)
  readonly usage_info: UsageInfo;      // Cumulative token usage
  readonly retry_attempts: number;     // Number of retries (0 means failed on first attempt)
  readonly original_error: unknown;    // Original exception that triggered validation failure (e.g., SyntaxError), for debugging

  constructor(
    message: string,
    cost_info: CostInfo,
    usage_info: UsageInfo,
    retry_attempts: number,
    original_error?: unknown,
  ) {
    // Call parent Error constructor to set this.message
    super(message);
    // Manually set name property so error.name shows "LLMValidationError" instead of default "Error"
    // This is clearer in logs and error.toString()
    this.name = "LLMValidationError";
    this.cost_info = cost_info;
    this.usage_info = usage_info;
    this.retry_attempts = retry_attempts;
    this.original_error = original_error;
  }

  /**
   * Custom string representation
   *
   * Output example: "LLMValidationError: JSON parse failed [Cost: $0.0300, Retries: 2]"
   * toFixed(4) keeps 4 decimal places since LLM per-call costs are typically very small (cents level)
   */
  toString(): string {
    const cost_msg = ` [成本: ¥${this.cost_info.total_cost.toFixed(4)}, 重试: ${this.retry_attempts}次]`;
    return `${this.name}: ${this.message}${cost_msg}`;
  }
}
