/**
 * cost_calculator.ts 单元测试
 *
 * 测试 src/cost_calculator.ts 中的纯计算函数：
 * - calculateCost()          — 计算单次 LLM 调用的费用
 * - formatCost()             — 格式化金额为可读字符串
 * - aggregateCosts()         — 汇总多次调用的费用
 * - estimateTokensFromText() — 从文本估算 token 数量
 *
 * 未覆盖的函数：
 * - addModelPricing() / getModelPricing()：已废弃的占位函数，逻辑为空
 * - ceilTo4()：内部未导出函数，通过 aggregateCosts 的测试间接覆盖
 */

// ---- 测试框架 API ----
// describe：将相关用例分组，便于组织和阅读测试报告
// it：定义单个测试用例（别名 test），描述"它应该做什么"
// expect：创建断言，配合 .toBe() / .toEqual() 等匹配器验证结果
// vi：Vitest 的工具对象，提供 mock/spy/timer 等测试辅助功能
// beforeEach / afterEach：在每个测试用例前/后执行的钩子函数
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- Mock 模块 ----
// vi.mock() 必须在 import 被测模块之前调用（Vitest 会自动提升到文件顶部）
// 这里 mock model_caller 模块，让 getModelPricingInfo 返回可控的测试数据
// 而不是去读真实的 models.yaml 配置文件
vi.mock("../src/model_caller", () => ({
  // 默认返回 null（无定价），具体测试用例中可通过 vi.mocked() 覆盖返回值
  getModelPricingInfo: vi.fn().mockReturnValue(null),
}));

// 导入被 mock 的函数，用于在测试中控制其返回值
// 必须在 vi.mock() 之后导入，这样拿到的是 mock 版本
import { getModelPricingInfo } from "../src/model_caller";

// ---- 被测函数 ----
// 从 src/cost_calculator.ts 导入 4 个需要测试的公共函数
import {
  calculateCost,
  formatCost,
  aggregateCosts,
  estimateTokensFromText,
} from "../src/cost_calculator";

// 导入类型定义，用于构造测试数据
// CostResult 是成本计算的返回值类型，包含费用、token 数、定价可用性等字段
import type { CostResult } from "../src/cost_calculator";

