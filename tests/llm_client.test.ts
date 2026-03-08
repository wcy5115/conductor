/**
 * llm_client.ts 单元测试
 *
 * 测试策略：
 *   - 使用 vi.mock 模拟外部依赖（utils.ts、cost_calculator.ts）
 *   - 使用 vi.stubGlobal 模拟全局 fetch 函数
 *   - 通过 process.env.LLM_API_ENABLE 控制安全熔断开关
 *   - 所有 sleep 等待被 mock 掉以加速测试
 *
 * 覆盖范围：
 *   - callLlmApi(): 成功响应、各种 HTTP 错误码、网络错误、重试机制、安全熔断
 *   - chat(): 成功调用、两种错误抛出
 *   - isLlmEnabled(): 通过环境变量间接测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================
// Mock 外部依赖
// ============================================================

// mock utils.ts —— processMessagesWithImages 默认原样返回消息列表
vi.mock("../src/utils.js", () => ({
  processMessagesWithImages: vi.fn((msgs: unknown[]) => msgs),
}));

// mock cost_calculator.ts —— estimateTokensFromText 默认返回 10
vi.mock("../src/cost_calculator.js", () => ({
  estimateTokensFromText: vi.fn(() => 10),
}));

// 导入被测模块（必须在 vi.mock 之后）
import { callLlmApi, chat } from "../src/llm_client";
import type { Message, LlmResult } from "../src/llm_client";
import { processMessagesWithImages } from "../src/utils.js";
import { estimateTokensFromText } from "../src/cost_calculator.js";

// ============================================================
// 辅助工具
// ============================================================

/**
 * 创建一个模拟的 fetch Response 对象
 *
 * @param status  HTTP 状态码
 * @param body    响应体（对象会 JSON 序列化，字符串直接返回）
 * @returns 模拟的 Response 对象，具有 status、json()、text() 等属性
 */
function mockResponse(status: number, body: Record<string, unknown> | string): Response {
  const isJson = typeof body === "object";
  return {
    status,
    // json() 返回 Promise<解析后的对象>
    json: () => Promise.resolve(isJson ? body : JSON.parse(body as string)),
    // text() 返回 Promise<原始文本>
    text: () => Promise.resolve(isJson ? JSON.stringify(body) : (body as string)),
    // 以下属性是 Response 接口必需的，但测试中不使用
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    redirected: false,
    statusText: "",
    type: "basic" as ResponseType,
    url: "",
    clone: () => mockResponse(status, body),
    body: null,
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
    formData: () => Promise.resolve(new FormData()),
    bytes: () => Promise.resolve(new Uint8Array()),
  };
}

/**
 * 构建标准的成功响应体（OpenAI Chat Completions 格式）
 *
 * @param content       AI 回复文本
 * @param finishReason  完成原因，默认 "stop"
 * @param usage         token 用量，传 null 表示不包含 usage 字段
 */
function successBody(
  content: string,
  finishReason = "stop",
  usage: Record<string, number> | null = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    choices: [{ message: { content }, finish_reason: finishReason }],
  };
  if (usage) body.usage = usage;
  return body;
}

/** 标准测试参数：消息列表、API URL、API 密钥、模型名称 */
const testMessages: Message[] = [{ role: "user", content: "Hello" }];
const testUrl = "https://api.example.com/v1/chat/completions";
const testKey = "test-api-key-123";
const testModel = "gpt-4o";

// ============================================================
// 测试套件
// ============================================================

