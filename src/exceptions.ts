/**
 * 自定义异常类
 *
 * 用于在异常情况下也能正确传递成本信息
 */

export interface CostInfo {
  total_cost: number;
  input_cost: number;
  output_cost: number;
  total_tokens: number;
  pricing_available: boolean;
}

export interface UsageInfo {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * LLM 验证失败异常
 *
 * 携带成本信息，确保即使验证失败也能正确统计成本。
 * 这是关键的成本追踪机制，防止重试成本丢失。
 */
export class LLMValidationError extends Error {
  readonly cost_info: CostInfo;
  readonly usage_info: UsageInfo;
  readonly retry_attempts: number;
  readonly original_error: unknown;

  constructor(
    message: string,
    cost_info: CostInfo,
    usage_info: UsageInfo,
    retry_attempts: number,
    original_error?: unknown,
  ) {
    super(message);
    this.name = "LLMValidationError";
    this.cost_info = cost_info;
    this.usage_info = usage_info;
    this.retry_attempts = retry_attempts;
    this.original_error = original_error;
  }

  toString(): string {
    const cost_msg = ` [成本: ¥${this.cost_info.total_cost.toFixed(4)}, 重试: ${this.retry_attempts}次]`;
    return `${this.name}: ${this.message}${cost_msg}`;
  }
}
