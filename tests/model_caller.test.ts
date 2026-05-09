/**
 * Unit tests for src/model_caller.ts.
 *
 * The module under test maps short model aliases to provider configs and then
 * calls the lower-level LLM client. These tests keep real API calls out of the
 * loop by mocking llm_client.ts and mock_llm.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================
// Mock external dependencies
// ============================================================

// Mock llm_client.ts. chat() returns controlled test data instead of calling a
// real provider API.
const mockChat = vi.fn();
vi.mock("../src/llm_client.js", () => ({
  chat: (...args: unknown[]) => mockChat(...args),
}));

// Mock mock_llm.ts so each test can decide whether a model should use the mock
// path and what that mock call returns.
const mockIsMockModel = vi.fn().mockReturnValue(false);
const mockMockLlmCall = vi.fn();
vi.mock("../src/mock_llm.js", () => ({
  isMockModel: (...args: unknown[]) => mockIsMockModel(...args),
  mockLlmCall: (...args: unknown[]) => mockMockLlmCall(...args),
}));

// Import the module under test after vi.mock() so the imports above are mocked.
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
// Test data
// ============================================================

/**
 * Create a complete object-shape model config.
 *
 * Every test uses fresh config objects from this factory, which prevents state
 * from leaking between test cases.
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
// Test lifecycle
// ============================================================

// MODEL_MAPPINGS is mutable by design. Each test gets a clean snapshot and then
// restores it in afterEach().
let originalMappings: ModelMappings;

beforeEach(() => {
  originalMappings = JSON.parse(JSON.stringify(MODEL_MAPPINGS));
  vi.resetAllMocks();
  mockIsMockModel.mockReturnValue(false);
});

afterEach(() => {
  for (const key of Object.keys(MODEL_MAPPINGS)) {
    delete MODEL_MAPPINGS[key];
  }
  Object.assign(MODEL_MAPPINGS, originalMappings);
});

// ============================================================
// callModel()
// ============================================================

describe("callModel", () => {
  it("calls chat and returns the result for an object-shape config", async () => {
    MODEL_MAPPINGS["test-simple"] = makeConfig();
    mockChat.mockResolvedValue({
      content: "hello from ai",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const result = await callModel("test-simple", "hello");

    expect(result.content).toBe("hello from ai");
    expect(result.usage.total_tokens).toBe(15);
    expect(mockChat).toHaveBeenCalledOnce();
    expect(mockChat.mock.calls[0][0]).toBe("hello");
    expect(mockChat.mock.calls[0][1]).toBe("https://api.test.com/v1/chat/completions");
    expect(mockChat.mock.calls[0][2]).toBe("sk-test-key-12345");
    expect(mockChat.mock.calls[0][3]).toBe("test-model-v1");
  });

  it("selects the enabled config from an array-shape config", async () => {
    MODEL_MAPPINGS["test-multi"] = [
      makeConfig({ provider: "provider-a", enabled: false, model_name: "model-a" }),
      makeConfig({ provider: "provider-b", enabled: true, model_name: "model-b" }),
    ];
    mockChat.mockResolvedValue({ content: "from b", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

    await callModel("test-multi", "test prompt");

    expect(mockChat.mock.calls[0][3]).toBe("model-b");
  });

  it("lets call-time temperature and maxTokens override config values", async () => {
    MODEL_MAPPINGS["test-override"] = makeConfig({ temperature: 0.3, max_tokens: 1000 });
    mockChat.mockResolvedValue({ content: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

    await callModel("test-override", "test prompt", 0.9, 5000);

    const options = mockChat.mock.calls[0][4];
    expect(options.temperature).toBe(0.9);
    expect(options.max_tokens).toBe(5000);
  });

  it("uses config temperature and max_tokens when call-time values are omitted", async () => {
    MODEL_MAPPINGS["test-default"] = makeConfig({ temperature: 0.2, max_tokens: 8000 });
    mockChat.mockResolvedValue({ content: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

    await callModel("test-default", "test prompt");

    const options = mockChat.mock.calls[0][4];
    expect(options.temperature).toBe(0.2);
    expect(options.max_tokens).toBe(8000);
  });

  it("uses hard-coded defaults when no temperature or max_tokens are configured", async () => {
    const config = makeConfig();
    delete (config as Record<string, unknown>)["temperature"];
    delete (config as Record<string, unknown>)["max_tokens"];
    MODEL_MAPPINGS["test-hardcode"] = config;
    mockChat.mockResolvedValue({ content: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

    await callModel("test-hardcode", "test prompt");

    const options = mockChat.mock.calls[0][4];
    expect(options.temperature).toBe(0.7);
    expect(options.max_tokens).toBe(2000);
  });

  it("passes timeout through to chat when provided", async () => {
    MODEL_MAPPINGS["test-timeout"] = makeConfig();
    mockChat.mockResolvedValue({ content: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

    await callModel("test-timeout", "test prompt", undefined, undefined, 60000);

    const options = mockChat.mock.calls[0][4];
    expect(options.timeout).toBe(60000);
  });

  it("passes retry options through to chat when provided", async () => {
    MODEL_MAPPINGS["test-retry-options"] = makeConfig();
    mockChat.mockResolvedValue({ content: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

    await callModel("test-retry-options", "test prompt", undefined, undefined, undefined, {
      max_retries: 4,
      retry_delay: 2,
      retry_backoff: "exponential",
    });

    const options = mockChat.mock.calls[0][4];
    expect(options.max_retries).toBe(4);
    expect(options.retry_delay).toBe(2);
    expect(options.retry_backoff).toBe("exponential");
  });

  it("omits timeout from options when no timeout is provided", async () => {
    MODEL_MAPPINGS["test-no-timeout"] = makeConfig();
    mockChat.mockResolvedValue({ content: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

    await callModel("test-no-timeout", "test prompt");

    const options = mockChat.mock.calls[0][4];
    expect(options.timeout).toBeUndefined();
  });

  it("passes extra_params through to chat", async () => {
    MODEL_MAPPINGS["test-extra"] = makeConfig({
      extra_params: { enable_thinking: true },
    });
    mockChat.mockResolvedValue({ content: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

    await callModel("test-extra", "test prompt");

    const options = mockChat.mock.calls[0][4];
    expect(options.extra_params).toEqual({ enable_thinking: true });
  });

  it("adds OpenRouter attribution headers when environment values are set", async () => {
    MODEL_MAPPINGS["test-openrouter"] = makeConfig({ provider: "openrouter" });
    mockChat.mockResolvedValue({ content: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    process.env["OPENROUTER_SITE_URL"] = "https://mysite.com";
    process.env["OPENROUTER_SITE_NAME"] = "MyApp";

    await callModel("test-openrouter", "test prompt");

    const options = mockChat.mock.calls[0][4];
    expect(options.extra_headers).toEqual({
      "HTTP-Referer": "https://mysite.com",
      "X-Title": "MyApp",
    });

    delete process.env["OPENROUTER_SITE_URL"];
    delete process.env["OPENROUTER_SITE_NAME"];
  });

  it("routes mock models to mock_llm without calling chat", async () => {
    MODEL_MAPPINGS["mock-test"] = makeConfig({ provider: "mock" });
    mockIsMockModel.mockReturnValue(true);
    mockMockLlmCall.mockReturnValue({
      content: "mock response",
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });

    const result = await callModel("mock-test", "test prompt");

    expect(result.content).toBe("mock response");
    expect(mockMockLlmCall).toHaveBeenCalledOnce();
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("allows mock models to leave api_url empty", async () => {
    MODEL_MAPPINGS["mock-empty-url"] = makeConfig({
      provider: "mock",
      api_url: "",
      api_key: "mock",
      model_name: "mock-empty-url",
      mock_mappings: { "test prompt": "mock response" },
    });
    mockIsMockModel.mockReturnValue(true);
    mockMockLlmCall.mockReturnValue({
      content: "mock response",
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });

    const result = await callModel("mock-empty-url", "test prompt");

    expect(result.content).toBe("mock response");
    expect(mockMockLlmCall).toHaveBeenCalledWith(
      "test prompt",
      { mock_mappings: { "test prompt": "mock response" } },
      "mock-empty-url"
    );
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("throws and lists available models when the alias is unknown", async () => {
    await expect(callModel("missing-model", "hello")).rejects.toThrow("Unknown model alias");
    await expect(callModel("missing-model", "hello")).rejects.toThrow("missing-model");
  });

  it("throws when the API key is empty", async () => {
    MODEL_MAPPINGS["test-no-key"] = makeConfig({ api_key: "" });

    await expect(callModel("test-no-key", "hello")).rejects.toThrow("API key is missing or empty");
  });

  it("throws when the API key contains only whitespace", async () => {
    MODEL_MAPPINGS["test-blank-key"] = makeConfig({ api_key: "   " });

    await expect(callModel("test-blank-key", "hello")).rejects.toThrow("API key is missing or empty");
  });
});

// ============================================================
// resolveConfig(), tested indirectly through callModel()
// ============================================================

describe("resolveConfig through callModel", () => {
  it("throws when an array-shape config has no enabled entry", async () => {
    MODEL_MAPPINGS["test-none-enabled"] = [
      makeConfig({ provider: "a", enabled: false }),
      makeConfig({ provider: "b", enabled: false }),
    ];

    await expect(callModel("test-none-enabled", "hello")).rejects.toThrow("has no enabled config");
  });

  it("throws when an array-shape config has multiple enabled entries", async () => {
    MODEL_MAPPINGS["test-multi-enabled"] = [
      makeConfig({ provider: "a", enabled: true }),
      makeConfig({ provider: "b", enabled: true }),
    ];

    await expect(callModel("test-multi-enabled", "hello")).rejects.toThrow("multiple enabled configs");
  });

  it("throws when enabled is not a boolean", async () => {
    MODEL_MAPPINGS["test-bad-enabled"] = [
      makeConfig({ provider: "a", enabled: "true" as unknown as boolean }),
    ];

    await expect(callModel("test-bad-enabled", "hello")).rejects.toThrow("must be a boolean");
  });

  it("throws when a required field is missing", async () => {
    const badConfig = makeConfig({ enabled: true });
    delete (badConfig as Record<string, unknown>)["model_name"];
    MODEL_MAPPINGS["test-missing-field"] = [badConfig];

    await expect(callModel("test-missing-field", "hello")).rejects.toThrow("Missing required fields");
  });
});

// ============================================================
// listModels()
// ============================================================

describe("listModels", () => {
  it("returns all model aliases in alphabetical order", () => {
    for (const key of Object.keys(MODEL_MAPPINGS)) delete MODEL_MAPPINGS[key];
    MODEL_MAPPINGS["zebra"] = makeConfig();
    MODEL_MAPPINGS["alpha"] = makeConfig();
    MODEL_MAPPINGS["middle"] = makeConfig();

    const models = listModels();
    expect(models).toEqual(["alpha", "middle", "zebra"]);
  });

  it("returns an empty array when MODEL_MAPPINGS is empty", () => {
    for (const key of Object.keys(MODEL_MAPPINGS)) delete MODEL_MAPPINGS[key];
    expect(listModels()).toEqual([]);
  });
});

// ============================================================
// getModelInfo()
// ============================================================

describe("getModelInfo", () => {
  it("returns object-shape config data with the API key masked", () => {
    MODEL_MAPPINGS["test-info"] = makeConfig({ api_key: "sk-secret-123" });

    const info = getModelInfo("test-info");
    expect(info).not.toBeNull();
    expect(info!["api_key"]).toBe("***");
    expect(info!["provider"]).toBe("test-provider");
    expect(info!["model_name"]).toBe("test-model-v1");
  });

  it("shows Not configured when the API key is empty", () => {
    MODEL_MAPPINGS["test-no-key-info"] = makeConfig({ api_key: "" });

    const info = getModelInfo("test-no-key-info");
    expect(info!["api_key"]).toBe("Not configured");
  });

  it("returns the enabled entry from an array-shape config", () => {
    MODEL_MAPPINGS["test-multi-info"] = [
      makeConfig({ provider: "disabled-one", enabled: false, model_name: "model-a" }),
      makeConfig({ provider: "enabled-one", enabled: true, model_name: "model-b" }),
    ];

    const info = getModelInfo("test-multi-info");
    expect(info!["provider"]).toBe("enabled-one");
    expect(info!["model_name"]).toBe("model-b");
  });

  it("returns an error object when an array-shape config has no enabled entry", () => {
    MODEL_MAPPINGS["test-none-info"] = [
      makeConfig({ provider: "a", enabled: false }),
      makeConfig({ provider: "b", enabled: false }),
    ];

    const info = getModelInfo("test-none-info");
    expect(info!["error"]).toBe("No enabled config");
    expect(info!["available_providers"]).toEqual(["a", "b"]);
  });

  it("returns an error object when an array-shape config has multiple enabled entries", () => {
    MODEL_MAPPINGS["test-dup-info"] = [
      makeConfig({ provider: "x", enabled: true }),
      makeConfig({ provider: "y", enabled: true }),
    ];

    const info = getModelInfo("test-dup-info");
    expect(info!["error"]).toBe("Config error: multiple enabled configs");
  });

  it("returns null when the model does not exist", () => {
    expect(getModelInfo("missing-model")).toBeNull();
  });
});

// ============================================================
// addCustomModel()
// ============================================================

describe("addCustomModel", () => {
  it("adds a custom model that can be called through callModel", async () => {
    addCustomModel(
      "my-custom",
      "custom-provider",
      "https://custom.api/v1/chat",
      "sk-custom-key",
      "custom-model-v2",
      0.5,
      4000
    );

    mockChat.mockResolvedValue({ content: "custom response", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

    const result = await callModel("my-custom", "test custom model");
    expect(result.content).toBe("custom response");
    expect(mockChat.mock.calls[0][1]).toBe("https://custom.api/v1/chat");
    expect(mockChat.mock.calls[0][3]).toBe("custom-model-v2");
  });

  it("makes the custom model visible through listModels", () => {
    addCustomModel("new-model", "p", "url", "key", "name");

    expect(listModels()).toContain("new-model");
  });

  it("merges extra fields into the custom model config", () => {
    addCustomModel("with-extras", "p", "url", "key", "name", 0.7, 2000, {
      pricing: { input: 1.0, output: 2.0, currency: "USD" },
    });

    const pricing = getModelPricingInfo("with-extras");
    expect(pricing).toEqual({ input: 1.0, output: 2.0, currency: "USD" });
  });
});

// ============================================================
// getModelPricingInfo()
// ============================================================

describe("getModelPricingInfo", () => {
  it("returns pricing from an object-shape config", () => {
    MODEL_MAPPINGS["test-priced"] = makeConfig({
      pricing: { input: 2.5, output: 10.0, currency: "USD" },
    });

    const pricing = getModelPricingInfo("test-priced");
    expect(pricing).toEqual({ input: 2.5, output: 10.0, currency: "USD" });
  });

  it("returns null when pricing is not configured", () => {
    const config = makeConfig();
    delete config.pricing;
    MODEL_MAPPINGS["test-no-price"] = config;

    expect(getModelPricingInfo("test-no-price")).toBeNull();
  });

  it("returns pricing from the enabled array-shape config", () => {
    MODEL_MAPPINGS["test-multi-price"] = [
      makeConfig({ enabled: false, pricing: { input: 1, output: 1, currency: "CNY" } }),
      makeConfig({ enabled: true, pricing: { input: 5, output: 15, currency: "USD" } }),
    ];

    const pricing = getModelPricingInfo("test-multi-price");
    expect(pricing).toEqual({ input: 5, output: 15, currency: "USD" });
  });

  it("returns null when an array-shape config has no enabled entry", () => {
    MODEL_MAPPINGS["test-no-enabled-price"] = [
      makeConfig({ enabled: false }),
    ];

    expect(getModelPricingInfo("test-no-enabled-price")).toBeNull();
  });

  it("returns null when the model does not exist", () => {
    expect(getModelPricingInfo("missing-model")).toBeNull();
  });
});

// ============================================================
// reloadModels()
// ============================================================

describe("reloadModels", () => {
  it("reloads MODEL_MAPPINGS and removes runtime-only models", () => {
    addCustomModel("temp-model", "p", "url", "key", "name");
    expect(listModels()).toContain("temp-model");

    reloadModels();

    expect(listModels()).not.toContain("temp-model");
  });
});
