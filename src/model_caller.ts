/**
 * 模型调用映射模块
 *
 * 本模块在 llm_client.ts（底层 HTTP 调用）之上提供了一层"简称映射"抽象：
 *   - 用户只需传入模型简称（如 "gpt4"、"kimi"），无需关心 API URL、密钥、模型全名等细节
 *   - 所有模型的连接信息集中存储在项目根目录的 models.yaml 中
 *   - api_key 字段支持 ${ENV_VAR} 语法，运行时自动替换为环境变量的值（密钥不落地）
 *
 * 调用链路：
 *   callModel("gpt4", "你好")
 *     → 从 MODEL_MAPPINGS 查找 "gpt4" 对应的配置
 *     → 调用 llm_client.chat(prompt, apiUrl, apiKey, modelName, options)
 *       → 调用 llm_client.callLlmApi(...)
 *         → fetch(apiUrl, ...)
 *
 * models.yaml 支持两种配置格式：
 *   1. 字典格式（单一配置）：一个模型简称对应一个固定的 API 提供商
 *   2. 列表格式（多配置）：一个模型简称对应多个提供商，通过 enabled: true 选择当前使用哪个
 *      这种设计方便在不同提供商之间快速切换（如从 OpenAI 切到 Azure），只需改 enabled 字段
 */

// fs 是 Node.js 内置的文件系统模块，用于读取 models.yaml 配置文件
import * as fs from "fs";
// path 是 Node.js 内置的路径处理模块，用于拼接路径、获取目录名
import * as path from "path";
// js-yaml 是第三方 YAML 解析库，将 YAML 文本解析为 JavaScript 对象
// YAML 比 JSON 更适合做配置文件（支持注释、更易读）
import * as yaml from "js-yaml";
// fileURLToPath 将 ESM 模块的 import.meta.url（file:///...格式）转为普通文件路径
// ESM 模块没有 __dirname，需要用这个方法获取当前文件所在目录
import { fileURLToPath } from "url";
// chat 是 llm_client.ts 提供的简化调用接口，接收 prompt 和连接参数，返回 LlmResult
// LlmResult 包含 content（AI 回复文本）和 usage（token 用量）
import { chat, LlmResult } from "./llm_client.js";

/**
 * 简易日志器（与 llm_client.ts 相同的设计理由：保持依赖最小化）
 */
const logger = {
  info: (msg: string) => console.info(msg),
  warning: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
};

// ============================================================
// 类型定义
// ============================================================

/**
 * 模型价格信息
 *
 * 用于成本计算（cost_calculator.ts 会使用这些价格来计算每次调用的花费）
 *
 * input:    输入 token 的单价（每百万 token 的价格）
 * output:   输出 token 的单价（每百万 token 的价格）
 * currency: 货币单位，如 "USD"、"CNY"
 *
 * 示例（GPT-4o）：
 *   { input: 2.5, output: 10.0, currency: "USD" }
 *   表示：输入 $2.5/百万token，输出 $10.0/百万token
 */
export interface ModelPricing {
  input: number;
  output: number;
  currency: string;
}

/**
 * 单个模型的完整配置
 *
 * 对应 models.yaml 中一个提供商的配置块。
 *
 * enabled?:      是否启用（仅在列表格式中有意义，字典格式默认启用）
 * provider:      提供商名称，如 "openai"、"azure"、"openrouter"、"kimi"
 * api_url:       API 端点 URL，如 "https://api.openai.com/v1/chat/completions"
 * api_key:       API 密钥，支持 ${ENV_VAR} 占位符（如 "${OPENAI_API_KEY}"）
 * model_name:    模型全名，如 "gpt-4o"、"moonshot-v1-8k"
 * temperature?:  默认温度（可被 callModel 的参数覆盖）
 * max_tokens?:   默认最大 token 数（可被 callModel 的参数覆盖）
 * extra_params?: 额外的 API 请求参数（如思考模式开关），透传给 llm_client
 *                类型 Record<string, unknown> 等价于 Python 的 dict[str, Any]
 * pricing?:      价格信息，用于成本计算
 * [key: string]: unknown — 允许携带任意额外字段（前向兼容）
 *
 * models.yaml 示例：
 *   gpt4:
 *     provider: openai
 *     api_url: https://api.openai.com/v1/chat/completions
 *     api_key: ${OPENAI_API_KEY}
 *     model_name: gpt-4o
 *     temperature: 0.7
 *     pricing:
 *       input: 2.5
 *       output: 10.0
 *       currency: USD
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
 * 模型配置条目：单配置（字典格式）或多配置（列表格式）
 *
 * 字典格式示例（直接是一个 SingleModelConfig）：
 *   gpt4:
 *     provider: openai
 *     api_url: ...
 *
 * 列表格式示例（数组中每个元素是一个 SingleModelConfig）：
 *   gpt4:
 *     - provider: openai
 *       enabled: true
 *       api_url: ...
 *     - provider: azure
 *       enabled: false
 *       api_url: ...
 */