// ============================================================
// calculateCost() 测试
// ============================================================
// 源码逻辑（cost_calculator.ts:104-156）：
//   1. 调用 getModelPricingInfo(model) 获取定价
//   2. 无定价 → 返回零成本，pricing_available=false
//   3. 有定价 → 按公式 (tokens / 1_000_000) × 单价 计算，ceilTo4 向上取整
describe("calculateCost", () => {
  // 每个测试用例执行前，重置 mock 为默认行为（返回 null = 无定价）
  // 避免前一个测试设置的 mock 影响后续用例
  beforeEach(() => {
    vi.mocked(getModelPricingInfo).mockReturnValue(null);
  });

  // 每个测试用例执行后，清除所有 mock 的调用记录和返回值设置
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- 无定价分支（getModelPricingInfo 返回 null）----

  // 覆盖目标：pricing 为 null 时返回零成本
  // 当模型没有配置价格时，所有费用字段应为 0
  //
  // 输入：  model="test-model", promptTokens=100, completionTokens=50, totalTokens=150
  // 预期：  input_cost=0, output_cost=0, total_cost=0
  it("无定价时返回零成本", () => {
    const result = calculateCost("test-model", 100, 50, 150);
    expect(result.input_cost).toBe(0);
    expect(result.output_cost).toBe(0);
    expect(result.total_cost).toBe(0);
  });

  // 覆盖目标：pricing_available 标记
  // 没有定价信息时应返回 false，调用方可据此判断费用数据是否可信
  it("无定价时 pricing_available 为 false", () => {
    const result = calculateCost("unknown-model", 200, 100, 300);
    expect(result.pricing_available).toBe(false);
  });

  // 覆盖目标：token 用量正确记录
  // 即使没有价格信息，token 数量仍应如实记录（用于统计和后续补算）
  //
  // 输入：  promptTokens=500, completionTokens=200, totalTokens=700
  // 预期：  input_tokens=500, output_tokens=200, total_tokens=700
  it("无定价时仍正确记录 token 用量", () => {
    const result = calculateCost("some-model", 500, 200, 700);
    expect(result.input_tokens).toBe(500);
    expect(result.output_tokens).toBe(200);
    expect(result.total_tokens).toBe(700);
  });

  // 覆盖目标：零 token 输入
  // 对应源项目 test_calculate_cost_zero_tokens：当所有 token 数为 0 时，费用也应为 0
  it("零 token 返回零成本", () => {
    const result = calculateCost("test-model", 0, 0, 0);
    expect(result.total_cost).toBe(0);
    expect(result.input_tokens).toBe(0);
    expect(result.output_tokens).toBe(0);
    expect(result.total_tokens).toBe(0);
  });

  // 覆盖目标：货币类型固定为 "CNY"
  // 无论什么模型，currency 字段始终为 "CNY"
  it("货币类型为 CNY", () => {
    const result = calculateCost("any-model", 0, 0, 0);
    expect(result.currency).toBe("CNY");
  });

  // ---- 有定价分支（getModelPricingInfo 返回定价信息）----

  // 覆盖目标：正常计算逻辑
  // 对应源项目 test_calculate_cost_normal
  // Mock getModelPricingInfo 返回定价：输入 1 元/百万 tokens，输出 2 元/百万 tokens
  //
  // 输入：  1,000,000 tokens（输入和输出各 1M）
  // 计算：  输入 (1_000_000 / 1_000_000) × 1 = 1.0
  //         输出 (1_000_000 / 1_000_000) × 2 = 2.0
  //         总计 = 3.0
  it("有定价时正确计算费用", () => {
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

  // 覆盖目标：向上取整（ceilTo4）行为
  // 对应源项目 test_calculate_cost_decimal_precision
  //
  // 输入：  12345 prompt tokens，单价 0.0001 元/百万
  // 计算：  (12345 / 1_000_000) × 0.0001 = 0.0000012345
  //         → ceilTo4 → Math.ceil(0.012345) / 10000 = 0.0001
  it("有定价时费用向上取整到 4 位小数", () => {
    vi.mocked(getModelPricingInfo).mockReturnValue({
      input: 0.0001,
      output: 0.0002,
      currency: "CNY",
    });

    const result = calculateCost("priced-model", 12345, 67890, 80235);
    // 验证结果已向上取整到 4 位小数
    expect(result.input_cost).toBe(0.0001);
    expect(result.output_cost).toBe(0.0001);
    expect(result.total_cost).toBe(0.0002);
    expect(result.pricing_available).toBe(true);
  });

  // 覆盖目标：大数值计算
  // 对应源项目 test_calculate_cost_large_numbers
  //
  // 输入：  10M prompt tokens × 10元/百万 + 5M completion tokens × 20元/百万
  // 计算：  (10_000_000 / 1_000_000) × 10 = 100
  //         (5_000_000 / 1_000_000) × 20 = 100
  //         总计 = 200
  it("大数值计算正确", () => {
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

  // 覆盖目标：有定价但 0 token 时费用为 0
  it("有定价但零 token 时费用为 0", () => {
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
// formatCost() 测试
// ============================================================
// 源码逻辑（cost_calculator.ts:170-172）：
//   return `¥${cost.toFixed(4)}`
// 将数字金额转为带 ¥ 前缀的字符串，固定 4 位小数
describe("formatCost", () => {
  // 覆盖目标：整数输入补零到 4 位小数
  //
  // 输入：  1
  // 预期：  "¥1.0000"（toFixed(4) 会补零）
  it("整数格式化为 4 位小数", () => {
    expect(formatCost(1)).toBe("¥1.0000");
  });

  // 覆盖目标：小数输入保留 4 位
  //
  // 输入：  0.123
  // 预期：  "¥0.1230"（第 4 位小数补零）
  it("小数格式化为 4 位小数", () => {
    expect(formatCost(0.123)).toBe("¥0.1230");
  });

  // 覆盖目标：零值
  //
  // 输入：  0
  // 预期：  "¥0.0000"
  it("零值格式化", () => {
    expect(formatCost(0)).toBe("¥0.0000");
  });

  // 覆盖目标：多位小数被截断到 4 位（toFixed 的四舍五入行为）
  //
  // 输入：  0.12345
  // 预期：  "¥0.1235"（第 5 位 5 四舍五入进位）
  it("超过 4 位小数时四舍五入", () => {
    expect(formatCost(0.12345)).toBe("¥0.1235");
  });
});

// ============================================================
// aggregateCosts() 测试
// ============================================================
// 源码逻辑（cost_calculator.ts:187-244）：
//   1. 空列表 → 返回全零结果，count=0
//   2. 遍历累加各项 token 和费用
//   3. 累加后的费用再次 ceilTo4 取整
//   4. pricing_available = any(c.pricing_available)
//   5. count = costList.length
describe("aggregateCosts", () => {
  // 覆盖目标：空列表边界条件
  // costList 为空数组时，应返回全零结果，count 为 0
  //
  // 输入：  []
  // 预期：  所有费用和 token 数为 0，count=0，pricing_available=false
  it("空列表返回零成本", () => {
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

  // 覆盖目标：单条记录透传
  // 只有一条记录时，汇总结果应与该记录的数值一致
  //
  // 输入：  一条 input_cost=0.001, output_cost=0.002, total_cost=0.003 的记录
  // 预期：  汇总结果的费用和 token 与原记录一致，count=1
  it("单条记录正确透传", () => {
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
    // total_cost = ceilTo4(input_cost) + ceilTo4(output_cost) = 0.001 + 0.002 = 0.003
    expect(result.total_cost).toBe(0.003);
    expect(result.input_tokens).toBe(100);
    expect(result.output_tokens).toBe(50);
    expect(result.total_tokens).toBe(150);
    expect(result.count).toBe(1);
    expect(result.pricing_available).toBe(true);
  });

  // 覆盖目标：多条记录累加
  // 验证多次调用的费用和 token 数正确相加
  //
  // 输入：  两条记录，各有不同的 token 数和费用
  // 预期：  token 直接相加，费用经 ceilTo4 取整后相加
  it("多条记录正确累加", () => {
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

    // token 数直接相加
    expect(result.input_tokens).toBe(400);   // 100 + 300
    expect(result.output_tokens).toBe(250);  // 50 + 200
    expect(result.total_tokens).toBe(650);   // 150 + 500

    // 费用累加后经 ceilTo4：0.001+0.003=0.004, 0.002+0.004=0.006
    expect(result.input_cost).toBe(0.004);
    expect(result.output_cost).toBe(0.006);
    expect(result.total_cost).toBe(0.01);    // 0.004 + 0.006

    expect(result.count).toBe(2);
  });

  // 覆盖目标：pricing_available 的 some() 逻辑
  // 源码：costList.some(c => c.pricing_available)
  // 只要有任何一条记录的 pricing_available 为 true，结果就应为 true
  it("任一记录有定价则 pricing_available 为 true", () => {
    const withPricing: CostResult = {
      input_cost: 0.001,
      output_cost: 0.001,
      total_cost: 0.002,
      currency: "CNY",
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      pricing_available: true,   // 有定价
    };
    const withoutPricing: CostResult = {
      input_cost: 0,
      output_cost: 0,
      total_cost: 0,
      currency: "CNY",
      input_tokens: 200,
      output_tokens: 100,
      total_tokens: 300,
      pricing_available: false,  // 无定价
    };
    const result = aggregateCosts([withPricing, withoutPricing]);
    // some() 只要有一个 true 就返回 true
    expect(result.pricing_available).toBe(true);
  });

  // 覆盖目标：极小费用值的精度（间接覆盖 ceilTo4）
  // 对应源项目 test_aggregate_costs_decimal_precision：验证汇总时的小数精度
  // 累加多个极小值后，ceilTo4 应将结果向上取整到 4 位小数
  //
  // 输入：  两条 input_cost=0.00001 的记录
  // 计算：  0.00001 + 0.00001 = 0.00002 → ceilTo4 → 0.0001（向上取整）
  it("极小费用值累加后向上取整", () => {
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

    // 0.00001 + 0.00002 = 0.00003 → ceilTo4 → 0.0001
    expect(result.input_cost).toBe(0.0001);
    expect(result.output_cost).toBe(0.0001);
    // total_cost = 0.0001 + 0.0001 = 0.0002
    expect(result.total_cost).toBe(0.0002);
    expect(result.count).toBe(2);
  });

  // 覆盖目标：所有记录都无定价时 pricing_available 为 false
  it("所有记录无定价则 pricing_available 为 false", () => {
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
// estimateTokensFromText() 测试
// ============================================================
// 源码逻辑（cost_calculator.ts:268-298）：
//   1. 空文本 → 返回 0
//   2. 正则匹配中文字符 [\u4e00-\u9fff]，计算 chineseCount × 0.3
//   3. 正则匹配英文字母 [a-zA-Z]，计算 (englishCount / 3) × 0.3
//   4. Math.floor(chineseTokens + englishTokens) 向下取整
describe("estimateTokensFromText", () => {
  // 覆盖目标：空文本的 early return
  // 空字符串（包括 falsy 值）直接返回 0，不执行正则匹配
  //
  // 输入：  ""
  // 预期：  0
  it("空文本返回 0", () => {
    expect(estimateTokensFromText("")).toBe(0);
  });

  // 覆盖目标：纯中文的估算
  // 中文字符走 chineseCount × 0.3 的计算路径
  //
  // 输入：  "你好世界"（4 个中文字符）
  // 计算：  4 × 0.3 = 1.2 → Math.floor → 1
  it("纯中文估算", () => {
    expect(estimateTokensFromText("你好世界")).toBe(1);
  });

  // 覆盖目标：较长的中文文本
  // 验证中文数量较多时计算仍正确
  //
  // 输入：  "这是一个用来测试的中文句子"（13 个中文字符）
  // 计算：  13 × 0.3 = 3.9 → Math.floor → 3
  it("较长中文文本估算", () => {
    expect(estimateTokensFromText("这是一个用来测试的中文句子")).toBe(3);
  });

  // 覆盖目标：纯英文的估算（无空格）
  // 英文字母走 (englishCount / 3) × 0.3 的计算路径
  //
  // 输入：  "HelloWorld"（10 个英文字母，无空格）
  // 计算：  (10 / 3) × 0.3 = 1.0 → Math.floor → 1
  it("纯英文估算（无空格）", () => {
    expect(estimateTokensFromText("HelloWorld")).toBe(1);
  });

  // 覆盖目标：纯英文的估算（含空格）
  // 对应源项目 test_estimate_english_text("Hello World")
  // 空格不是字母 [a-zA-Z]，不计入英文字母数
  //
  // 输入：  "Hello World"（10 个英文字母 + 1 个空格，空格被忽略）
  // 计算：  (10 / 3) × 0.3 = 1.0 → Math.floor → 1
  it("纯英文估算（含空格，空格不计入）", () => {
    expect(estimateTokensFromText("Hello World")).toBe(1);
  });

  // 覆盖目标：中英混合文本（短）
  // 中文和英文分别匹配、分别计算后相加
  //
  // 输入：  "你好Hello"（2 个中文 + 5 个英文字母）
  // 计算：  中文 2×0.3=0.6 + 英文 (5/3)×0.3=0.5 = 1.1 → Math.floor → 1
  it("中英混合文本估算（短）", () => {
    expect(estimateTokensFromText("你好Hello")).toBe(1);
  });

  // 覆盖目标：中英混合文本（长）
  // 对应源项目 test_estimate_mixed_text("你好Hello世界World")
  //
  // 输入：  "你好Hello世界World"（4 个中文 + 10 个英文字母）
  // 计算：  中文 4×0.3=1.2 + 英文 (10/3)×0.3=1.0 = 2.2 → Math.floor → 2
  it("中英混合文本估算（长）", () => {
    expect(estimateTokensFromText("你好Hello世界World")).toBe(2);
  });

  // 覆盖目标：数字和标点不计入
  // 正则只匹配 [\u4e00-\u9fff] 和 [a-zA-Z]，数字和标点被忽略
  //
  // 输入：  "12345!@#$%"（全是数字和标点，无中文无英文）
  // 计算：  中文 0×0.3=0 + 英文 0/3×0.3=0 = 0 → Math.floor → 0
  it("数字和标点不计入", () => {
    expect(estimateTokensFromText("12345!@#$%")).toBe(0);
  });

  // 覆盖目标：含数字标点的混合文本，只计算中英字符
  //
  // 输入：  "测试123abc！"（2 个中文 + 3 个英文 + 数字标点忽略）
  // 计算：  中文 2×0.3=0.6 + 英文 (3/3)×0.3=0.3 = 0.9 → Math.floor → 0
  it("混合文本中数字标点被忽略", () => {
    expect(estimateTokensFromText("测试123abc！")).toBe(0);
  });
});
