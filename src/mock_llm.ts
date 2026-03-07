/**
 * Mock LLM 模块
 *
 * 提供模拟的 LLM 响应，无需真实 API 调用，不产生任何费用。
 * 主要用途：
 *   - 开发调试：快速验证工作流逻辑，无需等待 API 响应
 *   - 单元测试：确定性的输出，便于断言
 *   - CI/CD：无需配置 API 密钥即可运行集成测试
 *
 * 使用方式——在 models.yaml 中配置模型名以 "mock" 开头的模型：
 *
 *   mock-translate:
 *     provider: mock           # provider 可写可不写，模型名以 mock 开头会自动检测
 *     api_url: ""              # mock 模式不需要真实 URL
 *     api_key: "mock"          # mock 模式不需要真实密钥
 *     model_name: mock-translate
 *     mock_mappings:
 *       "请将以下文本翻译为英文：你好": '{"translation": "Hello"}'
 *       "请将以下文本翻译为英文：再见": '{"translation": "Goodbye"}'
 *
 * 匹配规则：
 *   - prompt 必须与 mock_mappings 中的某个 key **完全一致**才返回对应 value
 *   - 不匹配时直接抛出错误，方便排查提示词模板问题
 *
 * 不同场景使用不同的 mock 模型：
 *   mock-translate:  翻译场景的模拟响应
 *   mock-summary:    摘要场景的模拟响应
 *   mock-ocr:        图片识别场景的模拟响应
 */

// LlmResult 是 LLM 调用的返回值类型（content + usage），mock 也要返回相同结构
// UsageDict 是 token 用量统计类型
import { LlmResult, UsageDict } from "./llm_client.js";

/**
 * 简易日志器（与其他模块保持一致的设计）
 */
const logger = {
  info: (msg: string) => console.info(msg),
};

// ============================================================
// 类型定义
// ============================================================

/**
 * Mock 模型的配置（从 models.yaml 的 SingleModelConfig 中提取 mock 相关字段）
 *
 * mock_mappings: prompt → response 的精确映射表
 *   - 键（key）：完整的 prompt 文本（经过占位符替换后的最终文本）
 *   - 值（value）：对应的模拟响应文本
 *   - 类型 Record<string, string> 等价于 Python 的 dict[str, str]
 *
 * 示例：
 *   {
 *     "翻译：你好": '{"translation": "Hello"}',
 *     "翻译：再见": '{"translation": "Goodbye"}'
 *   }
 */
export interface MockConfig {
  mock_mappings: Record<string, string>;
}

// ============================================================
// 核心函数
// ============================================================

/**
 * 判断模型是否为 mock 模型
 *
 * 判断依据（满足任一即可）：
 *   1. 模型简称以 "mock" 开头（如 "mock-translate"、"mock_summary"）
 *   2. provider 字段为 "mock"
 *
 * 之所以支持两种判断方式，是因为：
 *   - 模型名前缀检测更方便（不用额外写 provider 字段）
 *   - provider 字段检测更明确（模型名不以 mock 开头时也能用）
 *
 * @param modelAlias 模型简称（models.yaml 中的键名）
 * @param provider   提供商名称（可选，从配置中读取）
 * @returns true 表示是 mock 模型，应走模拟路径
 */
export function isMockModel(modelAlias: string, provider?: string): boolean {
  return modelAlias.startsWith("mock") || provider === "mock";
}

/**
 * 生成模拟的 LLM 响应（本模块的核心对外接口）
 *
 * 在 mock_mappings 中查找与 prompt 完全一致的 key：
 *   - 找到 → 返回对应的 value 作为响应
 *   - 找不到 → 抛出错误，列出所有可用的 key 帮助排查
 *
 * 返回值与真实 LLM 调用完全相同的 LlmResult 结构，
 * 上层代码（model_caller.ts、llm_actions.ts）无需区分 mock 与真实调用。
 *
 * @param prompt      用户输入的提示文本（经过占位符替换后的最终文本）
 * @param config      mock 配置（包含 mock_mappings 映射表）
 * @param modelAlias  模型简称（用于错误消息）
 * @returns LlmResult，包含 content（模拟回复）和 usage（估算的 token 用量）
 * @throws Error prompt 在 mock_mappings 中找不到匹配时抛出
 */
export function mockLlmCall(
  prompt: string,
  config: MockConfig,
  modelAlias: string
): LlmResult {
  const mappings = config.mock_mappings;

  // 第一步：检查 mock_mappings 是否已配置
  if (!mappings || Object.keys(mappings).length === 0) {
    throw new Error(
      `[Mock] 模型 '${modelAlias}' 未配置 mock_mappings\n` +
        `请在 models.yaml 中添加 mock_mappings 字段，示例：\n` +
        `  ${modelAlias}:\n` +
        `    provider: mock\n` +
        `    api_url: ""\n` +
        `    api_key: "mock"\n` +
        `    model_name: ${modelAlias}\n` +
        `    mock_mappings:\n` +
        `      "你的prompt文本": "期望的响应"`
    );
  }

  // 第二步：精确匹配 prompt
  const content = mappings[prompt];

  if (content === undefined) {
    // 找不到匹配：列出所有可用的 key，帮助用户对比排查
    // 每个 key 截取前 80 个字符，避免日志过长
    const availableKeys = Object.keys(mappings)
      .map((k, i) => `  ${i + 1}. "${k.length > 80 ? k.slice(0, 80) + "..." : k}"`)
      .join("\n");

    // prompt 也截取前 200 个字符用于展示
    const promptPreview = prompt.length > 200 ? prompt.slice(0, 200) + "..." : prompt;

    throw new Error(
      `[Mock] 模型 '${modelAlias}' 找不到匹配的 prompt\n\n` +
        `【收到的 prompt】\n  "${promptPreview}"\n\n` +
        `【mock_mappings 中可用的 key】\n${availableKeys}\n\n` +
        `提示：mock 模式要求 prompt 与 key 完全一致（包括空格和换行）`
    );
  }

  logger.info(`[Mock] ${modelAlias} 命中映射，返回模拟响应 (${content.length} 字符)`);

  // 第三步：构造 token 用量估算
  // mock 模式下没有真实的 token 消耗，但上层代码（成本计算、日志）需要 usage 字段
  // 使用简单的字符数估算：每 2 个字符约 1 个 token（中英文折中值）
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