describe("callLlmApi", () => {
  /** 模拟的 fetch 函数，每个测试前重新创建 */
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // 创建新的 mock fetch 并注入全局
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    // 重置所有 mock 的调用记录
    vi.mocked(processMessagesWithImages).mockClear();
    vi.mocked(estimateTokensFromText).mockClear();

    // 默认启用 LLM 调用（绕过安全熔断）
    process.env.LLM_API_ENABLE = "true";

    // mock setTimeout/clearTimeout 以跳过重试等待
    // vi.useFakeTimers 会导致 Promise 行为异常，所以只 mock sleep 中用到的 setTimeout
    // 实际做法：让 sleep 瞬间 resolve（通过 mock setTimeout 立即执行回调）
    vi.spyOn(globalThis, "setTimeout").mockImplementation((cb: TimerHandler) => {
      if (typeof cb === "function") cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
  });

  afterEach(() => {
    // 清理环境变量和 mock
    delete process.env.LLM_API_ENABLE;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ============================================================
  // 成功响应测试
  // ============================================================

  it("成功调用：finish_reason=stop，返回 content 和 usage", async () => {
    // 模拟 API 返回标准成功响应
    mockFetch.mockResolvedValueOnce(mockResponse(200, successBody("Hi there!")));

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    expect(status).toBe("success");
    // result 是 LlmResult 类型，包含 content 和 usage
    const llmResult = result as LlmResult;
    expect(llmResult.content).toBe("Hi there!");
    expect(llmResult.usage.prompt_tokens).toBe(10);
    expect(llmResult.usage.completion_tokens).toBe(5);
    expect(llmResult.usage.total_tokens).toBe(15);
    expect(llmResult.usage.token_source).toBe("api");
  });

  it("成功调用：API 未提供 usage 时，使用 estimateTokensFromText 估算", async () => {
    // usage 为 null → 响应体中不包含 usage 字段
    mockFetch.mockResolvedValueOnce(mockResponse(200, successBody("回复内容", "stop", null)));

    // estimateTokensFromText 第一次调用估算 prompt，第二次估算 completion
    vi.mocked(estimateTokensFromText)
      .mockReturnValueOnce(20)   // prompt 估算
      .mockReturnValueOnce(8);   // completion 估算

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    expect(status).toBe("success");
    const llmResult = result as LlmResult;
    expect(llmResult.usage.prompt_tokens).toBe(20);
    expect(llmResult.usage.completion_tokens).toBe(8);
    expect(llmResult.usage.total_tokens).toBe(28);  // 20 + 8
    expect(llmResult.usage.token_source).toBe("estimated");

    // 验证 estimateTokensFromText 被调用了两次
    expect(estimateTokensFromText).toHaveBeenCalledTimes(2);
  });

  it("成功调用：content 前后有空白字符时被 trim", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, successBody("  Hello World  ")),
    );

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    expect(status).toBe("success");
    expect((result as LlmResult).content).toBe("Hello World");
  });

  // ============================================================
  // finish_reason 处理测试
  // ============================================================

  it("finish_reason=length 且有内容：返回 success 并保留内容", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, successBody("Truncated...", "length")),
    );

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    expect(status).toBe("success");
    expect((result as LlmResult).content).toBe("Truncated...");
  });

  it("finish_reason=length 且无内容：返回 fatal_error", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, successBody("", "length")),
    );

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    expect(status).toBe("fatal_error");
    const err = result as Record<string, unknown>;
    // 错误信息应提到截断和 max_tokens
    expect(err.error).toContain("截断");
  });

  it("未知 finish_reason 且有内容：返回 success", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, successBody("Some content", "content_filter")),
    );

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    expect(status).toBe("success");
    expect((result as LlmResult).content).toBe("Some content");
  });

  it("未知 finish_reason 且无内容：返回 fatal_error", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, successBody("", "content_filter")),
    );

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    expect(status).toBe("fatal_error");
    expect((result as Record<string, unknown>).error).toContain("content_filter");
  });

  // ============================================================
  // HTTP 错误码测试
  // ============================================================

  it("HTTP 400：返回 fatal_error（客户端错误）", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(400, "Invalid request"));

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    expect(status).toBe("fatal_error");
    expect((result as Record<string, unknown>).error).toContain("400");
  });

  it("HTTP 401：返回 fatal_error（认证错误）", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(401, "Unauthorized"));

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    expect(status).toBe("fatal_error");
    expect((result as Record<string, unknown>).error).toContain("401");
  });

  it("HTTP 403：返回 fatal_error（权限错误）", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(403, "Forbidden"));

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    expect(status).toBe("fatal_error");
    expect((result as Record<string, unknown>).error).toContain("403");
  });

  it("HTTP 404：返回 fatal_error（资源未找到）", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(404, "Not found"));

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    expect(status).toBe("fatal_error");
    expect((result as Record<string, unknown>).error).toContain("404");
  });

  it("HTTP 418（未知状态码）：返回 fatal_error", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(418, "I'm a teapot"));

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    expect(status).toBe("fatal_error");
    expect((result as Record<string, unknown>).error).toContain("418");
  });

  // ============================================================
  // 重试机制测试
  // ============================================================

  it("HTTP 429（速率限制）：重试后成功", async () => {
    // 第一次返回 429，第二次返回 200
    mockFetch
      .mockResolvedValueOnce(mockResponse(429, "Rate limit exceeded"))
      .mockResolvedValueOnce(mockResponse(200, successBody("Success after retry")));

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel, {
      max_retries: 3,
      retry_delay: 0.001,  // 极短等待
    });

    expect(status).toBe("success");
    expect((result as LlmResult).content).toBe("Success after retry");
    // fetch 应该被调用了 2 次（第一次 429，第二次成功）
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("HTTP 429：重试次数用尽后返回 retriable_error", async () => {
    // 所有请求都返回 429
    mockFetch.mockResolvedValue(mockResponse(429, "Rate limit exceeded"));

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel, {
      max_retries: 2,
      retry_delay: 0.001,
    });

    expect(status).toBe("retriable_error");
    expect((result as Record<string, unknown>).error).toContain("429");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("HTTP 5xx（服务器错误）：重试后成功", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(500, "Internal server error"))
      .mockResolvedValueOnce(mockResponse(200, successBody("Recovered")));

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel, {
      max_retries: 3,
      retry_delay: 0.001,
    });

    expect(status).toBe("success");
    expect((result as LlmResult).content).toBe("Recovered");
  });

  it("HTTP 5xx：重试次数用尽后返回 retriable_error", async () => {
    mockFetch.mockResolvedValue(mockResponse(503, "Service unavailable"));

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel, {
      max_retries: 2,
      retry_delay: 0.001,
    });

    expect(status).toBe("retriable_error");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("HTTP 408（请求超时）：重试后成功", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(408, "Request Timeout"))
      .mockResolvedValueOnce(mockResponse(200, successBody("OK")));

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel, {
      max_retries: 3,
      retry_delay: 0.001,
    });

    expect(status).toBe("success");
    expect((result as LlmResult).content).toBe("OK");
  });

  // ============================================================
  // 网络层错误测试
  // ============================================================

  it("AbortError（客户端超时）：重试次数用尽返回 retriable_error", async () => {
    // 模拟 AbortController 超时抛出的 AbortError
    const abortError = new DOMException("The operation was aborted", "AbortError");
    mockFetch.mockRejectedValue(abortError);

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel, {
      max_retries: 2,
      retry_delay: 0.001,
    });

    expect(status).toBe("retriable_error");
    expect((result as Record<string, unknown>).error).toContain("超时");
  });

  it("SSL 错误：重试次数用尽返回 retriable_error", async () => {
    const sslError = new Error("SSL certificate problem: unable to get local issuer certificate");
    mockFetch.mockRejectedValue(sslError);

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel, {
      max_retries: 2,
      retry_delay: 0.001,
    });

    expect(status).toBe("retriable_error");
    const err = result as Record<string, unknown>;
    expect(err.error).toContain("SSL");
    expect(err.error_type).toBe("ssl_error");
  });

  it("代理错误：重试次数用尽返回 retriable_error", async () => {
    const proxyError = new Error("proxy connection refused");
    mockFetch.mockRejectedValue(proxyError);

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel, {
      max_retries: 2,
      retry_delay: 0.001,
    });

    expect(status).toBe("retriable_error");
    const err = result as Record<string, unknown>;
    expect(err.error).toContain("代理");
    expect(err.error_type).toBe("proxy_error");
  });

  it("重定向过多：直接返回 fatal_error（不重试）", async () => {
    const redirectError = new Error("Too many redirect");
    mockFetch.mockRejectedValue(redirectError);

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel, {
      max_retries: 3,
      retry_delay: 0.001,
    });

    expect(status).toBe("fatal_error");
    const err = result as Record<string, unknown>;
    expect(err.error).toContain("重定向");
    expect(err.error_type).toBe("redirect_error");
    // 重定向错误不应重试，fetch 只被调用 1 次
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("分块传输错误（chunked）：重试次数用尽返回 retriable_error", async () => {
    // 模拟 HTTP chunked transfer encoding 传输中断
    // 对应 Python 版的 requests.exceptions.ChunkedEncodingError
    const chunkedError = new Error("chunked transfer encoding error: incomplete data");
    mockFetch.mockRejectedValue(chunkedError);

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel, {
      max_retries: 2,
      retry_delay: 0.001,
    });

    expect(status).toBe("retriable_error");
    const err = result as Record<string, unknown>;
    expect(err.error).toContain("数据传输中断");
    expect(err.error_type).toBe("chunked_encoding_error");
    // 应该重试了 2 次
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("分块传输错误（truncated）：重试后成功", async () => {
    // 第一次 truncated 错误，第二次成功
    const truncatedError = new Error("response body truncated");
    mockFetch
      .mockRejectedValueOnce(truncatedError)
      .mockResolvedValueOnce(mockResponse(200, successBody("Recovered")));

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel, {
      max_retries: 3,
      retry_delay: 0.001,
    });

    expect(status).toBe("success");
    expect((result as LlmResult).content).toBe("Recovered");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("通用网络错误：重试次数用尽返回 retriable_error", async () => {
    const networkError = new Error("ECONNREFUSED");
    mockFetch.mockRejectedValue(networkError);

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel, {
      max_retries: 2,
      retry_delay: 0.001,
    });

    expect(status).toBe("retriable_error");
    expect((result as Record<string, unknown>).error).toContain("ECONNREFUSED");
  });

  it("非 Error 对象被抛出：返回 fatal_error", async () => {
    // 模拟 throw "string" 的情况（极少见）
    mockFetch.mockRejectedValue("something went wrong");

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    expect(status).toBe("fatal_error");
    expect((result as Record<string, unknown>).error).toContain("未知错误");
  });

  // ============================================================
  // 请求参数构建测试
  // ============================================================

  it("extra_headers 和 extra_params 被正确传递到 fetch", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, successBody("OK")));

    await callLlmApi(testMessages, testUrl, testKey, testModel, {
      temperature: 0.9,
      max_tokens: 1000,
      extra_headers: { "X-Custom": "value123" },
      extra_params: { thinking: { type: "enabled" } },
    });

    // 获取 fetch 的调用参数
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(testUrl);

    // 验证 headers 中包含自定义头
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Custom"]).toBe("value123");
    expect(headers["Authorization"]).toBe(`Bearer ${testKey}`);

    // 验证 body 中包含额外参数
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe(testModel);
    expect(body.temperature).toBe(0.9);
    expect(body.max_tokens).toBe(1000);
    expect(body.thinking).toEqual({ type: "enabled" });
  });

  it("processMessagesWithImages 被调用以预处理消息", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, successBody("OK")));

    await callLlmApi(testMessages, testUrl, testKey, testModel);

    // 验证预处理函数被调用，且传入了原始消息列表
    expect(processMessagesWithImages).toHaveBeenCalledWith(testMessages);
  });

  // ============================================================
  // 安全熔断测试
  // ============================================================

  it("LLM_API_ENABLE 未设置时：直接返回 fatal_error，不发送请求", async () => {
    // 删除环境变量 → isLlmEnabled() 返回 false → 熔断，不调用 fetch
    delete process.env.LLM_API_ENABLE;

    const [content, usage] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    // 验证直接返回 fatal_error，不发送任何网络请求
    expect(mockFetch).not.toHaveBeenCalled();
    expect(content).toBe("fatal_error");
    expect(usage.error).toMatch(/冻结/);
  });

  it("LLM_API_ENABLE=false 时：直接返回 fatal_error，不发送请求", async () => {
    process.env.LLM_API_ENABLE = "false";

    const [content, usage] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    // 验证直接返回 fatal_error，不发送任何网络请求
    expect(mockFetch).not.toHaveBeenCalled();
    expect(content).toBe("fatal_error");
    expect(usage.error).toMatch(/冻结/);
  });

  it("LLM_API_ENABLE=1 时：使用真实密钥", async () => {
    process.env.LLM_API_ENABLE = "1";

    mockFetch.mockResolvedValueOnce(mockResponse(200, successBody("OK")));

    await callLlmApi(testMessages, testUrl, testKey, testModel);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${testKey}`);
  });

  it("LLM_API_ENABLE=yes 时：使用真实密钥", async () => {
    process.env.LLM_API_ENABLE = "yes";

    mockFetch.mockResolvedValueOnce(mockResponse(200, successBody("OK")));

    await callLlmApi(testMessages, testUrl, testKey, testModel);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${testKey}`);
  });

  // ============================================================
  // 重试次数用尽兜底测试
  // ============================================================

  it("所有重试用尽后的兜底返回 retriable_error", async () => {
    // 所有请求都返回 408（会重试但最终用尽）
    mockFetch.mockResolvedValue(mockResponse(408, "Timeout"));

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel, {
      max_retries: 1,
      retry_delay: 0.001,
    });

    expect(status).toBe("retriable_error");
  });
});

