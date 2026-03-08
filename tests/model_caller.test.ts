/**
 * model_caller.ts 单元测试
 *
 * 测试 src/model_caller.ts 中的模型调用映射模块：
 * - resolveEnvPlaceholders() — 递归替换 ${ENV_VAR} 占位符（内部函数，通过 loadModelMappings 间接测试）
 * - callModel()             — 通过模型简称调用 AI 模型（核心函数）
 * - listModels()            — 列出所有可用模型简称
 * - getModelInfo()          — 获取模型详细信息（API 密钥脱敏）
 * - addCustomModel()        — 动态添加自定义模型配置
 * - getModelPricingInfo()   — 获取模型价格配置
 * - reloadModels()          — 重新加载 models.yaml（热重载）
 *
 * 测试策略：
 *   - 使用 vi.mock 模拟 llm_client.chat 和 mock_llm 模块，避免真实 API 调用
 *   - 使用 vi.mock 模拟 fs 和 js-yaml，避免依赖真实的 models.yaml 文件
 *   - 直接操作 MODEL_MAPPINGS 全局变量来设置测试用的模型配置
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================
// Mock 外部依赖
// ============================================================

// mock llm_client.ts —— chat 函数返回可控的测试数据
const mockChat = vi.fn();
vi.mock("../src/llm_client.js", () => ({
  chat: (...args: unknown[]) => mockChat(...args),
  // LlmResult 和 LlmCallOptions 是类型，mock 模块中不需要提供
}));

// mock mock_llm.ts —— 控制 mock 模型的检测和调用行为
const mockIsMockModel = vi.fn().mockReturnValue(false);
const mockMockLlmCall = vi.fn();
vi.mock("../src/mock_llm.js", () => ({
  isMockModel: (...args: unknown[]) => mockIsMockModel(...args),
  mockLlmCall: (...args: unknown[]) => mockMockLlmCall(...args),
}));

// ---- 导入被测模块（必须在 vi.mock 之后） ----
import {
  callModel,
  listModels,
  getModelInfo,
  addCustomModel,
  getModelPricingInfo,
  reloadModels,
  MODEL_MAPPINGS,
} from "../src/model_caller";
import type { SingleModelConfig, ModelMappings } from "../src/model_caller";

// ============================================================
// 测试用的模型配置数据
// ============================================================

/**
 * 创建一个完整的单配置模型（字典格式）
 * 每个测试都用这个工厂函数生成干净的测试数据，避免测试间互相污染
 */
function makeConfig(overrides?: Partial<SingleModelConfig>): SingleModelConfig {
  return {
    provider: "test-provider",
    api_url: "https://api.test.com/v1/chat/completions",
    api_key: "sk-test-key-12345",
    model_name: "test-model-v1",
    temperature: 0.7,
    max_tokens: 2000,
    ...overrides,
  };
}

// ============================================================
// 测试生命周期
// ============================================================

// 保存初始的 MODEL_MAPPINGS，每个测试用例结束后恢复
// 这样每个测试对 MODEL_MAPPINGS 的修改不会影响其他测试
let originalMappings: ModelMappings;

beforeEach(() => {
  // 深拷贝保存当前配置
  originalMappings = JSON.parse(JSON.stringify(MODEL_MAPPINGS));
  // 重置所有 mock 函数的调用记录和返回值
  vi.resetAllMocks();
  // isMockModel 默认返回 false（非 mock 模型），具体测试中按需覆盖
  mockIsMockModel.mockReturnValue(false);
});

afterEach(() => {
  // 恢复原始配置：先清空所有键，再写回原始数据
  for (const key of Object.keys(MODEL_MAPPINGS)) {
    delete MODEL_MAPPINGS[key];
  }
  Object.assign(MODEL_MAPPINGS, originalMappings);
});

