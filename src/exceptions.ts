/**
 * Custom exception classes.
 *
 * This module defines exception types related to LLM calls in workflows.
 *
 * Design note: failed LLM calls can still incur cost because the API has
 * already consumed tokens. Exceptions therefore need to carry cost information
 * so retries and failures do not lose accounting data.
 *
 * Typical flow:
 *   1. Call GPT-4 to generate text -> validation fails -> throw
 *      LLMValidationError with the cost of that call.
 *   2. The caller catches it and retries -> the retry also fails -> cumulative
 *      cost is attached to the final error.
 *   3. Whether the workflow eventually succeeds or fails, generated costs stay
 *      visible to the caller.
 */

// ============================================================
// CostInfo - LLM call cost information
// ============================================================

/**
 * Cost information for an LLM call.
 *
 * This is the normalized cost structure used by the workflow runtime. Costs
 * currently follow the project cost system, which uses CNY and displays values
 * with the yen/yuan symbol.
 */
export interface CostInfo {
  total_cost: number;         // Total cost in CNY, = input_cost + output_cost.
  input_cost: number;         // Cost of the input/prompt portion.
  output_cost: number;        // Cost of the output/completion portion.
  total_tokens: number;       // Total token count, = prompt_tokens + completion_tokens.
  pricing_available: boolean; // Whether pricing is available; false means a zero-cost fallback was used.
}

// ============================================================
// UsageInfo - LLM token usage information
// ============================================================

/**
 * Token usage information for an LLM call.
 *
 * This matches the usage field returned by LLM APIs. Field names follow the
 * common OpenAI-style convention: prompt_tokens and completion_tokens.
 */
export interface UsageInfo {
  prompt_tokens: number;      // Tokens consumed by the input/prompt.
  completion_tokens: number;  // Tokens consumed by the output/completion.
  total_tokens: number;       // Total token count, = prompt_tokens + completion_tokens.
}

// ============================================================
// LLMRetriableError - LLM/API failure that may succeed later
// ============================================================

export interface LLMRetriableErrorOptions {
  errorType?: string;
  statusCode?: number;
  causeValue?: unknown;
}

/**
 * Error thrown after an LLM/API call exhausts retriable attempts.
 *
 * This preserves the existing "retriable_error" classification across action
 * boundaries. Callers such as ConcurrentAction can inspect this type instead
 * of parsing strings like "API call failed (retriable)".
 */
export class LLMRetriableError extends Error {
  readonly status = "retriable_error";
  readonly errorType?: string;
  readonly statusCode?: number;
  readonly causeValue?: unknown;

  constructor(message: string, options: LLMRetriableErrorOptions = {}) {
    super(message);
    this.name = "LLMRetriableError";
    this.errorType = options.errorType;
    this.statusCode = options.statusCode;
    this.causeValue = options.causeValue;
  }
}

// ============================================================
// LLMValidationError - LLM validation failure
// ============================================================

/**
 * Error thrown when an LLM response fails validation.
 *
 * This is used when the LLM returns content that does not pass format
 * validation, such as invalid JSON or missing required fields. It extends the
 * standard Error object with cost and usage details.
 *
 * Why not use a plain Error?
 *   A plain Error only carries a message. Failed validation still costs money,
 *   so the error must preserve the cost and token usage from the failed call.
 *
 * Example:
 *   throw new LLMValidationError(
 *     "JSON parse failed: Unexpected token",
 *     { total_cost: 0.03, input_cost: 0.01, output_cost: 0.02, total_tokens: 500, pricing_available: true },
 *     { prompt_tokens: 200, completion_tokens: 300, total_tokens: 500 },
 *     2,              // Already retried twice.
 *     originalError   // Original SyntaxError.
 *   );
 */
export class LLMValidationError extends Error {
  // readonly prevents accidental changes after the error is constructed.
  readonly cost_info: CostInfo;        // Cumulative cost, including all retry attempts.
  readonly usage_info: UsageInfo;      // Cumulative token usage.
  readonly retry_attempts: number;     // Retry count; 0 means the first attempt failed.
  readonly original_error: unknown;    // Original validation error, such as SyntaxError.

  constructor(
    message: string,
    cost_info: CostInfo,
    usage_info: UsageInfo,
    retry_attempts: number,
    original_error?: unknown,
  ) {
    super(message);
    // Make logs and error.toString() show the specific error class.
    this.name = "LLMValidationError";
    this.cost_info = cost_info;
    this.usage_info = usage_info;
    this.retry_attempts = retry_attempts;
    this.original_error = original_error;
  }

  /**
   * Return a compact string representation.
   *
   * Example: "LLMValidationError: JSON parse failed [Cost: ¥0.0300, retries: 2]"
   * Four decimal places are used because single LLM calls can be very small.
   */
  toString(): string {
    const cost_msg = ` [Cost: ¥${this.cost_info.total_cost.toFixed(4)}, retries: ${this.retry_attempts}]`;
    return `${this.name}: ${this.message}${cost_msg}`;
  }
}
