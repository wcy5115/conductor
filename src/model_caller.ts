/**
 * Model alias mapping and dispatch.
 *
 * This module sits above llm_client.ts. It lets callers use short model aliases
 * such as "gpt4" or "kimi" without knowing the provider URL, API key, or full
 * model name. The connection details live in models.yaml.
 *
 * The api_key field supports ${ENV_VAR} placeholders. At runtime those
 * placeholders are replaced with environment variable values, so real secrets do
 * not need to be written into models.yaml.
 *
 * Typical call path:
 *   callModel("gpt4", "hello")
 *     -> find MODEL_MAPPINGS["gpt4"]
 *     -> call llm_client.chat(prompt, apiUrl, apiKey, modelName, options)
 *     -> llm_client.callLlmApi(...)
 *     -> fetch(apiUrl, ...)
 *
 * models.yaml supports two shapes:
 *   1. Object shape: one alias maps directly to one provider config.
 *   2. Array shape: one alias maps to several provider configs, and exactly one
 *      entry is selected with enabled: true.
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { fileURLToPath } from "url";
import { chat } from "./llm_client.js";
import type { LlmResult, LlmCallOptions } from "./llm_client.js";
import { mockLlmCall, isMockModel, MockConfig } from "./mock_llm.js";
import {
  terminalInternalInfo,
  terminalWarn,
  terminalError,
} from "./core/terminal_reporter.js";

/**
 * Minimal logger.
 *
 * Keeping this tiny avoids adding a logging dependency to the core library.
 */
const logger = {
  info: (msg: string) => terminalInternalInfo(msg),
  warning: (msg: string) => terminalWarn(msg),
  error: (msg: string) => terminalError(msg),
};

// ============================================================
// Types
// ============================================================

/**
 * Pricing metadata for a model.
 *
 * Values are prices per one million tokens. cost_calculator.ts uses this
 * structure to estimate the cost of each LLM call.
 */
export interface ModelPricing {
  input: number;
  output: number;
  currency: string;
}

/**
 * One complete provider configuration for a model alias.
 *
 * enabled:
 *   Only meaningful in the array shape. Object-shape configs are treated as
 *   enabled by default.
 *
 * provider:
 *   A provider label such as "openai", "azure", "openrouter", or "kimi".
 *
 * api_url:
 *   The chat-completions compatible endpoint URL.
 *
 * api_key:
 *   The API key, usually written as a placeholder such as ${OPENAI_API_KEY}.
 *
 * model_name:
 *   The provider-specific model identifier, such as "gpt-4o".
 *
 * extra_params:
 *   Provider-specific request parameters that are passed through to llm_client.
 *
 * [key: string]: unknown:
 *   Allows forward-compatible provider-specific fields without changing this
 *   interface every time a provider adds an option.
 */
export interface SingleModelConfig {
  enabled?: boolean;
  provider: string;
  api_url: string;
  api_key: string;
  model_name: string;
  temperature?: number;
  max_tokens?: number;
  extra_params?: Record<string, unknown>;
  pricing?: ModelPricing;
  [key: string]: unknown;
}

/**
 * A model alias can point to one config object or to a list of provider configs.
 */
export type ModelConfigEntry = SingleModelConfig | SingleModelConfig[];

/**
 * All known model aliases.
 *
 * The key is the short alias used by the workflow. The value is the provider
 * config or the provider-config list for that alias.
 */
export type ModelMappings = Record<string, ModelConfigEntry>;

// ============================================================
// Loading models.yaml
// ============================================================

/**
 * Recursively replace ${ENV_VAR} placeholders inside strings.
 *
 * This function walks nested arrays and objects so placeholders can appear in
 * any provider field, not only at the top level. Object keys are left unchanged.
 *
 * Examples:
 *   "Bearer ${API_KEY}" -> "Bearer sk-abc123"
 *   { api_key: "${KEY}", retries: 3 } -> { api_key: "sk-abc123", retries: 3 }
 */
