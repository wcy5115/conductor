/**
 * 自定义异常类
 *
 * 本模块定义了工作流中 LLM 调用相关的异常类型。
 *
 * 核心设计思路：LLM 调用即使失败也会产生费用（API 已消耗 token），
 * 因此异常对象必须携带成本信息，防止重试/失败时成本数据丢失。
 *
 * 典型场景：
 *   1. 调用 GPT-4 生成文本 → 格式校验失败 → 抛出 LLMValidationError（附带本次调用的费用）
 *   2. 上层捕获后决定重试 → 重试也失败 → 累计成本一并记录在最终的异常中
 *   3. 无论最终成功或失败，所有产生的费用都不会丢失
 */

// ============================================================
// CostInfo — LLM 调用的费用信息
// ============================================================

/**
 * LLM 调用的费用信息
 *
 * 对应 LLM API 返回的计费数据，经过标准化后的统一结构。
 * 与 utils.ts 中 createZeroCostInfo 返回的字段一致（但这里是强类型接口）。
 */
export interface CostInfo {
  total_cost: number;         // 总费用（美元），= input_cost + output_cost
  input_cost: number;         // 输入（prompt）部分的费用
  output_cost: number;        // 输出（completion）部分的费用
  total_tokens: number;       // 总 token 数（= prompt_tokens + completion_tokens）
  pricing_available: boolean; // 是否有可用的定价信息（false 表示费用为估算或默认零值）
}

// ============================================================
// UsageInfo — LLM 调用的 token 用量信息
// ============================================================

/**
 * LLM 调用的 token 用量信息
 *
 * 对应 LLM API 返回的 usage 字段。
 * 字段命名沿用 OpenAI API 的惯例（prompt_tokens / completion_tokens）。
 */
export interface UsageInfo {
  prompt_tokens: number;      // 输入（prompt）消耗的 token 数
  completion_tokens: number;  // 输出（completion）消耗的 token 数
  total_tokens: number;       // 总 token 数（= prompt_tokens + completion_tokens）
}

// ============================================================
// LLMValidationError — LLM 验证失败异常
// ============================================================

/**
 * LLM 验证失败异常
 *
 * 当 LLM 返回的内容未通过格式校验（如 JSON 解析失败、缺少必填字段）时抛出。
 * 继承自标准 Error，额外携带成本和用量信息。
 *
 * 为什么不用普通 Error？
 *   普通 Error 只有 message，无法传递成本数据。
 *   而 LLM 调用即使输出无效，API 费用已经产生，必须记录下来。
 *
 * 使用示例：
 *   throw new LLMValidationError(
 *     "JSON 解析失败：Unexpected token",
 *     { total_cost: 0.03, input_cost: 0.01, output_cost: 0.02, total_tokens: 500, pricing_available: true },
 *     { prompt_tokens: 200, completion_tokens: 300, total_tokens: 500 },
 *     2,              // 已重试 2 次
 *     originalError   // 原始的 SyntaxError
 *   );
 */
export class LLMValidationError extends Error {
  // readonly 表示构造后不可修改，确保异常信息不被意外篡改
  readonly cost_info: CostInfo;        // 累计费用信息（包含所有重试的总费用）
  readonly usage_info: UsageInfo;      // 累计 token 用量
  readonly retry_attempts: number;     // 已重试次数（0 表示首次就失败）
  readonly original_error: unknown;    // 触发验证失败的原始异常（如 SyntaxError），用于调试追溯

  constructor(
    message: string,
    cost_info: CostInfo,
    usage_info: UsageInfo,
    retry_attempts: number,
    original_error?: unknown,
  ) {
    // 调用父类 Error 的构造函数，设置 this.message
    super(message);
    // 手动设置 name 属性，使 error.name 显示为 "LLMValidationError" 而非默认的 "Error"
    // 这在日志和 error.toString() 中会更清晰
    this.name = "LLMValidationError";
    this.cost_info = cost_info;
    this.usage_info = usage_info;
    this.retry_attempts = retry_attempts;
    this.original_error = original_error;
  }

  /**
   * 自定义字符串表示
   *
   * 输出示例："LLMValidationError: JSON 解析失败 [成本: ¥0.0300, 重试: 2次]"
   * toFixed(4) 保留 4 位小数，因为 LLM 单次调用费用通常很小（几分钱级别）
   */
  toString(): string {
    const cost_msg = ` [成本: ¥${this.cost_info.total_cost.toFixed(4)}, 重试: ${this.retry_attempts}次]`;
    return `${this.name}: ${this.message}${cost_msg}`;
  }
}