export type ModelConfigEntry = SingleModelConfig | SingleModelConfig[];

/**
 * 全部模型配置的集合
 *
 * 键是模型简称（如 "gpt4"），值是该模型的配置条目
 * Record<string, ModelConfigEntry> 等价于 Python 的 dict[str, ModelConfigEntry]
 */
export type ModelMappings = Record<string, ModelConfigEntry>;

// ============================================================
// 从 models.yaml 加载模型配置
// ============================================================

/**
 * 递归解析字符串中的 ${ENV_VAR} 占位符，替换为对应的环境变量值
 *
 * 这个函数是递归的——它会遍历嵌套的对象和数组，替换所有层级中的占位符。
 *
 * 处理规则：
 *   - string 类型：查找并替换所有 ${...} 占位符
 *   - Array 类型：递归处理每个元素
 *   - Object 类型：递归处理每个值（键不替换）
 *   - 其他类型（number、boolean 等）：原样返回
 *
 * 示例：
 *   输入："Bearer ${API_KEY}"（假设环境变量 API_KEY="sk-abc123"）
 *   输出："Bearer sk-abc123"
 *
 *   输入：{ api_key: "${KEY}", retries: 3 }
 *   输出：{ api_key: "实际密钥值", retries: 3 }
 *
 * @param value 任意类型的值，可能包含 ${ENV_VAR} 占位符
 * @returns 替换后的值，类型与输入相同
 */
function resolveEnvPlaceholders(value: unknown): unknown {
  if (typeof value === "string") {
    // 正则 /\$\{(\w+)\}/g 匹配 ${变量名} 格式的占位符
    //   \$\{  — 匹配字面量 "${" （$ 和 { 都是正则特殊字符，需要转义）
    //   (\w+) — 捕获组，匹配一个或多个"单词字符"（字母、数字、下划线）作为变量名
    //   \}    — 匹配字面量 "}"
    //   g     — 全局匹配，替换字符串中所有出现的占位符
    // replace 的回调参数：_ 是完整匹配（如 "${API_KEY}"），name 是捕获组（如 "API_KEY"）
    // process.env[name] 从环境变量中读取值，?? "" 在变量未设置时返回空字符串
    return value.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? "");
  }
  if (Array.isArray(value)) {
    // 数组：对每个元素递归调用自身
    return value.map(resolveEnvPlaceholders);
  }
  if (value !== null && typeof value === "object") {
    // 对象：对每个值递归调用自身（键保持不变）
    // Object.entries 将对象转为 [key, value] 数组
    // Object.fromEntries 将 [key, value] 数组转回对象
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveEnvPlaceholders(v)])
    );
  }
  // number、boolean、null 等类型：原样返回
  return value;
}

/**
 * 查找 models.yaml 文件的路径
 *
 * 查找策略（按优先级）：
 *   1. 环境变量 MODELS_YAML_PATH（如果设置了，直接使用）
 *   2. 从当前文件位置向上推导项目根目录，拼接 models.yaml
 *
 * 之所以需要特殊处理，是因为 ESM 模块没有 __dirname 变量（CommonJS 才有），
 * 需要通过 import.meta.url → fileURLToPath → path.dirname 来获取当前目录。
 *
 * @returns models.yaml 的绝对路径
 */