function resolveEnvPlaceholders(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? "");
  }
  if (Array.isArray(value)) {
    return value.map(resolveEnvPlaceholders);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveEnvPlaceholders(v)])
    );
  }
  return value;
}

/**
 * Locate models.yaml.
 *
 * Lookup order:
 *   1. MODELS_YAML_PATH, when provided.
 *   2. The project root inferred from this module's location.
 *
 * ESM modules do not have __dirname, so import.meta.url must first be converted
 * into a normal file path.
 */
function findModelsYaml(): string {
  if (process.env["MODELS_YAML_PATH"]) return process.env["MODELS_YAML_PATH"];

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(currentDir, "..");
  return path.join(projectRoot, "models.yaml");
}

/**
 * Load and parse model mappings from models.yaml.
 *
 * The optional models.mock.yaml file sits next to models.yaml and is merged into
 * the main mappings when present. Mock entries intentionally override matching
 * real entries, which makes tests and demos easy to run without touching the
 * production model config.
 */
function loadModelMappings(): ModelMappings {
  const yamlPath = findModelsYaml();

  if (!fs.existsSync(yamlPath)) {
    throw new Error(
      `Model config file not found: ${yamlPath}\n` +
        `Create models.yaml in the project root, or set MODELS_YAML_PATH.`
    );
  }

  const raw = yaml.load(fs.readFileSync(yamlPath, "utf-8"));
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid models.yaml format: top-level value must be a key-value object`);
  }

  const mappings = resolveEnvPlaceholders(raw) as ModelMappings;

  const mockYamlPath = yamlPath.replace(/models\.yaml$/, "models.mock.yaml");
  if (fs.existsSync(mockYamlPath)) {
    const mockRaw = yaml.load(fs.readFileSync(mockYamlPath, "utf-8"));
    if (mockRaw && typeof mockRaw === "object") {
      const mockMappings = resolveEnvPlaceholders(mockRaw) as ModelMappings;
      Object.assign(mappings, mockMappings);
      logger.info(`Loaded optional mock model aliases: ${mockYamlPath} (${Object.keys(mockMappings).length} models)`);
    }
  }

  return mappings;
}

/**
 * Global model mappings loaded once at module import time.
 *
 * This is let instead of const because reloadModels() replaces the whole mapping
 * object after reading models.yaml again.
 */
export let MODEL_MAPPINGS: ModelMappings = loadModelMappings();

// ============================================================
// Internal helpers
// ============================================================

/**
 * Validate that a provider config has the required fields.
 *
 * api_url is required only for real provider models. Mock models never contact
 * a provider endpoint, so their documented config can leave api_url empty.
 *
 * api_key is checked by key existence here, not by truthiness, because an unset
 * environment variable intentionally resolves to an empty string. callModel()
 * later turns that empty key into a clearer runtime error for real providers.
 */
function validateConfigFields(
  config: Partial<SingleModelConfig>,
  modelAlias: string,
  providerName: string
): void {
  const requiredFields: (keyof SingleModelConfig)[] = ["provider", "model_name"];
  if (!isMockModel(modelAlias, config.provider)) {
    requiredFields.push("api_url");
  }

  const missing = requiredFields.filter((f) => !config[f]);

  if (!("api_key" in config)) {
    missing.push("api_key");
  }

  if (missing.length > 0) {
    throw new Error(
      `Model '${modelAlias}' has an invalid config.\n` +
        `Missing required fields: ${missing.join(", ")}\n` +
        `Provider: ${providerName}`
    );
  }
}

/**
 * Resolve a model config entry to the single provider config that should be used.
 *
 * Array shape:
 *   The entry must contain exactly one item with enabled: true.
 *
 * Object shape:
 *   The object is used directly.
 */
function resolveConfig(entry: ModelConfigEntry, modelAlias: string): SingleModelConfig {
  if (Array.isArray(entry)) {
    for (const item of entry) {
      if ("enabled" in item && typeof item.enabled !== "boolean") {
        throw new Error(
          `Config error: model '${modelAlias}' field 'enabled' must be a boolean (true/false).\n` +
            `Provider '${item.provider ?? "unknown"}' enabled value is: ${JSON.stringify(item.enabled)} (${typeof item.enabled})\n` +
            `Set it to true or false.`
        );
      }
    }

    const enabledConfigs = entry.filter((item) => item.enabled === true);

    if (enabledConfigs.length === 0) {
      const providers = entry.map((item) => item.provider ?? "unknown");
      throw new Error(
        `Model '${modelAlias}' has no enabled config.\n` +
          `Available providers: ${providers.join(", ")}\n` +
          `Set one config's 'enabled' field to true in MODEL_MAPPINGS.`
      );
    }

    if (enabledConfigs.length > 1) {
      const providers = enabledConfigs.map((item) => item.provider ?? "unknown");
      throw new Error(
        `Config error: model '${modelAlias}' has multiple enabled configs.\n` +
          `Enabled providers: ${providers.join(", ")}\n` +
          `Only one config can have 'enabled' set to true.`
      );
    }

    const config = { ...enabledConfigs[0]! } as SingleModelConfig;
    validateConfigFields(config, modelAlias, config.provider ?? "unknown");
    return config;
  }

  const config = { ...entry };
  validateConfigFields(config, modelAlias, config.provider ?? "unknown");
  return config;
}