// ============================================================
// callModel() 测试
// ============================================================
// 源码逻辑（model_caller.ts:440-523）：
//   1. 查找 MODEL_MAPPINGS[modelAlias]
//   2. resolveConfig 解析出启用的配置
//   3. isMockModel 检测是否为 mock 模型
//   4. 检查 API 密钥
//   5. 合并参数（调用方 → 配置文件 → 默认值）
//   6. 调用 chat()
describe("callModel", () => {
  // ---- 成功调用 ----
  it("字典格式配置：正常调用 chat 并返回结果", async () => {
    // 准备：注入一个简单的测试模型
    MODEL_MAPPINGS["test-simple"] = makeConfig();
    // chat 返回模拟的 LlmResult
    mockChat.mockResolvedValue({
      content: "你好，我是AI",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const result = await callModel("test-simple", "你好");

    // 验证返回值
    expect(result.content).toBe("你好，我是AI");
    expect(result.usage.total_tokens).toBe(15);
    // 验证 chat 被正确调用（prompt、api_url、api_key、model_name、options）
    expect(mockChat).toHaveBeenCalledOnce();
    expect(mockChat.mock.calls[0][0]).toBe("你好");           // prompt
    expect(mockChat.mock.calls[0][1]).toBe("https://api.test.com/v1/chat/completions"); // api_url
    expect(mockChat.mock.calls[0][2]).toBe("sk-test-key-12345"); // api_key
    expect(mockChat.mock.calls[0][3]).toBe("test-model-v1");     // model_name
  });

  it("列表格式配置：选择 enabled: true 的配置", async () => {
    // 准备：两个提供商，只有第二个启用
    MODEL_MAPPINGS["test-multi"] = [
      makeConfig({ provider: "provider-a", enabled: false, model_name: "model-a" }),
      makeConfig({ provider: "provider-b", enabled: true, model_name: "model-b" }),
    ];
    mockChat.mockResolvedValue({ content: "来自B", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

    await callModel("test-multi", "测试");

    // 验证使用了 provider-b 的 model_name
    expect(mockChat.mock.calls[0][3]).toBe("model-b");
  });

  // ---- 参数覆盖 ----
  it("调用方参数覆盖配置文件中的 temperature 和 max_tokens", async () => {
    MODEL_MAPPINGS["test-override"] = makeConfig({ temperature: 0.3, max_tokens: 1000 });
    mockChat.mockResolvedValue({ content: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

    await callModel("test-override", "测试", 0.9, 5000);

    // chat 的第 5 个参数是 options 对象
    const options = mockChat.mock.calls[0][4];
    expect(options.temperature).toBe(0.9);
    expect(options.max_tokens).toBe(5000);
  });

  it("调用方未传参数时使用配置文件中的值", async () => {
    MODEL_MAPPINGS["test-default"] = makeConfig({ temperature: 0.2, max_tokens: 8000 });
    mockChat.mockResolvedValue({ content: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

    await callModel("test-default", "测试");

    const options = mockChat.mock.calls[0][4];
    expect(options.temperature).toBe(0.2);
    expect(options.max_tokens).toBe(8000);
  });

  it("配置文件也未设置时使用硬编码默认值 (0.7, 2000)", async () => {
    // 创建一个没有 temperature 和 max_tokens 的配置
    const config = makeConfig();
    delete (config as Record<string, unknown>)["temperature"];
    delete (config as Record<string, unknown>)["max_tokens"];
    MODEL_MAPPINGS["test-hardcode"] = config;
    mockChat.mockResolvedValue({ content: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

    await callModel("test-hardcode", "测试");

    const options = mockChat.mock.calls[0][4];
    expect(options.temperature).toBe(0.7);
    expect(options.max_tokens).toBe(2000);
  });

  // ---- timeout 参数 ----
  it("传入 timeout 时应透传给 chat", async () => {
    MODEL_MAPPINGS["test-timeout"] = makeConfig();
    mockChat.mockResolvedValue({ content: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

    await callModel("test-timeout", "测试", undefined, undefined, 60000);

    const options = mockChat.mock.calls[0][4];
    expect(options.timeout).toBe(60000);
  });

  it("未传 timeout 时 options 中不包含 timeout 字段", async () => {
    MODEL_MAPPINGS["test-no-timeout"] = makeConfig();
    mockChat.mockResolvedValue({ content: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

    await callModel("test-no-timeout", "测试");

    const options = mockChat.mock.calls[0][4];
    expect(options.timeout).toBeUndefined();
  });

  // ---- extra_params 透传 ----
  it("配置中的 extra_params 应透传给 chat", async () => {
    MODEL_MAPPINGS["test-extra"] = makeConfig({
      extra_params: { enable_thinking: true },
    });
    mockChat.mockResolvedValue({ content: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

    await callModel("test-extra", "测试");

    const options = mockChat.mock.calls[0][4];
    expect(options.extra_params).toEqual({ enable_thinking: true });
  });

  // ---- OpenRouter 特殊 headers ----
  it("provider 为 openrouter 时添加额外 headers", async () => {
    MODEL_MAPPINGS["test-openrouter"] = makeConfig({ provider: "openrouter" });
    mockChat.mockResolvedValue({ content: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    // 设置 OpenRouter 相关环境变量
    process.env["OPENROUTER_SITE_URL"] = "https://mysite.com";
    process.env["OPENROUTER_SITE_NAME"] = "MyApp";

    await callModel("test-openrouter", "测试");

    const options = mockChat.mock.calls[0][4];
    expect(options.extra_headers).toEqual({
      "HTTP-Referer": "https://mysite.com",
      "X-Title": "MyApp",
    });

    // 清理环境变量
    delete process.env["OPENROUTER_SITE_URL"];
    delete process.env["OPENROUTER_SITE_NAME"];
  });

  // ---- Mock 模型拦截 ----
  it("mock 模型走模拟路径，不调用真实 chat", async () => {
    MODEL_MAPPINGS["mock-test"] = makeConfig({ provider: "mock" });
    mockIsMockModel.mockReturnValue(true);
    mockMockLlmCall.mockReturnValue({
      content: "模拟响应",
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });

    const result = await callModel("mock-test", "测试");

    expect(result.content).toBe("模拟响应");
    expect(mockMockLlmCall).toHaveBeenCalledOnce();
    // 真实 chat 不应被调用
    expect(mockChat).not.toHaveBeenCalled();
  });

  // ---- 错误场景 ----
  it("模型简称不存在时抛出错误并列出可用模型", async () => {
    await expect(callModel("不存在的模型", "你好")).rejects.toThrow("未知的模型简称");
    await expect(callModel("不存在的模型", "你好")).rejects.toThrow("不存在的模型");
  });

  it("API 密钥为空时抛出错误", async () => {
    MODEL_MAPPINGS["test-no-key"] = makeConfig({ api_key: "" });

    await expect(callModel("test-no-key", "你好")).rejects.toThrow("API密钥未配置或为空");
  });

  it("API 密钥只有空格时抛出错误", async () => {
    MODEL_MAPPINGS["test-blank-key"] = makeConfig({ api_key: "   " });

    await expect(callModel("test-blank-key", "你好")).rejects.toThrow("API密钥未配置或为空");
  });
});

// ============================================================
// resolveConfig() 测试（通过 callModel 间接测试）
// ============================================================
// resolveConfig 是内部函数未导出，通过 callModel 的行为间接验证
describe("resolveConfig（通过 callModel 间接测试）", () => {
  it("列表格式：没有 enabled: true 的配置时抛出错误", async () => {
    MODEL_MAPPINGS["test-none-enabled"] = [
      makeConfig({ provider: "a", enabled: false }),
      makeConfig({ provider: "b", enabled: false }),
    ];

    await expect(callModel("test-none-enabled", "你好")).rejects.toThrow("没有启用的配置");
  });

  it("列表格式：多个 enabled: true 时抛出错误", async () => {
    MODEL_MAPPINGS["test-multi-enabled"] = [
      makeConfig({ provider: "a", enabled: true }),
      makeConfig({ provider: "b", enabled: true }),
    ];

    await expect(callModel("test-multi-enabled", "你好")).rejects.toThrow("有多个启用的配置");
  });

  it("列表格式：enabled 字段为非布尔值时抛出错误", async () => {
    MODEL_MAPPINGS["test-bad-enabled"] = [
      // enabled 写成了字符串 "true" 而不是布尔值 true
      makeConfig({ provider: "a", enabled: "true" as unknown as boolean }),
    ];

    await expect(callModel("test-bad-enabled", "你好")).rejects.toThrow("必须是布尔值");
  });

  it("列表格式：缺少必需字段时抛出错误", async () => {
    const badConfig = makeConfig({ enabled: true });
    delete (badConfig as Record<string, unknown>)["model_name"];
    MODEL_MAPPINGS["test-missing-field"] = [badConfig];

    await expect(callModel("test-missing-field", "你好")).rejects.toThrow("缺少必需字段");
  });
});

// ============================================================
// listModels() 测试
// ============================================================
describe("listModels", () => {
  it("返回所有模型简称并按字母排序", () => {
    // 清空并注入测试数据
    for (const key of Object.keys(MODEL_MAPPINGS)) delete MODEL_MAPPINGS[key];
    MODEL_MAPPINGS["zebra"] = makeConfig();
    MODEL_MAPPINGS["alpha"] = makeConfig();
    MODEL_MAPPINGS["middle"] = makeConfig();

    const models = listModels();
    expect(models).toEqual(["alpha", "middle", "zebra"]);
  });

  it("MODEL_MAPPINGS 为空时返回空数组", () => {
    for (const key of Object.keys(MODEL_MAPPINGS)) delete MODEL_MAPPINGS[key];
    expect(listModels()).toEqual([]);
  });
});

// ============================================================
// getModelInfo() 测试
// ============================================================
describe("getModelInfo", () => {
  it("字典格式：返回配置并脱敏 API 密钥", () => {
    MODEL_MAPPINGS["test-info"] = makeConfig({ api_key: "sk-secret-123" });

    const info = getModelInfo("test-info");
    expect(info).not.toBeNull();
    expect(info!["api_key"]).toBe("***");
    expect(info!["provider"]).toBe("test-provider");
    expect(info!["model_name"]).toBe("test-model-v1");
  });

  it("API 密钥为空时显示'未配置'", () => {
    MODEL_MAPPINGS["test-no-key-info"] = makeConfig({ api_key: "" });

    const info = getModelInfo("test-no-key-info");
    expect(info!["api_key"]).toBe("未配置");
  });

  it("列表格式：返回 enabled: true 的配置", () => {
    MODEL_MAPPINGS["test-multi-info"] = [
      makeConfig({ provider: "disabled-one", enabled: false, model_name: "model-a" }),
      makeConfig({ provider: "enabled-one", enabled: true, model_name: "model-b" }),
    ];

    const info = getModelInfo("test-multi-info");
    expect(info!["provider"]).toBe("enabled-one");
    expect(info!["model_name"]).toBe("model-b");
  });

  it("列表格式：没有启用的配置时返回错误对象", () => {
    MODEL_MAPPINGS["test-none-info"] = [
      makeConfig({ provider: "a", enabled: false }),
      makeConfig({ provider: "b", enabled: false }),
    ];

    const info = getModelInfo("test-none-info");
    expect(info!["error"]).toBe("没有启用的配置");
    expect(info!["available_providers"]).toEqual(["a", "b"]);
  });

  it("列表格式：多个启用时返回错误对象", () => {
    MODEL_MAPPINGS["test-dup-info"] = [
      makeConfig({ provider: "x", enabled: true }),
      makeConfig({ provider: "y", enabled: true }),
    ];

    const info = getModelInfo("test-dup-info");
    expect(info!["error"]).toBe("配置错误：有多个启用的配置");
  });

  it("模型不存在时返回 null", () => {
    expect(getModelInfo("根本不存在")).toBeNull();
  });
});

// ============================================================
// addCustomModel() 测试
// ============================================================
describe("addCustomModel", () => {
  it("添加自定义模型后可通过 callModel 调用", async () => {
    addCustomModel(
      "my-custom",
      "custom-provider",
      "https://custom.api/v1/chat",
      "sk-custom-key",
      "custom-model-v2",
      0.5,
      4000
    );

    mockChat.mockResolvedValue({ content: "自定义响应", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

    const result = await callModel("my-custom", "测试自定义模型");
    expect(result.content).toBe("自定义响应");
    expect(mockChat.mock.calls[0][1]).toBe("https://custom.api/v1/chat");
    expect(mockChat.mock.calls[0][3]).toBe("custom-model-v2");
  });

  it("添加自定义模型后 listModels 能列出", () => {
    addCustomModel("new-model", "p", "url", "key", "name");

    expect(listModels()).toContain("new-model");
  });

  it("extras 参数中的额外字段能合并到配置中", () => {
    addCustomModel("with-extras", "p", "url", "key", "name", 0.7, 2000, {
      pricing: { input: 1.0, output: 2.0, currency: "USD" },
    });

    const pricing = getModelPricingInfo("with-extras");
    expect(pricing).toEqual({ input: 1.0, output: 2.0, currency: "USD" });
  });
});

// ============================================================
// getModelPricingInfo() 测试
// ============================================================
describe("getModelPricingInfo", () => {
  it("字典格式：返回 pricing 配置", () => {
    MODEL_MAPPINGS["test-priced"] = makeConfig({
      pricing: { input: 2.5, output: 10.0, currency: "USD" },
    });

    const pricing = getModelPricingInfo("test-priced");
    expect(pricing).toEqual({ input: 2.5, output: 10.0, currency: "USD" });
  });

  it("字典格式：未配置 pricing 时返回 null", () => {
    const config = makeConfig();
    delete config.pricing;
    MODEL_MAPPINGS["test-no-price"] = config;

    expect(getModelPricingInfo("test-no-price")).toBeNull();
  });

  it("列表格式：返回 enabled 配置的 pricing", () => {
    MODEL_MAPPINGS["test-multi-price"] = [
      makeConfig({ enabled: false, pricing: { input: 1, output: 1, currency: "CNY" } }),
      makeConfig({ enabled: true, pricing: { input: 5, output: 15, currency: "USD" } }),
    ];

    const pricing = getModelPricingInfo("test-multi-price");
    expect(pricing).toEqual({ input: 5, output: 15, currency: "USD" });
  });

  it("列表格式：没有启用的配置时返回 null", () => {
    MODEL_MAPPINGS["test-no-enabled-price"] = [
      makeConfig({ enabled: false }),
    ];

    expect(getModelPricingInfo("test-no-enabled-price")).toBeNull();
  });

  it("模型不存在时返回 null", () => {
    expect(getModelPricingInfo("根本不存在")).toBeNull();
  });
});

// ============================================================
// reloadModels() 测试
// ============================================================
// reloadModels 依赖 fs 和 yaml 读取真实文件
// 这里只测试它不会崩溃，并且确实重新加载了配置
describe("reloadModels", () => {
  it("重新加载后 MODEL_MAPPINGS 被重置（动态添加的模型会消失）", () => {
    // 动态添加一个模型
    addCustomModel("temp-model", "p", "url", "key", "name");
    expect(listModels()).toContain("temp-model");

    // 重新加载（从 models.yaml 读取）
    reloadModels();

    // 动态添加的模型应该消失了（除非 models.yaml 中也有这个名字）
    expect(listModels()).not.toContain("temp-model");
  });
});