// ============================================================
// chat() 简化接口测试
// ============================================================

describe("chat", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    process.env.LLM_API_ENABLE = "true";
    vi.spyOn(globalThis, "setTimeout").mockImplementation((cb: TimerHandler) => {
      if (typeof cb === "function") cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
  });

  afterEach(() => {
    delete process.env.LLM_API_ENABLE;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("成功调用：返回 LlmResult 对象", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, successBody("Hello!")));

    const result = await chat("Hi", testUrl, testKey, testModel);

    expect(result.content).toBe("Hello!");
    expect(result.usage.total_tokens).toBe(15);
  });

  it("可重试错误：抛出包含 '可重试' 的 Error", async () => {
    // 所有请求返回 429 → 重试用尽 → retriable_error
    mockFetch.mockResolvedValue(mockResponse(429, "Rate limit"));

    await expect(
      chat("Hi", testUrl, testKey, testModel, { max_retries: 1, retry_delay: 0.001 }),
    ).rejects.toThrow("可重试");
  });

  it("致命错误：抛出包含 '致命错误' 的 Error", async () => {
    // 返回 400 → fatal_error
    mockFetch.mockResolvedValueOnce(mockResponse(400, "Bad request"));

    await expect(
      chat("Hi", testUrl, testKey, testModel),
    ).rejects.toThrow("致命错误");
  });

  it("自动将 prompt 包装为消息列表", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, successBody("OK")));

    await chat("Test prompt", testUrl, testKey, testModel);

    // 验证 processMessagesWithImages 收到的是 [{ role: "user", content: "Test prompt" }]
    expect(processMessagesWithImages).toHaveBeenCalledWith([
      { role: "user", content: "Test prompt" },
    ]);
  });

  it("options 参数被传递到 callLlmApi", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, successBody("OK")));

    await chat("Hi", testUrl, testKey, testModel, {
      temperature: 0.2,
      max_tokens: 500,
    });

    // 验证 fetch 收到的 body 中包含 temperature 和 max_tokens
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(500);
  });
});