// ============================================================
// Public model call
// ============================================================

/**
 * Call an AI model by short alias.
 *
 * Flow:
 *   1. Find the alias in MODEL_MAPPINGS.
 *   2. Resolve the active provider config.
 *   3. Route mock models to mock_llm.ts.
 *   4. Validate that an API key is configured.
 *   5. Merge call-time options over model defaults.
 *   6. Add provider-specific options, such as OpenRouter attribution headers.
 *   7. Call llm_client.chat().
 *
 * Option priority:
 *   callModel arguments -> models.yaml values -> hard-coded defaults.
 */
export async function callModel(
  modelAlias: string,
  prompt: string,
  temperature?: number,
  maxTokens?: number,
  timeout?: number,
  options: Pick<LlmCallOptions, "max_retries" | "retry_delay" | "retry_backoff"> = {},
): Promise<LlmResult> {
  const entry = MODEL_MAPPINGS[modelAlias];
  if (entry === undefined) {
    const availableModels = Object.keys(MODEL_MAPPINGS).join(", ");
    throw new Error(
      `Unknown model alias: '${modelAlias}'\nAvailable models: ${availableModels}`
    );
  }

  const config = resolveConfig(entry, modelAlias);

  if (isMockModel(modelAlias, config.provider)) {
    logger.info(`[Mock] Using mock mode: ${modelAlias} (${config.model_name})`);
    const mockConfig: MockConfig = {
      mock_mappings: (config["mock_mappings"] as Record<string, string>) ?? {},
    };
    return mockLlmCall(prompt, mockConfig, modelAlias);
  }

  if (!config.api_key || config.api_key.trim() === "") {
    throw new Error(
      `Model '${modelAlias}' API key is missing or empty.\n` +
        `Provider: ${config.provider}\n` +
        `Set the matching environment variable in your .env file.`
    );
  }

  const finalTemperature = temperature ?? config.temperature ?? 0.7;
  const finalMaxTokens = maxTokens ?? config.max_tokens ?? 2000;
  const extraParams = config.extra_params ?? {};

  logger.info(`Calling model: ${modelAlias} (${config.provider} / ${config.model_name})`);

  let extraHeaders: Record<string, string> | undefined;
  if (config.provider === "openrouter") {
    const siteUrl = process.env["OPENROUTER_SITE_URL"] ?? "";
    const siteName = process.env["OPENROUTER_SITE_NAME"] ?? "";
    if (siteUrl || siteName) {
      extraHeaders = {};
      if (siteUrl) extraHeaders["HTTP-Referer"] = siteUrl;
      if (siteName) extraHeaders["X-Title"] = siteName;
    }
  }

  const chatOptions: LlmCallOptions = {
    temperature: finalTemperature,
    max_tokens: finalMaxTokens,
    ...options,
    extra_headers: extraHeaders,
    extra_params: extraParams,
  };
  if (timeout !== undefined) {
    chatOptions.timeout = timeout;
  }
  return chat(prompt, config.api_url, config.api_key, config.model_name, chatOptions);
}

