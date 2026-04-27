/**
 * Unit tests for llm_client.ts.
 *
 * Test strategy:
 *   - Use vi.mock to mock external dependencies: utils.ts and cost_calculator.ts.
 *   - Use vi.stubGlobal to mock the global fetch function.
 *   - Control the safety gate through process.env.LLM_API_ENABLE.
 *   - Mock sleep waits to keep tests fast.
 *
 * Coverage:
 *   - callLlmApi(): success responses, HTTP errors, network errors, retries, and safety gate.
 *   - chat(): successful calls and both error paths.
 *   - isLlmEnabled(): tested indirectly through environment variables.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================
// Mock external dependencies.
// ============================================================

// Mock utils.ts: processMessagesWithImages returns the message list unchanged by default.
vi.mock("../src/utils.js", () => ({
  processMessagesWithImages: vi.fn((msgs: unknown[]) => msgs),
}));

// Mock cost_calculator.ts: estimateTokensFromText returns 10 by default.
vi.mock("../src/cost_calculator.js", () => ({
  estimateTokensFromText: vi.fn(() => 10),
}));

// Import the module under test. This must happen after vi.mock.
import { callLlmApi, chat } from "../src/llm_client";
import type { Message, LlmResult } from "../src/llm_client";
import { processMessagesWithImages } from "../src/utils.js";
import { estimateTokensFromText } from "../src/cost_calculator.js";

// ============================================================
// Test helpers
// ============================================================

/**
 * Create a mocked fetch Response object.
 *
 * @param status HTTP status code.
 * @param body Response body; objects are JSON-serialized and strings are returned directly.
 * @returns Mocked Response object with status, json(), text(), and related properties.
 */
