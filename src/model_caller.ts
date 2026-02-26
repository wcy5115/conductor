/**
 * 模型调用映射模块
 * 提供简化的模型调用接口，将模型简称映射到具体的API调用参数
 *
 * 模型配置从项目根目录的 models.yaml 动态加载，修改 YAML 后重启即可生效，无需重编译。
 * api_key 字段支持 ${ENV_VAR} 语法，程序启动时自动替换为对应环境变量的值。
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { fileURLToPath } from "url";
import { chat, LlmResult } from "./llm_client.js";

const logger = {
  info: (msg: string) => console.info(msg),
  warning: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
};

// ============================================================
// 类型定义
// ============================================================

export interface ModelPricing {
  input: number;
  output: number;
  currency: string;
}

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

/** 单配置（字典格式）或多配置（列表格式，通过 enabled 字段选择） */
export type ModelConfigEntry = SingleModelConfig | SingleModelConfig[];

export type ModelMappings = Record<string, ModelConfigEntry>;

// ============================================================
// 从 models.yaml 加载模型配置
// ============================================================

/**
 * 解析字符串中的 ${ENV_VAR} 占位符，替换为对应的环境变量值。
 * 变量未设置时替换为空字符串。
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

/** 查找 models.yaml：优先用环境变量 MODELS_YAML_PATH，否则从当前文件向上找到项目根目录 */
function findModelsYaml(): string {
  if (process.env["MODELS_YAML_PATH"]) return process.env["MODELS_YAML_PATH"];

  // ESM 环境下用 import.meta.url 定位当前文件，再往上找项目根
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  // src/ 的上一级即项目根
  const projectRoot = path.resolve(currentDir, "..");
  return path.join(projectRoot, "models.yaml");
}

function loadModelMappings(): ModelMappings {
  const yamlPath = findModelsYaml();

  if (!fs.existsSync(yamlPath)) {
    throw new Error(
      `找不到模型配置文件: ${yamlPath}\n` +
      `请在项目根目录创建 models.yaml，或通过环境变量 MODELS_YAML_PATH 指定路径。`
    );
  }

  const raw = yaml.load(fs.readFileSync(yamlPath, "utf-8"));
  if (!raw || typeof raw !== "object") {
    throw new Error(`models.yaml 格式错误：顶层应为键值对象`);
  }

  // 替换所有 ${ENV_VAR} 占位符
  return resolveEnvPlaceholders(raw) as ModelMappings;
}

export let MODEL_MAPPINGS: ModelMappings = loadModelMappings();

// ============================================================
// 内部辅助
// ============================================================

/** 验证配置的必需字段，缺失时抛出 ValueError */
function validateConfigFields(
  config: Partial<SingleModelConfig>,
  modelAlias: string,
  providerName: string
): void {
  const requiredFields: (keyof SingleModelConfig)[] = ["provider", "api_url", "model_name"];
  const missing = requiredFields.filter((f) => !config[f]);

  if (!("api_key" in config)) {
    missing.push("api_key");
  }

  if (missing.length > 0) {
    throw new Error(
      `模型 '${modelAlias}' 的配置无效。\n` +
        `缺少必需字段: ${missing.join(", ")}\n` +
        `提供商: ${providerName}`
    );
  }
}

/** 从 ModelConfigEntry（单配置或多配置列表）中解析出当前启用的配置 */
function resolveConfig(entry: ModelConfigEntry, modelAlias: string): SingleModelConfig {
  // ========== 处理多配置格式（列表） ==========
  if (Array.isArray(entry)) {
    // 验证 enabled 字段类型
    for (const item of entry) {
      if ("enabled" in item && typeof item.enabled !== "boolean") {
        throw new Error(
          `配置错误：模型 '${modelAlias}' 的 'enabled' 字段必须是布尔值 (true/false)。\n` +
            `提供商 '${item.provider ?? "unknown"}' 的 'enabled' 值为: ${JSON.stringify(item.enabled)} (${typeof item.enabled})\n` +
            `请修改为 true 或 false`
        );
      }
    }

    const enabledConfigs = entry.filter((item) => item.enabled === true);

    if (enabledConfigs.length === 0) {
      const providers = entry.map((item) => item.provider ?? "unknown");
      throw new Error(
        `模型 '${modelAlias}' 没有启用的配置。\n` +
          `可用提供商: ${providers.join(", ")}\n` +
          `请在 MODEL_MAPPINGS 中将某个配置的 'enabled' 设为 true`
      );
    }

    if (enabledConfigs.length > 1) {
      const providers = enabledConfigs.map((item) => item.provider ?? "unknown");
      throw new Error(
        `配置错误：模型 '${modelAlias}' 有多个启用的配置！\n` +
          `同时启用的提供商: ${providers.join(", ")}\n` +
          `请确保只有一个配置的 'enabled' 为 true`
      );
    }

    // enabledConfigs[0]!: 此处 length 已确认为 1，! 安全；as SingleModelConfig：展开对象导致必填字段变 optional，手动恢复类型
    const config = { ...enabledConfigs[0]! } as SingleModelConfig;
    validateConfigFields(config, modelAlias, config.provider ?? "unknown");
    return config;
  }

  // ========== 处理字典格式（单一配置） ==========
  const config = { ...entry };
  validateConfigFields(config, modelAlias, config.provider ?? "unknown");
  return config;
}

