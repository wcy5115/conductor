/**
 * Mock LLM module.
 *
 * Provides simulated LLM responses without real API calls or any cost.
 * Main use cases:
 *   - Development debugging: quickly verify workflow logic without waiting for API responses.
 *   - Unit tests: deterministic output that is easy to assert.
 *   - CI/CD: run integration tests without configuring API keys.
 *
 * Usage: configure a model whose alias starts with "mock" in models.yaml:
 *
 *   mock-translate:
 *     provider: mock           # Optional; aliases starting with mock are detected automatically.
 *     api_url: ""              # Mock mode does not need a real URL.
 *     api_key: "mock"          # Mock mode does not need a real key.
 *     model_name: mock-translate
 *     mock_mappings:
 *       "Translate this text to English: hello": '{"translation": "Hello"}'
 *       "Translate this text to English: goodbye": '{"translation": "Goodbye"}'
 *
 * Matching rules:
 *   - The prompt must exactly match a key in mock_mappings to return its value.
 *   - A missing match throws immediately, which helps debug prompt template issues.
 *
 * Use different mock models for different scenarios:
 *   mock-translate: simulated responses for translation workflows.
 *   mock-summary:   simulated responses for summarization workflows.
 *   mock-ocr:       simulated responses for image recognition workflows.
 */

// Mock calls return the same content + usage shape as real LLM calls.
import { LlmResult, UsageDict } from "./llm_client.js";
import { terminalInternalInfo } from "./core/terminal_reporter.js";

/**
 * Minimal logger, matching the lightweight style used by the other modules.
 */
const logger = {
  info: (msg: string) => terminalInternalInfo(msg),
};

// ============================================================
// Types
// ============================================================

/**
 * Mock-model configuration extracted from SingleModelConfig in models.yaml.
 *
 * mock_mappings: exact prompt-to-response mapping.
 *   - Key: the full prompt text after placeholder replacement.
 *   - Value: the simulated response text.
 *   - Record<string, string> is equivalent to Python's dict[str, str].
 *
 * Example:
 *   {
 *     "Translate: hello": '{"translation": "Hello"}',
 *     "Translate: goodbye": '{"translation": "Goodbye"}'
 *   }
 */
export interface MockConfig {
  mock_mappings: Record<string, string>;
}

// ============================================================
// Core functions
// ============================================================

/**
 * Check whether a model should use the mock path.
 *
 * A model is treated as mock when either condition is true:
 *   1. The model alias starts with "mock", such as "mock-translate" or "mock_summary".
 *   2. The provider field is "mock".
 *
 * Supporting both forms keeps configuration convenient and explicit.
 *
 * @param modelAlias Model alias, which is the key in models.yaml.
 * @param provider Provider name, read from the config when available.
 * @returns true when the model should use the simulated path.
 */
export function isMockModel(modelAlias: string, provider?: string): boolean {
  return modelAlias.startsWith("mock") || provider === "mock";
}

/**
 * Generate a simulated LLM response.
 *
 * Looks up an exact prompt match in mock_mappings:
 *   - Match found: return the mapped value as the response.
 *   - No match: throw an error that lists the available keys for debugging.
 *
 * The return value uses the same LlmResult shape as real LLM calls, so callers
 * such as model_caller.ts and llm_actions.ts do not need a separate mock branch.
 *
 * @param prompt User prompt after placeholder replacement.
 * @param config Mock config containing the mock_mappings table.
 * @param modelAlias Model alias used in error messages.
 * @returns LlmResult containing content and estimated token usage.
 * @throws Error when the prompt does not match any mock_mappings key.
 */
export function mockLlmCall(
  prompt: string,
  config: MockConfig,
  modelAlias: string
): LlmResult {
  const mappings = config.mock_mappings;

  // Step 1: make sure mock_mappings exists.
  if (!mappings || Object.keys(mappings).length === 0) {
    throw new Error(
      `[Mock] Model '${modelAlias}' has no mock_mappings configured.\n` +
        `Add a mock_mappings field in models.yaml, for example:\n` +
        `  ${modelAlias}:\n` +
        `    provider: mock\n` +
        `    api_url: ""\n` +
        `    api_key: "mock"\n` +
        `    model_name: ${modelAlias}\n` +
        `    mock_mappings:\n` +
        `      "your prompt text": "expected response"`
    );
  }

  // Step 2: exact prompt match.
  const content = mappings[prompt];

  if (content === undefined) {
    // List available keys to make prompt-template mismatches easier to compare.
    const availableKeys = Object.keys(mappings)
      .map((k, i) => `  ${i + 1}. "${k.length > 80 ? k.slice(0, 80) + "..." : k}"`)
      .join("\n");

    // Keep the received prompt preview short enough for readable logs.
    const promptPreview = prompt.length > 200 ? prompt.slice(0, 200) + "..." : prompt;

    throw new Error(
      `[Mock] Model '${modelAlias}' has no matching prompt.\n\n` +
        `Received prompt:\n  "${promptPreview}"\n\n` +
        `Available keys in mock_mappings:\n${availableKeys}\n\n` +
        `Hint: mock mode requires the prompt to match a key exactly, including spaces and line breaks.`
    );
  }

  logger.info(`[Mock] ${modelAlias} matched a mapping; returning simulated response (${content.length} chars)`);

  // Step 3: estimate token usage. Mock mode has no real token consumption, but
  // cost calculation and logs still expect a usage object.
  const estimatedPromptTokens = Math.ceil(prompt.length / 2);
  const estimatedCompletionTokens = Math.ceil(content.length / 2);

  const usage: UsageDict = {
    prompt_tokens: estimatedPromptTokens,
    completion_tokens: estimatedCompletionTokens,
    total_tokens: estimatedPromptTokens + estimatedCompletionTokens,
    token_source: "estimated",
  };

  return { content, usage };
}
