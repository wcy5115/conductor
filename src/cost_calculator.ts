/**
 * 成本计算模块
 *
 * 提供 LLM 调用的 Token 使用统计和费用计算功能。
 * 所有金额单位为人民币（CNY），所有价格基于"每百万 token"的单价。
 *
 * 主要功能：
 *   - calculateCost()   — 计算单次 LLM 调用的费用
 *   - aggregateCosts()  — 汇总多次调用的费用
 *   - formatCost()      — 将金额格式化为可读字符串（如 "¥0.1235"）
 *
 * 价格数据来源：model_caller.ts 中的 MODEL_MAPPINGS（从 models.yaml 加载）
 *
 * 计费公式：
 *   费用 = (token 数 / 1,000,000) × 每百万 token 单价
 *   例如：输入 500 tokens，单价 20 元/百万 → (500 / 1_000_000) × 20 = ¥0.01
 */

// 暂用 console 作为日志占位，待 core/logging.ts 迁移后替换
const logger = {
  info: (msg: string) => console.info(msg),
  warn: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
  debug: (msg: string) => console.debug(msg),
};

// ============================================================
// 类型定义
// ============================================================

/**
 * 成本计算结果
 *
 * 一次或多次 LLM 调用的费用汇总。既用于单次计算的返回值，也用于 aggregateCosts 的汇总结果。
 */
export interface CostResult {
  input_cost: number;          // 输入（prompt）部分的费用（元）
  output_cost: number;         // 输出（completion）部分的费用（元）
  total_cost: number;          // 总费用（元），= input_cost + output_cost
  currency: "CNY";             // 货币类型，固定为人民币（字面量类型，只允许 "CNY" 这一个值）
  input_tokens: number;        // 输入 token 数
  output_tokens: number;       // 输出 token 数
  total_tokens: number;        // 总 token 数
  pricing_available: boolean;  // 是否有可用的定价信息（false 表示模型未配置价格，费用为 0）
  model?: string;              // 模型名称（可选，单次计算时填写）
  count?: number;              // 调用次数（可选，汇总时填写）
}

/**
 * 模型定价信息
 *
 * 来自 models.yaml 中每个模型的 pricing 字段。
 * 单位：人民币/百万 tokens。
 *
 * 示例（deepseek-chat）：
 *   { input: 1, output: 2 }  → 输入 1 元/百万 tokens，输出 2 元/百万 tokens
 */
export interface PricingInfo {
  input: number;     // 输入价格（元/百万 tokens）
  output: number;    // 输出价格（元/百万 tokens）
  currency?: string; // 货币类型（可选，默认 CNY）
}

// ============================================================
// 内部工具函数
// ============================================================

/**
 * 向上取整到 4 位小数
 *
 * 为什么用 Math.ceil 而不是 Math.round？
 *   计费场景下向上取整对服务提供方更公平，避免长期累计的舍入误差导致少收费。
 *   4 位小数精度足够（最小单位 ¥0.0001 = 0.01 分）。
 *
 * 计算过程：先乘 10000 放大到整数位 → ceil 向上取整 → 再除回来
 * 示例：ceilTo4(0.00123456) → Math.ceil(12.3456) = 13 → 13 / 10000 = 0.0013
 */
function ceilTo4(value: number): number {
  return Math.ceil(value * 10000) / 10000;
}

// ============================================================
// 核心函数
// ============================================================

/**
 * 计算单次 LLM 调用的成本（人民币）
 *
 * 计算流程：
 *   1. 查询模型的定价信息（目前为 TODO 占位，始终返回零成本）
 *   2. 分别计算输入和输出费用：(token 数 / 1_000_000) × 单价
 *   3. 向上取整到 4 位小数
 *
 * 使用示例：
 *   const result = calculateCost("deepseek-chat", 1000, 500, 1500);
 *   // → { input_cost: 0.001, output_cost: 0.001, total_cost: 0.002, ... }
 *
 * @param model            模型名称（用于查找定价）
 * @param promptTokens     输入 token 数量
 * @param completionTokens 输出 token 数量
 * @param totalTokens      总 token 数量（通常 = promptTokens + completionTokens）
 * @returns 包含费用明细的 CostResult 对象
 */