// ============================================================
// Utility functions
// ============================================================

/**
 * List all available model aliases in stable alphabetical order.
 */
export function listModels(): string[] {
  return Object.keys(MODEL_MAPPINGS).sort();
}

/**
 * Return the currently active config for a model alias with the API key masked.
 *
 * This function returns error objects instead of throwing for malformed
 * multi-provider configs because it is mainly used for inspection/debugging.
 */
export function getModelInfo(
  modelAlias: string
): Record<string, unknown> | null {
  const entry = MODEL_MAPPINGS[modelAlias];
  if (entry === undefined) return null;

  let config: SingleModelConfig;

  if (Array.isArray(entry)) {
    const enabledConfigs = entry.filter((item) => item.enabled === true);

    if (enabledConfigs.length === 0) {
      return {
        error: "No enabled config",
        available_providers: entry.map((item) => item.provider ?? "unknown"),
        total_configs: entry.length,
      };
    }

    if (enabledConfigs.length > 1) {
      return {
        error: "Config error: multiple enabled configs",
        enabled_providers: enabledConfigs.map((item) => item.provider ?? "unknown"),
      };
    }

    config = { ...enabledConfigs[0]! } as SingleModelConfig;
  } else {
    config = { ...entry } as SingleModelConfig;
  }

  config.api_key = config.api_key ? "***" : "Not configured";
  return config as Record<string, unknown>;
}

/**
 * Add a model alias at runtime.
 *
 * The new config is stored only in memory. It is useful for tests and temporary
 * model registration, but it is not written back to models.yaml.
 */
export function addCustomModel(
  alias: string,
  provider: string,
  apiUrl: string,
  apiKey: string,
  modelName: string,
  temperature = 0.7,
  maxTokens = 2000,
  extras?: Partial<SingleModelConfig>
): void {
  MODEL_MAPPINGS[alias] = {
    provider,
    api_url: apiUrl,
    api_key: apiKey,
    model_name: modelName,
    temperature,
    max_tokens: maxTokens,
    ...extras,
  };
  logger.info(`Added custom model: ${alias}`);
}

/**
 * Return pricing metadata for a model alias.
 *
 * For the array shape, the currently enabled provider config is used. If the
 * config is ambiguous, this helper logs a warning and returns the first enabled
 * config's pricing to preserve the old non-throwing behavior.
 */
export function getModelPricingInfo(modelAlias: string): ModelPricing | null {
  const entry = MODEL_MAPPINGS[modelAlias];
  if (entry === undefined) return null;

  let config: SingleModelConfig;

  if (Array.isArray(entry)) {
    const enabledConfigs = entry.filter((item) => item.enabled === true);

    if (enabledConfigs.length === 0) {
      logger.warning(`Model '${modelAlias}' has no enabled config`);
      return null;
    }

    if (enabledConfigs.length > 1) {
      logger.warning(`Model '${modelAlias}' has multiple enabled configs; using the first one`);
    }

    config = enabledConfigs[0]!;
  } else {
    config = entry;
  }

  return config.pricing ?? null;
}

/**
 * Reload model mappings from models.yaml.
 *
 * This replaces all current mappings, including anything added by
 * addCustomModel().
 */
export function reloadModels(): void {
  MODEL_MAPPINGS = loadModelMappings();
  logger.info(`Model config reloaded; ${Object.keys(MODEL_MAPPINGS).length} models available`);
}