// ============================================================
// 核心调用函数
// ============================================================

/**
 * 通过模型简称调用AI模型
 *
 * 支持两种配置格式：
 * 1. 字典格式（单一配置）
 * 2. 列表格式（多配置，通过 enabled 字段选择）
 *
 * @param modelAlias 模型简称（如 "gpt4", "kimi" 等）
 * @param prompt 用户输入/提示词
 * @param temperature 温度参数（可选，覆盖默认值）
 * @param maxTokens 最大token数（可选，覆盖默认值）
 * @returns 包含 content 和 usage 的结果对象
 * @throws Error 模型不存在、配置错误或API调用失败
 */
export async function callModel(
  modelAlias: string,
  prompt: string,
  temperature?: number,
  maxTokens?: number
): Promise<LlmResult> {
  // 查找模型配置
  const entry = MODEL_MAPPINGS[modelAlias];
  if (entry === undefined) {
    const availableModels = Object.keys(MODEL_MAPPINGS).join(", ");
    throw new Error(
      `未知的模型简称: '${modelAlias}'\n可用的模型: ${availableModels}`
    );
  }

  // 解析启用的配置
  const config = resolveConfig(entry, modelAlias);

  // 检查 API 密钥
  if (!config.api_key || config.api_key.trim() === "") {
    throw new Error(
      `模型 '${modelAlias}' 的API密钥未配置或为空。\n` +
        `提供商: ${config.provider}\n` +
        `请在 .env 文件中设置对应的环境变量。`
    );
  }

  // 覆盖参数
  const finalTemperature = temperature ?? config.temperature ?? 0.7;
  const finalMaxTokens = maxTokens ?? config.max_tokens ?? 2000;
  const extraParams = config.extra_params ?? {};

  logger.info(`调用模型: ${modelAlias} (${config.provider} / ${config.model_name})`);

  // OpenRouter 需要特殊的 headers
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

  return chat(prompt, config.api_url, config.api_key, config.model_name, {
    temperature: finalTemperature,
    max_tokens: finalMaxTokens,
    extra_headers: extraHeaders,
    extra_params: extraParams,
  });
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 列出所有可用的模型简称
 */
export function listModels(): string[] {
  return Object.keys(MODEL_MAPPINGS).sort();
}

/**
 * 获取指定模型的详细信息（API密钥已脱敏）
 *
 * 对于多配置格式，返回当前启用的配置信息
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
        error: "没有启用的配置",
        available_providers: entry.map((item) => item.provider ?? "unknown"),
        total_configs: entry.length,
      };
    }

    if (enabledConfigs.length > 1) {
      return {
        error: "配置错误：有多个启用的配置",
        enabled_providers: enabledConfigs.map((item) => item.provider ?? "unknown"),
      };
    }

    config = { ...enabledConfigs[0]! } as SingleModelConfig;
  } else {
    config = { ...entry } as SingleModelConfig;
  }

  // 隐藏 API 密钥
  config.api_key = config.api_key ? "***" : "未配置";
  return config as Record<string, unknown>;
}

/**
 * 动态添加自定义模型配置
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
  logger.info(`添加自定义模型: ${alias}`);
}

/**
 * 获取模型的价格配置信息
 *
 * 对于多配置格式，返回当前启用配置的价格
 */
export function getModelPricingInfo(modelAlias: string): ModelPricing | null {
  const entry = MODEL_MAPPINGS[modelAlias];
  if (entry === undefined) return null;

  let config: SingleModelConfig;

  if (Array.isArray(entry)) {
    const enabledConfigs = entry.filter((item) => item.enabled === true);

    if (enabledConfigs.length === 0) {
      logger.warning(`模型 '${modelAlias}' 没有启用的配置`);
      return null;
    }

    if (enabledConfigs.length > 1) {
      logger.warning(`模型 '${modelAlias}' 有多个启用的配置，使用第一个`);
    }

    config = enabledConfigs[0]!; // length 已确认 ≥ 1，! 安全
  } else {
    config = entry;
  }

  return config.pricing ?? null;
}

/**
 * 重新从 models.yaml 加载模型配置（热重载，无需重启进程）
 *
 * 修改 models.yaml 后调用此函数即可生效。
 */
export function reloadModels(): void {
  MODEL_MAPPINGS = loadModelMappings();
  logger.info(`模型配置已重新加载，共 ${Object.keys(MODEL_MAPPINGS).length} 个模型`);
}