function findModelsYaml(): string {
  // 优先使用环境变量指定的路径（方便测试和部署时覆盖）
  if (process.env["MODELS_YAML_PATH"]) return process.env["MODELS_YAML_PATH"];

  // import.meta.url 返回当前文件的 URL 格式路径，如 "file:///D:/project/src/model_caller.ts"
  // fileURLToPath 将其转为普通路径，如 "D:/project/src/model_caller.ts"
  // path.dirname 取目录部分，如 "D:/project/src"
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  // 当前文件在 src/ 目录下，向上一级就是项目根目录
  const projectRoot = path.resolve(currentDir, "..");
  return path.join(projectRoot, "models.yaml");
}

/**
 * 从 models.yaml 加载并解析模型配置
 *
 * 完整流程：
 *   1. 定位 models.yaml 文件
 *   2. 读取文件内容并用 js-yaml 解析为 JavaScript 对象
 *   3. 递归替换所有 ${ENV_VAR} 占位符为实际环境变量值
 *
 * @returns 解析后的模型配置映射表
 * @throws Error 文件不存在或格式错误
 */
function loadModelMappings(): ModelMappings {
  const yamlPath = findModelsYaml();

  // 检查文件是否存在，不存在时抛出友好的错误提示
  if (!fs.existsSync(yamlPath)) {
    throw new Error(
      `找不到模型配置文件: ${yamlPath}\n` +
      `请在项目根目录创建 models.yaml，或通过环境变量 MODELS_YAML_PATH 指定路径。`
    );
  }

  // yaml.load 将 YAML 文本解析为 JavaScript 对象
  // fs.readFileSync 同步读取文件（启动时只执行一次，同步不会阻塞）
  const raw = yaml.load(fs.readFileSync(yamlPath, "utf-8"));
  // 校验顶层结构：必须是对象（键值对），不能是数组或标量
  if (!raw || typeof raw !== "object") {
    throw new Error(`models.yaml 格式错误：顶层应为键值对象`);
  }

  // 替换所有 ${ENV_VAR} 占位符为实际的环境变量值
  return resolveEnvPlaceholders(raw) as ModelMappings;
}

/**
 * 全局模型配置映射表
 *
 * 模块加载时自动从 models.yaml 读取并初始化。
 * 使用 let（而非 const）是因为 reloadModels() 需要重新赋值实现热重载。
 *
 * 使用示例：
 *   MODEL_MAPPINGS["gpt4"]  → 获取 gpt4 的配置
 *   Object.keys(MODEL_MAPPINGS)  → 获取所有可用的模型简称
 */
export let MODEL_MAPPINGS: ModelMappings = loadModelMappings();

// ============================================================
// 内部辅助
// ============================================================

/**
 * 验证模型配置中的必需字段是否齐全
 *
 * 必需字段：provider、api_url、api_key、model_name
 * 任何缺失都会抛出错误，提示用户检查 models.yaml。
 *
 * Partial<SingleModelConfig> 表示所有字段都变为可选的——
 * 因为在验证之前我们不能保证字段一定存在，所以用 Partial 表达"可能不完整"的状态。
 *
 * @param config       待验证的配置对象
 * @param modelAlias   模型简称（用于错误消息）
 * @param providerName 提供商名称（用于错误消息）
 * @throws Error 缺少必需字段时抛出
 */
