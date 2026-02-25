/**
 * 成本计算模块
 * 提供 Token 使用统计和费用计算功能
 *
 * 注意：价格配置在 model_caller.ts 的 MODEL_MAPPINGS 中
 */

// 暂用 console 作为日志占位，待 core/logging.ts 迁移后替换
const logger = {
  info: (msg: string) => console.info(msg),
  warn: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
  debug: (msg: string) => console.debug(msg),
};

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

export interface PricingInfo {
  input: number; // 人民币/百万 tokens
  output: number; // 人民币/百万 tokens
  currency?: string;
}

/** 向上取整到 4 位小数 */
function ceilTo4(value: number): number {
  return Math.ceil(value * 10000) / 10000;
}

/**
 * 计算 LLM 调用成本（人民币）
 *
 * @param model 模型名称
 * @param promptTokens 输入 tokens 数量
 * @param completionTokens 输出 tokens 数量
 * @param totalTokens 总 tokens 数量
 * @returns 包含成本信息的对象
 */
export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
): CostResult {
  // TODO: 待 model_caller.ts 迁移后，替换为 getModelPricingInfo(model)
  const pricing: PricingInfo | null = null;

  if (!pricing) {
    logger.warn(`模型 '${model}' 没有配置价格，返回零成本`);
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

  // 公式：(tokens / 1,000,000) × 单价，向上取整到 4 位小数
  const inputCost = ceilTo4((promptTokens / 1_000_000) * pricing.input);
  const outputCost = ceilTo4((completionTokens / 1_000_000) * pricing.output);
  const totalCost = inputCost + outputCost;

  logger.debug(
    `成本计算 [${model}]: 输入${promptTokens}tokens=¥${inputCost.toFixed(4)}, ` +
      `输出${completionTokens}tokens=¥${outputCost.toFixed(4)}, ` +
      `总计¥${totalCost.toFixed(4)}`,
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
 * 格式化成本显示
 *
 * @param cost 成本金额
 * @returns 格式化字符串，如 "¥0.1235"
 */
export function formatCost(cost: number): string {
  return `¥${cost.toFixed(4)}`;
}

/**
 * 汇总多个成本记录
 *
 * @param costList 成本对象列表
 * @returns 汇总后的成本信息
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

  // 向上取整到 4 位小数
  totalInputCost = ceilTo4(totalInputCost);
  totalOutputCost = ceilTo4(totalOutputCost);
  const totalCost = totalInputCost + totalOutputCost;

  logger.info(
    `成本汇总 (${costList.length}次调用): ` +
      `输入${totalInputTokens}tokens=¥${totalInputCost.toFixed(4)}, ` +
      `输出${totalOutputTokens}tokens=¥${totalOutputCost.toFixed(4)}, ` +
      `总计¥${totalCost.toFixed(4)}`,
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

/**
 * 动态添加模型价格配置
 *
 * @deprecated 请在 model_caller.ts 的 MODEL_MAPPINGS 中配置价格
 */
export function addModelPricing(
  model: string,
  inputPrice: number,
  outputPrice: number,
  _currency = "CNY",
): void {
  logger.warn(
    `addModelPricing() 已废弃，请在 model_caller.ts 的 MODEL_MAPPINGS 中配置价格。` +
      `尝试为模型 '${model}' 添加价格: 输入¥${inputPrice}/M, 输出¥${outputPrice}/M`,
  );
  // TODO: 待 model_caller.ts 迁移后，调用 addCustomModel()
}

/**
 * 获取模型价格配置
 *
 * @deprecated 请直接使用 model_caller.ts 的 getModelPricingInfo()
 */
export function getModelPricing(_model: string): PricingInfo | null {
  // TODO: 待 model_caller.ts 迁移后，替换为 getModelPricingInfo(model)
  return null;
}