export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
): CostResult {
  // 第一步：获取模型的定价信息
  // TODO: 待 model_caller.ts 迁移后，替换为 getModelPricingInfo(model)
  // 强制为联合类型 PricingInfo | null，防止 TS 将字面量 null 收窄为 never 类型
  // 如果不加类型断言，TS 会认为 pricing 永远是 null，从而将下方 if (!pricing) 之后的代码标记为不可达
  const pricing = null as PricingInfo | null;

  // 模型未配置价格 → 返回零成本，但仍记录 token 用量
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

  // 第二步：计算费用
  // 公式：(token 数 / 1,000,000) × 每百万 token 单价，结果向上取整到 4 位小数
  // 例如：promptTokens=1000, pricing.input=20 → (1000/1_000_000) × 20 = 0.02 → ceilTo4 → ¥0.02
  const inputCost = ceilTo4((promptTokens / 1_000_000) * pricing.input);
  const outputCost = ceilTo4((completionTokens / 1_000_000) * pricing.output);
  const totalCost = inputCost + outputCost;

  logger.debug(
    `成本计算 [${model}]: 输入${promptTokens}tokens=¥${inputCost.toFixed(4)}, ` +
      `输出${completionTokens}tokens=¥${outputCost.toFixed(4)}, ` +
      `总计¥${totalCost.toFixed(4)}`,
  );

  // 第三步：组装返回值
  return {
    input_cost: inputCost,
    output_cost: outputCost,
    total_cost: totalCost,
    currency: "CNY",
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    total_tokens: totalTokens,
    pricing_available: true,  // 有定价信息
    model,                    // ES6 简写，等同于 model: model
  };
}

/**
 * 格式化成本显示
 *
 * 将数字金额转为带 ¥ 前缀的字符串，固定 4 位小数。
 *
 * 使用示例：
 *   formatCost(0.123)   → "¥0.1230"
 *   formatCost(1.5)     → "¥1.5000"
 *
 * @param cost 成本金额（元）
 * @returns 格式化字符串
 */
export function formatCost(cost: number): string {
  return `¥${cost.toFixed(4)}`;
}

/**
 * 汇总多个成本记录
 *
 * 将多次 LLM 调用的费用累加，返回一个汇总的 CostResult。
 * 常用于工作流执行结束后统计总费用。
 *
 * 使用示例：
 *   const total = aggregateCosts([cost1, cost2, cost3]);
 *   console.log(`3 次调用总计: ${formatCost(total.total_cost)}`);
 *
 * @param costList 成本对象列表（每个元素是一次 calculateCost 的返回值）
 * @returns 汇总后的成本信息，count 字段记录调用次数
 */
export function aggregateCosts(costList: CostResult[]): CostResult {
  // 空列表 → 返回零成本
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

  // 第一步：遍历累加各项数值
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

  // 第二步：对累加后的费用再次向上取整
  // 为什么累加后还要取整？多个已取整的数相加，小数位可能超过 4 位
  // 例如：0.0001 + 0.0001 + ... 多次后可能出现浮点精度问题（如 0.00030000000000000004）
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
    // 只要有任意一条记录有定价信息，汇总结果就标记为 true
    pricing_available: costList.some((c) => c.pricing_available),
    count: costList.length,
  };
}

// ============================================================
// 已废弃的兼容函数
// ============================================================

/**
 * 动态添加模型价格配置
 *
 * @deprecated 已废弃。请在 models.yaml 中配置价格，由 model_caller.ts 统一加载。
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
 * @deprecated 已废弃。请直接使用 model_caller.ts 的 getModelPricingInfo()。
 */
export function getModelPricing(_model: string): PricingInfo | null {
  // TODO: 待 model_caller.ts 迁移后，替换为 getModelPricingInfo(model)
  return null;
}