function mockResponse(status: number, body: Record<string, unknown> | string): Response {
  const isJson = typeof body === "object";
  return {
    status,
    // json() returns Promise<parsed object>.
    json: () => Promise.resolve(isJson ? body : JSON.parse(body as string)),
    // text() returns Promise<raw text>.
    text: () => Promise.resolve(isJson ? JSON.stringify(body) : (body as string)),
    // The remaining properties are required by the Response interface but unused in tests.
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
 * Build a standard successful response body in OpenAI Chat Completions format.
 *
 * @param content AI response text.
 * @param finishReason Finish reason, defaulting to "stop".
 * @param usage Token usage; pass null to omit the usage field.
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

/** Standard test parameters: messages, API URL, API key, and model name. */
const testMessages: Message[] = [{ role: "user", content: "Hello" }];
const testUrl = "https://api.example.com/v1/chat/completions";
const testKey = "test-api-key-123";
const testModel = "gpt-4o";

// ============================================================
// Test suite
// ============================================================

describe("callLlmApi", () => {
  /** Mocked fetch function, recreated before each test. */
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Create a fresh mock fetch and install it globally.
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    // Reset all mock call records.
    vi.mocked(processMessagesWithImages).mockClear();
    vi.mocked(estimateTokensFromText).mockClear();

    // Enable LLM calls by default to bypass the safety gate.
    process.env.LLM_API_ENABLE = "true";

    // Mock setTimeout/clearTimeout to skip retry waits.
    // vi.useFakeTimers can interfere with Promises, so only mock the setTimeout used by sleep.
    // The callback runs immediately, making sleep resolve instantly.
    vi.spyOn(globalThis, "setTimeout").mockImplementation((cb: TimerHandler) => {
      if (typeof cb === "function") cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
  });

  afterEach(() => {
    // Clean up environment variables and mocks.
    delete process.env.LLM_API_ENABLE;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ============================================================
  // Successful responses
  // ============================================================

  it("successful call: finish_reason=stop returns content and usage", async () => {
    // Mock a standard successful API response.
    mockFetch.mockResolvedValueOnce(mockResponse(200, successBody("Hi there!")));

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    expect(status).toBe("success");
    // result is LlmResult and contains content and usage.
    const llmResult = result as LlmResult;
    expect(llmResult.content).toBe("Hi there!");
    expect(llmResult.usage.prompt_tokens).toBe(10);
    expect(llmResult.usage.completion_tokens).toBe(5);
    expect(llmResult.usage.total_tokens).toBe(15);
    expect(llmResult.usage.token_source).toBe("api");
  });

  it("successful call: estimates tokens when the API does not provide usage", async () => {
    // usage null means the response body does not include a usage field.
    mockFetch.mockResolvedValueOnce(mockResponse(200, successBody("Reply content", "stop", null)));

    // The first estimateTokensFromText call estimates prompt tokens; the second estimates completion tokens.
    vi.mocked(estimateTokensFromText)
      .mockReturnValueOnce(20)   // Prompt estimate.
      .mockReturnValueOnce(8);   // Completion estimate.

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    expect(status).toBe("success");
    const llmResult = result as LlmResult;
    expect(llmResult.usage.prompt_tokens).toBe(20);
    expect(llmResult.usage.completion_tokens).toBe(8);
    expect(llmResult.usage.total_tokens).toBe(28);  // 20 + 8.
    expect(llmResult.usage.token_source).toBe("estimated");

    // Verify that estimateTokensFromText was called twice.
    expect(estimateTokensFromText).toHaveBeenCalledTimes(2);
  });

  it("successful call: trims leading and trailing content whitespace", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, successBody("  Hello World  ")),
    );

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    expect(status).toBe("success");
    expect((result as LlmResult).content).toBe("Hello World");
  });

  // ============================================================
  // finish_reason handling
  // ============================================================

  it("finish_reason=length with content returns success and keeps content", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, successBody("Truncated...", "length")),
    );

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    expect(status).toBe("success");
    expect((result as LlmResult).content).toBe("Truncated...");
  });

  it("finish_reason=length with no content returns fatal_error", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, successBody("", "length")),
    );

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    expect(status).toBe("fatal_error");
    const err = result as Record<string, unknown>;
    // The error should mention truncation and max_tokens.
    expect(err.error).toContain("truncated");
  });

  it("unknown finish_reason with content returns success", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, successBody("Some content", "content_filter")),
    );

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    expect(status).toBe("success");
    expect((result as LlmResult).content).toBe("Some content");
  });

  it("unknown finish_reason with no content returns fatal_error", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, successBody("", "content_filter")),
    );

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    expect(status).toBe("fatal_error");
    expect((result as Record<string, unknown>).error).toContain("content_filter");
  });

  // ============================================================
  // HTTP status code errors
  // ============================================================

  it("HTTP 400 returns fatal_error for client error", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(400, "Invalid request"));

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    expect(status).toBe("fatal_error");
    expect((result as Record<string, unknown>).error).toContain("400");
  });

  it("HTTP 401 returns fatal_error for authentication error", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(401, "Unauthorized"));

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    expect(status).toBe("fatal_error");
    expect((result as Record<string, unknown>).error).toContain("401");
  });

  it("HTTP 403 returns fatal_error for permission error", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(403, "Forbidden"));

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    expect(status).toBe("fatal_error");
    expect((result as Record<string, unknown>).error).toContain("403");
  });

  it("HTTP 404 returns fatal_error for missing resource", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(404, "Not found"));

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    expect(status).toBe("fatal_error");
    expect((result as Record<string, unknown>).error).toContain("404");
  });

  it("HTTP 418 returns fatal_error for unknown status code", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(418, "I'm a teapot"));

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    expect(status).toBe("fatal_error");
    expect((result as Record<string, unknown>).error).toContain("418");
  });

  // ============================================================
  // Retry behavior
  // ============================================================

  it("HTTP 429 rate limit succeeds after retry", async () => {
    // First request returns 429, second returns 200.
    mockFetch
      .mockResolvedValueOnce(mockResponse(429, "Rate limit exceeded"))
      .mockResolvedValueOnce(mockResponse(200, successBody("Success after retry")));

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel, {
      max_retries: 3,
      retry_delay: 0.001,  // Very short wait.
    });

    expect(status).toBe("success");
    expect((result as LlmResult).content).toBe("Success after retry");
    // fetch should be called twice: 429 first, success second.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("HTTP 429 returns retriable_error after retries are exhausted", async () => {
    // Every request returns 429.
    mockFetch.mockResolvedValue(mockResponse(429, "Rate limit exceeded"));

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel, {
      max_retries: 2,
      retry_delay: 0.001,
    });

    expect(status).toBe("retriable_error");
    expect((result as Record<string, unknown>).error).toContain("429");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("HTTP 5xx server error succeeds after retry", async () => {
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

  it("HTTP 5xx returns retriable_error after retries are exhausted", async () => {
    mockFetch.mockResolvedValue(mockResponse(503, "Service unavailable"));

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel, {
      max_retries: 2,
      retry_delay: 0.001,
    });

    expect(status).toBe("retriable_error");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("HTTP 408 request timeout succeeds after retry", async () => {
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
  // Network-level errors
  // ============================================================

  it("AbortError client timeout returns retriable_error after retries are exhausted", async () => {
    // Mock AbortError thrown by AbortController timeout.
    const abortError = new DOMException("The operation was aborted", "AbortError");
    mockFetch.mockRejectedValue(abortError);

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel, {
      max_retries: 2,
      retry_delay: 0.001,
    });

    expect(status).toBe("retriable_error");
    expect((result as Record<string, unknown>).error).toContain("timed out");
  });

  it("SSL error returns retriable_error after retries are exhausted", async () => {
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

  it("proxy error returns retriable_error after retries are exhausted", async () => {
    const proxyError = new Error("proxy connection refused");
    mockFetch.mockRejectedValue(proxyError);

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel, {
      max_retries: 2,
      retry_delay: 0.001,
    });

    expect(status).toBe("retriable_error");
    const err = result as Record<string, unknown>;
    expect(err.error).toContain("Proxy");
    expect(err.error_type).toBe("proxy_error");
  });

  it("too many redirects returns fatal_error without retrying", async () => {
    const redirectError = new Error("Too many redirect");
    mockFetch.mockRejectedValue(redirectError);

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel, {
      max_retries: 3,
      retry_delay: 0.001,
    });

    expect(status).toBe("fatal_error");
    const err = result as Record<string, unknown>;
    expect(err.error).toContain("Redirect");
    expect(err.error_type).toBe("redirect_error");
    // Redirect errors should not retry, so fetch is called once.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("chunked transfer error returns retriable_error after retries are exhausted", async () => {
    // Mock an interrupted HTTP chunked transfer encoding response.
    // Equivalent to requests.exceptions.ChunkedEncodingError in Python.
    const chunkedError = new Error("chunked transfer encoding error: incomplete data");
    mockFetch.mockRejectedValue(chunkedError);

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel, {
      max_retries: 2,
      retry_delay: 0.001,
    });

    expect(status).toBe("retriable_error");
    const err = result as Record<string, unknown>;
    expect(err.error).toContain("Transfer interrupted");
    expect(err.error_type).toBe("chunked_encoding_error");
    // It should retry twice.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("truncated transfer error succeeds after retry", async () => {
    // First request throws a truncated error, second succeeds.
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

  it("generic network error returns retriable_error after retries are exhausted", async () => {
    const networkError = new Error("ECONNREFUSED");
    mockFetch.mockRejectedValue(networkError);

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel, {
      max_retries: 2,
      retry_delay: 0.001,
    });

    expect(status).toBe("retriable_error");
    expect((result as Record<string, unknown>).error).toContain("ECONNREFUSED");
  });

  it("thrown non-Error object returns fatal_error", async () => {
    // Mock the rare case of throw "string".
    mockFetch.mockRejectedValue("something went wrong");

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    expect(status).toBe("fatal_error");
    expect((result as Record<string, unknown>).error).toContain("Unknown error");
  });

  // ============================================================
  // Request parameter construction
  // ============================================================

  it("passes extra_headers and extra_params to fetch", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, successBody("OK")));

    await callLlmApi(testMessages, testUrl, testKey, testModel, {
      temperature: 0.9,
      max_tokens: 1000,
      extra_headers: { "X-Custom": "value123" },
      extra_params: { thinking: { type: "enabled" } },
    });

    // Get fetch call arguments.
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(testUrl);

    // Verify custom headers are included.
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Custom"]).toBe("value123");
    expect(headers["Authorization"]).toBe(`Bearer ${testKey}`);

    // Verify the body includes extra parameters.
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe(testModel);
    expect(body.temperature).toBe(0.9);
    expect(body.max_tokens).toBe(1000);
    expect(body.thinking).toEqual({ type: "enabled" });
  });

  it("calls processMessagesWithImages to preprocess messages", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, successBody("OK")));

    await callLlmApi(testMessages, testUrl, testKey, testModel);

    // Verify the preprocessing function receives the original message list.
    expect(processMessagesWithImages).toHaveBeenCalledWith(testMessages);
  });

  // ============================================================
  // Safety gate
  // ============================================================

  it("returns fatal_error without sending a request when LLM_API_ENABLE is unset", async () => {
    // Delete the environment variable so isLlmEnabled() returns false and fetch is not called.
    delete process.env.LLM_API_ENABLE;

    const [content, usage] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    // Verify it returns fatal_error directly without sending any network request.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(content).toBe("fatal_error");
    expect(usage.error).toMatch(/disabled/);
  });

  it("returns fatal_error without sending a request when LLM_API_ENABLE=false", async () => {
    process.env.LLM_API_ENABLE = "false";

    const [content, usage] = await callLlmApi(testMessages, testUrl, testKey, testModel);

    // Verify it returns fatal_error directly without sending any network request.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(content).toBe("fatal_error");
    expect(usage.error).toMatch(/disabled/);
  });

  it("uses the real key when LLM_API_ENABLE=1", async () => {
    process.env.LLM_API_ENABLE = "1";

    mockFetch.mockResolvedValueOnce(mockResponse(200, successBody("OK")));

    await callLlmApi(testMessages, testUrl, testKey, testModel);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${testKey}`);
  });

  it("uses the real key when LLM_API_ENABLE=yes", async () => {
    process.env.LLM_API_ENABLE = "yes";

    mockFetch.mockResolvedValueOnce(mockResponse(200, successBody("OK")));

    await callLlmApi(testMessages, testUrl, testKey, testModel);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${testKey}`);
  });

  // ============================================================
  // Retry exhaustion fallback
  // ============================================================

  it("returns retriable_error after all retries are exhausted", async () => {
    // Every request returns 408, which retries and eventually exhausts attempts.
    mockFetch.mockResolvedValue(mockResponse(408, "Timeout"));

    const [status, result] = await callLlmApi(testMessages, testUrl, testKey, testModel, {
      max_retries: 1,
      retry_delay: 0.001,
    });

    expect(status).toBe("retriable_error");
  });
});

