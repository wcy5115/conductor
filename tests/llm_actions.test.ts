import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as fs from "fs";
import * as path from "path";

const {
  mockCallLlmApi,
  mockCallModel,
  mockCalculateCost,
  modelMappings,
} = vi.hoisted(() => ({
  mockCallLlmApi: vi.fn(),
  mockCallModel: vi.fn(),
  mockCalculateCost: vi.fn(),
  modelMappings: {
    vision: {
      provider: "test-provider",
      api_url: "https://api.test.com/v1/chat/completions",
      api_key: "sk-test-key",
      model_name: "vision-model",
      temperature: 0.4,
      max_tokens: 2048,
      extra_params: {},
    },
  },
}));

vi.mock("../src/llm_client.js", () => ({
  callLlmApi: (...args: unknown[]) => mockCallLlmApi(...args),
}));

vi.mock("../src/model_caller.js", () => ({
  callModel: (...args: unknown[]) => mockCallModel(...args),
  MODEL_MAPPINGS: modelMappings,
}));

vi.mock("../src/cost_calculator.js", () => ({
  calculateCost: (...args: unknown[]) => mockCalculateCost(...args),
}));

import { LLMCallAction } from "../src/workflow_actions/llm_actions";

const TEMP_DIR = path.join(process.cwd(), "tests", "_tmp_llm_actions");

function cleanup(): void {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
}

describe("LLMCallAction", () => {
  beforeEach(() => {
    cleanup();
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    vi.clearAllMocks();

    mockCallLlmApi.mockResolvedValue([
      "success",
      {
        content: "extracted text",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ]);

    mockCalculateCost.mockReturnValue({
      input_cost: 0.001,
      output_cost: 0.002,
      total_cost: 0.003,
      currency: "CNY",
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      pricing_available: true,
      model: "vision",
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders multimodal prompts without dropping instruction lines or leaking the image path", async () => {
    const imagePath = path.join(TEMP_DIR, "sample.png");
    fs.writeFileSync(imagePath, "fake image data", "utf-8");

    const action = new LLMCallAction(
      "vision",
      "Please OCR this image: {item}\nTitle: {title}\nReturn plain text only.",
      "ocr_text",
      "END",
      false,
    );

    const result = await action.execute({
      data: {
        item: imagePath,
        title: "Invoice A",
      },
      history: [],
      metadata: {},
    } as any);

    expect(result.data["ocr_text"]).toBe("extracted text");
    expect(mockCallLlmApi).toHaveBeenCalledOnce();
    expect(mockCallModel).not.toHaveBeenCalled();

    const messages = mockCallLlmApi.mock.calls[0][0] as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    const promptText = messages[0].content[0]["text"] as string;

    expect(promptText).toContain("Please OCR this image:");
    expect(promptText).toContain("Title: Invoice A");
    expect(promptText).toContain("Return plain text only.");
    expect(promptText).not.toContain(imagePath);
    expect(promptText).not.toContain("{item}");
    expect(promptText).not.toContain("{title}");
    expect(messages[0].content[1]).toEqual({ type: "image", path: imagePath });
  });
});