function validateConfigFields(
  config: Partial<SingleModelConfig>,
  modelAlias: string,
  providerName: string
): void {
  // 定义必需字段列表
  // keyof SingleModelConfig 是 TypeScript 的类型操作符，限制数组元素只能是接口中定义的字段名
  const requiredFields: (keyof SingleModelConfig)[] = ["provider", "api_url", "model_name"];
  // filter 过滤出值为 falsy（undefined、空字符串等）的字段名
  const missing = requiredFields.filter((f) => !config[f]);

  // api_key 单独检查：因为空字符串 "" 也是 falsy 但 "in" 操作符检查的是键是否存在
  // 配置中可能写了 api_key: ""（环境变量未设置时），这时 !config["api_key"] 为 true
  // 但我们用 "in" 检查是因为 api_key 允许为空字符串（resolveEnvPlaceholders 替换失败时）
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

/**
 * 从 ModelConfigEntry（可能是单配置或多配置列表）中解析出当前启用的配置
 *
 * 处理两种格式：
 *
 * 1. 列表格式 —— 筛选 enabled: true 的条目
 *    要求有且仅有一个 enabled: true，否则报错。
 *    示例：
 *      entry = [
 *        { provider: "openai",  enabled: false, ... },
 *        { provider: "azure",   enabled: true,  ... },  ← 选中这个
 *        { provider: "kimi",    enabled: false, ... },
 *      ]
 *
 * 2. 字典格式 —— 直接使用，无需选择
 *    示例：
 *      entry = { provider: "openai", api_url: "...", ... }
 *
 * @param entry      模型配置条目（从 MODEL_MAPPINGS 中获取）
 * @param modelAlias 模型简称（用于错误消息）
 * @returns 解析后的单个模型配置
 * @throws Error enabled 字段类型错误、没有启用的配置、或有多个启用的配置
 */
function resolveConfig(entry: ModelConfigEntry, modelAlias: string): SingleModelConfig {
  // ========== 处理多配置格式（列表） ==========
  if (Array.isArray(entry)) {
    // 第一步：验证 enabled 字段的类型必须是布尔值
    // 防止用户在 YAML 中写成 enabled: "true"（字符串）或 enabled: 1（数字）
    // 在 YAML 中 true/false 会自动解析为布尔值，但加引号 "true" 会变成字符串
    for (const item of entry) {
      if ("enabled" in item && typeof item.enabled !== "boolean") {
        throw new Error(
          `配置错误：模型 '${modelAlias}' 的 'enabled' 字段必须是布尔值 (true/false)。\n` +
            `提供商 '${item.provider ?? "unknown"}' 的 'enabled' 值为: ${JSON.stringify(item.enabled)} (${typeof item.enabled})\n` +
            `请修改为 true 或 false`
        );
      }
    }

    // 第二步：筛选出 enabled: true 的配置
    const enabledConfigs = entry.filter((item) => item.enabled === true);

    // 第三步：确保有且仅有一个启用的配置
    if (enabledConfigs.length === 0) {
      // 没有启用的配置 → 列出可用提供商，引导用户修改
      const providers = entry.map((item) => item.provider ?? "unknown");
      throw new Error(
        `模型 '${modelAlias}' 没有启用的配置。\n` +
          `可用提供商: ${providers.join(", ")}\n` +
          `请在 MODEL_MAPPINGS 中将某个配置的 'enabled' 设为 true`
      );
    }

    if (enabledConfigs.length > 1) {
      // 多个启用的配置 → 歧义，必须只保留一个
      const providers = enabledConfigs.map((item) => item.provider ?? "unknown");
      throw new Error(
        `配置错误：模型 '${modelAlias}' 有多个启用的配置！\n` +
          `同时启用的提供商: ${providers.join(", ")}\n` +
          `请确保只有一个配置的 'enabled' 为 true`
      );
    }

    // 展开运算符 {...} 创建浅拷贝，避免修改原始配置（后续 callModel 中可能修改 config）
    // enabledConfigs[0]! 中的 ! 是非空断言：上面已确认 length === 1，所以 [0] 一定存在
    // as SingleModelConfig：展开后 TypeScript 推断所有必填字段变为可选，需要手动恢复类型
    const config = { ...enabledConfigs[0]! } as SingleModelConfig;
    // 验证选中的配置是否包含所有必需字段
    validateConfigFields(config, modelAlias, config.provider ?? "unknown");
    return config;
  }

  // ========== 处理字典格式（单一配置） ==========
  // 直接浅拷贝并验证
  const config = { ...entry };
  validateConfigFields(config, modelAlias, config.provider ?? "unknown");
  return config;
}

// ============================================================
// 核心调用函数
// ============================================================

/**
 * 通过模型简称调用 AI 模型（本模块的核心对外接口）
 *
 * 完整流程：
 *   1. 在 MODEL_MAPPINGS 中查找模型简称对应的配置
 *   2. 解析配置（处理多配置列表的 enabled 选择）
 *   3. 检查 API 密钥是否已配置
 *   4. 合并默认参数和调用方覆盖参数
 *   5. 处理特定提供商的特殊逻辑（如 OpenRouter 的额外 headers）
 *   6. 调用 llm_client.chat() 发起实际的 API 请求
 *
 * 使用示例：
 *   const result = await callModel("gpt4", "请解释量子计算");
 *   console.log(result.content);  // AI 的回复文本
 *   console.log(result.usage);    // token 用量统计
 *
 * 参数覆盖优先级（高 → 低）：
 *   callModel 的 temperature/maxTokens 参数 → models.yaml 中的配置值 → 默认值(0.7/2000)
 *
 * @param modelAlias  模型简称，如 "gpt4"、"kimi"、"claude"
 * @param prompt      用户输入的提示文本
 * @param temperature 温度参数（可选，覆盖 models.yaml 中的默认值）
 * @param maxTokens   最大生成 token 数（可选，覆盖 models.yaml 中的默认值）
 * @returns LlmResult 包含 content（回复文本）和 usage（token 用量）
 * @throws Error 模型简称不存在、配置错误、密钥缺失、或 API 调用失败
 */
export async function callModel(
  modelAlias: string,
  prompt: string,
  temperature?: number,
  maxTokens?: number
): Promise<LlmResult> {
  // 第一步：查找模型配置
  const entry = MODEL_MAPPINGS[modelAlias];
  if (entry === undefined) {
    // 模型简称不存在，列出所有可用简称帮助用户排查
    const availableModels = Object.keys(MODEL_MAPPINGS).join(", ");
    throw new Error(
      `未知的模型简称: '${modelAlias}'\n可用的模型: ${availableModels}`
    );
  }

  // 第二步：解析出当前启用的配置（处理单配置/多配置列表）
  const config = resolveConfig(entry, modelAlias);

  // 第三步：检查 API 密钥
  // 密钥可能为空的原因：${ENV_VAR} 占位符对应的环境变量未设置，替换结果为空字符串
  if (!config.api_key || config.api_key.trim() === "") {
    throw new Error(
      `模型 '${modelAlias}' 的API密钥未配置或为空。\n` +
        `提供商: ${config.provider}\n` +
        `请在 .env 文件中设置对应的环境变量。`
    );
  }

  // 第四步：合并参数（调用方参数 → 配置文件参数 → 硬编码默认值）
  // ?? 是空值合并运算符：左侧为 null 或 undefined 时使用右侧的值
  const finalTemperature = temperature ?? config.temperature ?? 0.7;
  const finalMaxTokens = maxTokens ?? config.max_tokens ?? 2000;
  // 额外 API 参数（如思考模式开关），如果配置中未定义则为空对象
  const extraParams = config.extra_params ?? {};

  logger.info(`调用模型: ${modelAlias} (${config.provider} / ${config.model_name})`);

  // 第五步：处理 OpenRouter 特有的 HTTP 请求头
  // OpenRouter 是一个 API 聚合平台，它要求请求中携带来源信息：
  //   HTTP-Referer: 调用方的网站 URL（用于流量来源统计）
  //   X-Title:      调用方的应用名称（显示在 OpenRouter 仪表盘中）
  // 这些信息从环境变量读取，如果未设置则不添加
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

  // 第六步：调用 llm_client.chat() 发起请求
  // chat() 内部会调用 callLlmApi()，成功返回 LlmResult，失败抛出异常
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
 * 列出所有可用的模型简称（按字母排序）
 *
 * 使用示例：
 *   listModels()  → ["claude", "gpt4", "kimi"]
 *
 * @returns 模型简称数组
 */
export function listModels(): string[] {
  return Object.keys(MODEL_MAPPINGS).sort();
}

/**
 * 获取指定模型的详细信息（API 密钥已脱敏处理）
 *
 * 返回该模型当前启用的完整配置，但 api_key 会被替换为 "***"（安全考虑）。
 * 对于多配置格式，自动解析并返回 enabled: true 的那个配置。
 *
 * 使用示例：
 *   getModelInfo("gpt4")
 *   → { provider: "openai", api_url: "...", api_key: "***", model_name: "gpt-4o", ... }
 *
 * @param modelAlias 模型简称
 * @returns 脱敏后的配置对象，或 null（模型不存在时）
 *          配置异常时返回 { error: "...", ... } 描述错误原因
 */
export function getModelInfo(
  modelAlias: string
): Record<string, unknown> | null {
  const entry = MODEL_MAPPINGS[modelAlias];
  if (entry === undefined) return null;

  let config: SingleModelConfig;

  if (Array.isArray(entry)) {
    // 多配置格式：筛选 enabled: true 的条目
    const enabledConfigs = entry.filter((item) => item.enabled === true);

    if (enabledConfigs.length === 0) {
      // 没有启用的配置，返回错误信息而非抛出异常（info 查询不应中断程序）
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
    // 字典格式：直接使用
    config = { ...entry } as SingleModelConfig;
  }

  // 脱敏处理：将 API 密钥替换为 "***"，防止日志或调试信息中泄露密钥
  config.api_key = config.api_key ? "***" : "未配置";
  return config as Record<string, unknown>;
}

/**
 * 动态添加自定义模型配置（运行时注册）
 *
 * 直接修改内存中的 MODEL_MAPPINGS，不会写入 models.yaml 文件。
 * 适用于测试场景或需要临时添加模型的情况。
 *
 * 使用示例：
 *   addCustomModel("my-model", "openai", "https://api.openai.com/v1/chat/completions",
 *                  "sk-xxx", "gpt-4o-mini", 0.5, 4000);
 *   await callModel("my-model", "你好");  // 现在可以用 "my-model" 调用了
 *
 * @param alias       模型简称（用于后续调用）
 * @param provider    提供商名称
 * @param apiUrl      API 端点 URL
 * @param apiKey      API 密钥
 * @param modelName   模型全名
 * @param temperature 默认温度，默认 0.7
 * @param maxTokens   默认最大 token 数，默认 2000
 * @param extras      其他额外配置字段（如 pricing、extra_params 等）
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
  // 直接写入 MODEL_MAPPINGS 对象（字典格式，无需 enabled 字段）
  // ...extras 展开运算符将额外字段合并到配置中
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
 * 用于 cost_calculator.ts 计算每次 API 调用的花费。
 * 对于多配置格式，返回当前启用配置的价格。
 *
 * 使用示例：
 *   getModelPricingInfo("gpt4")
 *   → { input: 2.5, output: 10.0, currency: "USD" }
 *
 * @param modelAlias 模型简称
 * @returns ModelPricing 价格信息，或 null（模型不存在或未配置价格时）
 */
export function getModelPricingInfo(modelAlias: string): ModelPricing | null {
  const entry = MODEL_MAPPINGS[modelAlias];
  if (entry === undefined) return null;

  let config: SingleModelConfig;

  if (Array.isArray(entry)) {
    // 多配置格式：筛选启用的配置
    const enabledConfigs = entry.filter((item) => item.enabled === true);

    if (enabledConfigs.length === 0) {
      logger.warning(`模型 '${modelAlias}' 没有启用的配置`);
      return null;
    }

    if (enabledConfigs.length > 1) {
      // 有多个启用的配置时，使用第一个（这里不报错，只是查询价格）
      logger.warning(`模型 '${modelAlias}' 有多个启用的配置，使用第一个`);
    }

    config = enabledConfigs[0]!; // length 已确认 ≥ 1，! 非空断言安全
  } else {
    config = entry;
  }

  // 返回价格信息，如果配置中没有 pricing 字段则返回 null
  // ?? 空值合并：pricing 为 undefined 时返回 null
  return config.pricing ?? null;
}

/**
 * 重新从 models.yaml 加载模型配置（热重载）
 *
 * 修改 models.yaml 后调用此函数即可生效，无需重启进程。
 * 会完全覆盖当前的 MODEL_MAPPINGS（包括通过 addCustomModel 动态添加的配置）。
 *
 * 使用场景：
 *   - 运行时修改了 models.yaml（如切换提供商、更新密钥）
 *   - 管理后台提供"重载配置"按钮
 */
export function reloadModels(): void {
  // 重新执行 loadModelMappings()，覆盖全局变量
  MODEL_MAPPINGS = loadModelMappings();
  logger.info(`模型配置已重新加载，共 ${Object.keys(MODEL_MAPPINGS).length} 个模型`);
}