// ============================================================
// chat() simplified interface
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

  it("successful call returns an LlmResult object", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, successBody("Hello!")));

    const result = await chat("Hi", testUrl, testKey, testModel);

    expect(result.content).toBe("Hello!");
    expect(result.usage.total_tokens).toBe(15);
  });

  it("retriable error throws an Error containing 'retriable'", async () => {
    // Every request returns 429, exhausting retries and producing retriable_error.
    mockFetch.mockResolvedValue(mockResponse(429, "Rate limit"));

    await expect(
      chat("Hi", testUrl, testKey, testModel, { max_retries: 1, retry_delay: 0.001 }),
    ).rejects.toThrow("retriable");
  });

  it("fatal error throws an Error containing 'fatal'", async () => {
    // A 400 response produces fatal_error.
    mockFetch.mockResolvedValueOnce(mockResponse(400, "Bad request"));

    await expect(
      chat("Hi", testUrl, testKey, testModel),
    ).rejects.toThrow("fatal");
  });

  it("automatically wraps prompt as a message list", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, successBody("OK")));

    await chat("Test prompt", testUrl, testKey, testModel);

    // Verify processMessagesWithImages receives [{ role: "user", content: "Test prompt" }].
    expect(processMessagesWithImages).toHaveBeenCalledWith([
      { role: "user", content: "Test prompt" },
    ]);
  });

  it("passes options to callLlmApi", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, successBody("OK")));

    await chat("Hi", testUrl, testKey, testModel, {
      temperature: 0.2,
      max_tokens: 500,
    });

    // Verify the fetch body includes temperature and max_tokens.
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(500);
  });
});
