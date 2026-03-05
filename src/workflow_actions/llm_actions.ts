/**
 * LLM 调用动作模块
 *
 * 本模块包含两个与大语言模型（LLM）交互的动作类，是整个工作流系统中最核心的模块之一：
 *
 * 继承关系：BaseAction → LLMCallAction → ConditionalLLMAction
 *
 * 1. LLMCallAction —— 标准 LLM 调用动作
 *    调用指定模型处理输入并产生输出，支持：
 *    - 纯文本 / 多模态（自动识别图片路径，转为 Base64 发送）
 *    - JSON 格式验证与自动重试（验证失败后重新调用模型，并可增强提示词）
 *    - 三层验证体系：required_fields → json_rules → 自定义 validator
 *    - 累积 token 用量与成本统计（重试时自动累加）
 *    - 提供 protected resolveNextStep() 方法，供子类覆盖以实现动态路由
 *
 * 2. ConditionalLLMAction —— 条件 LLM 动作（继承自 LLMCallAction）
 *    复用父类全部能力，覆盖 resolveNextStep() 方法，
 *    将模型输出传给外部注入的条件函数，由函数返回值决定下一步走向（动态路由）
 *
 * 调用链路（以 LLMCallAction 为例）：
 *   WorkflowEngine 调用 action.run(context)         ← 继承自 BaseAction
 *     → run() 调用 this.execute(context)              ← 本模块实现
 *       → 纯文本模式：调用 callModel(model, prompt)   ← model_caller.ts
 *       → 多模态模式：调用 callLlmApi(messages, ...)   ← llm_client.ts
 *       → 验证 JSON → 失败则重试 → 计算成本
 *     → run() 注入 action_name / action_duration 到 metadata
 *     → 返回 StepResult
 */

// fs 是 Node.js 内置的文件系统模块
// 这里用 fs.existsSync() 检查多模态模式下图片文件是否存在
import fs from "fs";
// BaseAction 是所有动作的抽象基类（定义在 ./base.ts）
// 提供 run() 方法（计时、日志、错误处理），子类只需实现 execute()
import { BaseAction } from "./base.js";
// WorkflowContext 是工作流的全局上下文，context.data 是步骤间共享的数据字典
// StepResult 是步骤返回值，包含 nextStep（下一步ID）、data（产出数据）、metadata（元数据）
import { WorkflowContext, StepResult } from "../workflow_engine.js";
// callModel 是 model_caller.ts 提供的简化调用接口，传入模型简称即可调用
// MODEL_MAPPINGS 是模型简称到 API 配置的映射表（从 models.yaml 加载）
import { callModel, MODEL_MAPPINGS } from "../model_caller.js";
// callLlmApi 是 llm_client.ts 提供的底层 API 调用函数，支持多模态消息
// Message 是单条聊天消息的类型定义（role + content）
// LlmResult 是 API 调用成功时的返回值类型（content + usage）
import { callLlmApi, Message, LlmResult } from "../llm_client.js";
// calculateCost 根据模型名和 token 用量计算费用
// CostResult 是成本计算结果类型（包含 input_cost、output_cost、total_cost 等字段）
import { calculateCost, CostResult } from "../cost_calculator.js";
// validateAndCleanJson 从 LLM 响应文本中提取并解析 JSON
// 能自动剥离 Markdown 代码块标记（```json ... ```）、修复常见格式问题
import { validateAndCleanJson } from "../utils.js";
// LLMValidationError 是自定义异常类，在 JSON 验证最终失败时抛出
// 它携带了成本信息（costInfo）和 token 用量（usage），确保即使失败也不丢失计费数据
import { LLMValidationError } from "../exceptions.js";
// BaseValidator 是验证器的抽象基类，定义了 validate(data) 接口
import { BaseValidator } from "../validators/base.js";
// getValidator 是验证器工厂函数，根据名称（如 "simple_json"）创建对应的验证器实例
import { getValidator } from "../validators/index.js";

/**
 * 简易日志器
 *
 * 与 base.ts 相同的设计理由：保持依赖最小化，避免与 core/logging.ts 产生循环依赖。
 * 四个级别分别对应 console 的不同方法：
 *   - info:  一般信息（如模型调用成功、token 用量）
 *   - warn:  警告信息（如 JSON 验证失败但仍有重试机会）
 *   - error: 错误信息（如达到最大重试次数）
 *   - debug: 调试信息（如验证通过的确认）
 */
const logger = {
  info: (msg: string) => console.info(msg),
  warn: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
  debug: (msg: string) => console.debug(msg),
};

/**
 * JSON 字段类型检查映射表
 *
 * 用于 json_rules 验证中的类型约束检查。
 * 键是 YAML 配置中使用的类型名称，值是对应的类型检查函数。
 *
 * 支持的类型名称（含别名）：
 *   "string" / "str"     → typeof v === "string"
 *   "integer" / "int"    → typeof v === "number" && Number.isInteger(v)
 *   "number"             → typeof v === "number"（含浮点数）
 *   "boolean" / "bool"   → typeof v === "boolean"
 *   "array"              → Array.isArray(v)
 *   "object"             → 是对象、不是 null、不是数组
 *
 * 使用示例（YAML 配置）：
 *   json_rules:
 *     types:
 *       title: string      # title 字段必须是字符串
 *       page_num: integer   # page_num 字段必须是整数
 *       paragraphs: array   # paragraphs 字段必须是数组
 *
 * 注意：object 的检查排除了 null 和 Array，因为在 JavaScript 中
 * typeof null === "object" 且 typeof [] === "object"，这是语言的历史遗留问题
 */
const TYPE_CHECKERS: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  str: (v) => typeof v === "string",
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  int: (v) => typeof v === "number" && Number.isInteger(v),
  number: (v) => typeof v === "number",
  boolean: (v) => typeof v === "boolean",
  bool: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
};

// ============================================================
// LLMCallAction —— 标准 LLM 调用动作
// ============================================================

/**
 * LLM 调用动作
 *
 * 这是工作流中最常用的动作，核心职责是：
 *   1. 将提示词模板中的 {占位符} 替换为 context.data 中的实际值
 *   2. 调用指定的 LLM 模型
 *   3. 验证响应格式（可选的三层验证体系）
 *   4. 验证失败时自动重试（重新调用模型）
 *   5. 累积统计所有重试的 token 用量和成本
 *
 * 三层验证体系（逐层递进，后面的层可依赖前面的层已通过）：
 *   第一层 required_fields: 检查指定字段是否存在且非空
 *     示例配置：required_fields: ["title", "content", "page_num"]
 *
 *   第二层 json_rules: 检查字段存在性 + 类型约束
 *     示例配置：
 *       json_rules:
 *         required: ["title", "paragraphs"]
 *         types:
 *           title: string
 *           page_num: integer
 *           paragraphs: array
 *
 *   第三层 validator: 使用自定义验证器做业务逻辑级别的深度验证
 *     示例配置：
 *       validator: simple_json
 *       validator_config:
 *         strict_mode: true
 *
 * 多模态支持：
 *   当 context.data["item"] 的值是图片文件路径（以 .jpg/.png 等结尾）时，
 *   自动切换到多模态模式——将图片转为 Base64 与文本一起发送给 API。
 *   此模式常用于"图片转文字"场景（如 OCR、图表描述）。
 */
export class LLMCallAction extends BaseAction {
  /** 模型简称，对应 models.yaml 中的键名，如 "gpt4"、"kimi" */
  readonly model: string;
  /**
   * 提示词模板，支持 {key} 占位符语法
   * 执行时会用 context.data 中的同名值替换
   * 示例："请将以下文本翻译为英文：\n{text}"
   */
  readonly promptTemplate: string;
  /**
   * 输出键名——模型响应存入 context.data 时使用的键
   * 默认值为 "output"，即 context.data["output"] = 模型响应
   * 可自定义，如 "translation"、"summary" 等
   */
  readonly outputKey: string;
  /** 下一步的 ID，默认 "END" 表示流程结束 */
  readonly nextStep: string;
  /** 温度参数（0~2），越高越随机/有创意，越低越确定/保守 */
  readonly temperature?: number;
  /** 最大输出 token 数，限制模型响应长度 */
  readonly maxTokens?: number;
  /**
   * 是否启用 JSON 验证
   * 必须显式传入 true/false，不允许省略（防止用户忘记配置而导致意外行为）
   */
  readonly validateJson: boolean;
  /**
   * 第一层验证：必需字段列表
   * 检查 JSON 响应中这些字段是否存在且非空（非 null、非空字符串、非空数组、非空对象）
   * 示例：["title", "content", "page_num"]
   */
  readonly requiredFields?: string[];
  /**
   * 第二层验证：JSON 规则
   * 支持两种规则：
   *   - required: string[]  —— 必须存在的字段名列表
   *   - types: Record<string, string> —— 字段的类型约束（类型名见 TYPE_CHECKERS）
   */
  readonly jsonRules: Record<string, unknown>;
  /**
   * JSON 验证失败时的最大重试次数，默认 3 次
   * 每次重试都会重新调用模型（产生额外的 token 费用）
   */
  readonly jsonRetryMaxAttempts: number;
  /**
   * 重试时是否在提示词末尾追加格式强调提示
   * 设为 true 时，重试的提示词会额外附加"请严格返回有效JSON格式"等提醒
   */
  readonly jsonRetryEnhancePrompt: boolean;
  /**
   * 第三层验证：自定义验证器名称
   * 对应 validators/index.ts 中注册的验证器，如 "simple_json"
   * 为 undefined 时跳过第三层验证
   */
  readonly validatorName?: string;
  /**
   * 自定义验证器的配置参数
   * 透传给验证器的 constructor(config)，由具体验证器自行解释
   */
  readonly validatorConfig: Record<string, unknown>;
  /**
   * JSON 验证失败后的重试间隔（秒）
   * 从环境变量 JSON_RETRY_DELAY 读取，默认 2.0 秒
   * 设计目的：避免连续快速重试触发 API 速率限制
   */
  readonly jsonRetryDelay: number;

  /**
   * 验证器实例缓存（懒加载）
   * private 表示仅本类内部可访问（子类也不行）
   * ? 后缀表示可选（首次使用前为 undefined）
   */
  private _validatorInstance?: BaseValidator;

  /**
   * 构造函数
   *
   * @param model               模型简称（如 "gpt4"）
   * @param promptTemplate      提示词模板（如 "翻译：{text}"）
   * @param outputKey           输出键名，默认 "output"
   * @param nextStep            下一步 ID，默认 "END"
   * @param validateJson        是否启用 JSON 验证（必须显式传入，不可省略）
   * @param temperature         温度参数（可选）
   * @param maxTokens           最大输出 token 数（可选）
   * @param requiredFields      必需字段列表（可选）
   * @param jsonRules           JSON 验证规则（可选）
   * @param jsonRetryMaxAttempts JSON 验证重试次数，默认 3
   * @param jsonRetryEnhancePrompt 重试时是否增强提示词，默认 false
   * @param config              额外配置（可包含 validator、validator_config 等）
   */
  constructor(
    model: string,
    promptTemplate: string,
    outputKey = "output",
    nextStep = "END",
    /** ⭐ 必须显式传入 true/false，不允许省略 */
    validateJson: boolean | undefined = undefined,
    temperature?: number,
    maxTokens?: number,
    requiredFields?: string[],
    jsonRules?: Record<string, unknown>,
    jsonRetryMaxAttempts = 3,
    jsonRetryEnhancePrompt = false,
    config: Record<string, unknown> = {}
  ) {
    // 调用父类构造函数，name 传 undefined（使用默认的类名 "LLMCallAction"）
    super(undefined, config);

    // 防御性检查：validateJson 必须显式传入
    // 为什么不用默认值 false？因为忘记配置 validateJson 的 bug 很难排查——
    // 数据悄悄跳过验证，直到下游步骤收到格式错误的数据才暴露问题
    if (validateJson === undefined) {
      throw new Error(
        "LLMCallAction 必须指定 'validateJson' 参数 (true/false)\n" +
          "示例：\n" +
          "  validateJson: true   // 验证JSON格式\n" +
          "  validateJson: false  // 不验证"
      );
    }

    this.model = model;
    this.promptTemplate = promptTemplate;
    this.outputKey = outputKey;
    this.nextStep = nextStep;
    this.validateJson = validateJson;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.requiredFields = requiredFields;
    // ?? 空值合并：jsonRules 为 null/undefined 时使用空对象
    this.jsonRules = jsonRules ?? {};
    this.jsonRetryMaxAttempts = jsonRetryMaxAttempts;
    this.jsonRetryEnhancePrompt = jsonRetryEnhancePrompt;
    // 从 config 中提取验证器相关配置
    // as string | undefined 是类型断言，告诉 TypeScript 这个值的类型
    this.validatorName = config["validator"] as string | undefined;
    this.validatorConfig = (config["validator_config"] as Record<string, unknown>) ?? {};
    // 从环境变量读取重试延迟，parseFloat 将字符串转为浮点数
    this.jsonRetryDelay = parseFloat(process.env["JSON_RETRY_DELAY"] ?? "2.0");
  }

  /**
   * 获取验证器实例（懒加载模式）
   *
   * 懒加载（Lazy Loading）：首次调用时才创建实例，之后复用缓存的实例。
   * 好处：如果整个执行过程中验证都通过了（不需要重试），或者根本没配置验证器，
   * 就不会浪费资源去创建验证器实例。
   *
   * @returns 验证器实例，未配置 validatorName 时返回 null
   */
  private _getValidator(): BaseValidator | null {
    // 如果配置了验证器名称，且尚未创建实例，则创建并缓存
    if (this.validatorName && !this._validatorInstance) {
      try {
        // getValidator 是工厂函数，根据名称查找并实例化对应的验证器
        this._validatorInstance = getValidator(this.validatorName, this.validatorConfig);
        logger.info(`✓ 加载验证器: ${this.validatorName}`);
      } catch (e) {
        logger.error(`❌ 加载验证器失败: ${e}`);
        throw e;
      }
    }
    // ?? 空值合并：_validatorInstance 为 undefined 时返回 null
    return this._validatorInstance ?? null;
  }

  /**
   * 执行 LLM 调用（核心方法）
   *
   * 整体流程：
   *   1. 检测多模态模式（context.data["item"] 是否为图片路径）
   *   2. 进入重试循环（最多 jsonRetryMaxAttempts 次）：
   *      a. 准备提示词（重试时可增强）
   *      b. 调用模型（多模态走 callLlmApi，纯文本走 callModel）
   *      c. 累积统计 token 用量和成本
   *      d. JSON 验证（三层验证体系）
   *      e. 验证通过 → break 跳出循环；验证失败 → continue 重试
   *   3. 构造 StepResult 返回
   *
   * @param context 工作流上下文
   * @returns StepResult，data 中包含模型响应（键名为 outputKey）
   */
  async execute(context: WorkflowContext): Promise<StepResult> {
    // ---- 累计统计变量 ----
    // 用于汇总所有重试的总成本（重试时 token 费用会累加）
    let totalCostInfo: CostResult | null = null;
    // 用于汇总所有重试的总 token 用量
    const allUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    // ---- 第一步：检测多模态模式 ----
    // 如果 context.data["item"] 是图片文件路径（以常见图片扩展名结尾），则启用多模态模式
    // 多模态模式下，图片会被转为 Base64 编码，与文本一起发送给 API
    const itemData = context.data["item"] ?? "";
    const isMultimodal =
      typeof itemData === "string" &&
      /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(itemData);
    // 正则解析：
    //   \.           —— 匹配字面点号（文件名与扩展名的分隔符）
    //   (jpg|jpeg|png|gif|bmp|webp)  —— 匹配常见图片扩展名（用 | 表示"或"）
    //   $            —— 匹配字符串末尾（确保扩展名在最后）
    //   /i           —— 不区分大小写（.JPG 和 .jpg 都能匹配）

    const basePromptTemplate = this.promptTemplate;
    // response 存储最终的模型响应（可能是原始字符串，也可能是解析后的 JSON 对象）
    let response: unknown = null;
    // jsonAttempt 记录当前是第几次尝试（从 0 开始）
    let jsonAttempt = 0;

    // ---- 第二步：进入重试循环 ----
    for (jsonAttempt = 0; jsonAttempt < this.jsonRetryMaxAttempts; jsonAttempt++) {
      // 2a. 准备本次尝试的提示词
      // 首次尝试使用原始模板，重试时可在末尾追加格式强调提示
      let currentPromptTemplate = basePromptTemplate;
      if (jsonAttempt > 0 && this.jsonRetryEnhancePrompt) {
        currentPromptTemplate = this._enhancePromptForJsonRetry(basePromptTemplate, jsonAttempt);
      }

      logger.info(
        `调用模型 ${this.model} (${isMultimodal ? "多模态" : "文本"}模式) - ` +
          `JSON验证尝试 ${jsonAttempt + 1}/${this.jsonRetryMaxAttempts}`
      );

      // 2b. 调用模型
      let resultContent = "";
      let resultUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

      if (isMultimodal) {
        // ======== 多模态路径 ========
        // 将图片文件与文本提示词一起发送给 API
        const imagePath = itemData as string;
        // 检查图片文件是否存在（防止向 API 发送无效请求浪费 token）
        if (!fs.existsSync(imagePath)) {
          throw new Error(`图片文件不存在: ${imagePath}`);
        }

        // 过滤提示词模板中含 {item} 占位符的行
        // 因为 item 是图片路径，以文本形式发送没有意义（模型看不懂文件路径）
        // 图片会通过 image_url 格式单独发送
        const promptText = currentPromptTemplate
          .split("\n")
          .filter((line) => !line.includes("{item}"))
          .join("\n");

        // 从 MODEL_MAPPINGS 中查找模型配置
        // MODEL_MAPPINGS 的值有两种形态：
        //   - 字典（单一配置）：直接使用
        //   - 数组（多配置）：取 enabled === true 的那个
        const entry = MODEL_MAPPINGS[this.model];
        if (entry === undefined) {
          throw new Error(`未知的模型: ${this.model}`);
        }
        const modelConfig = Array.isArray(entry)
          ? (() => {
              // 从数组中筛选 enabled === true 的配置
              const enabled = entry.filter((c) => c.enabled === true);
              if (enabled.length === 0)
                throw new Error(`模型 '${this.model}' 没有启用的配置`);
              // ! 是非空断言，告诉 TypeScript "我确定 enabled[0] 不是 undefined"
              return enabled[0]!;
            })()
          : entry;

        // 构造多模态消息（包含文本块和图片块）
        // callLlmApi 会自动将 { type: "image", path: "..." } 转换为 Base64 编码的 image_url
        const messages: Message[] = [
          {
            role: "user",
            content: [
              { type: "text", text: promptText },
              { type: "image", path: imagePath },
            ],
          },
        ];

        // 调用底层 API
        // callLlmApi 返回 [status, result] 元组：
        //   status === "success" → result 是 LlmResult（包含 content 和 usage）
        //   status !== "success" → result 是错误信息对象
        const [status, result] = await callLlmApi(messages, modelConfig.api_url, modelConfig.api_key, modelConfig.model_name, {
          temperature: this.temperature ?? modelConfig.temperature ?? 0.7,
          max_tokens: this.maxTokens ?? modelConfig.max_tokens ?? 4000,
          extra_params: modelConfig.extra_params ?? {},
        });

        if (status !== "success") {
          // API 调用失败（如认证错误、模型不存在等）
          const errObj = result as Record<string, unknown>;
          // 即使调用失败，也可能有部分 token 用量（如 prompt 已经被处理）
          const errUsage = (errObj["usage"] as typeof resultUsage | undefined) ??
            { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
          const errMsg =
            typeof errObj["error"] === "string"
              ? errObj["error"]
              : JSON.stringify(errObj);

          // 计算并保存失败调用的成本（确保不丢账）
          const costInfo = calculateCost(
            this.model,
            errUsage.prompt_tokens,
            errUsage.completion_tokens,
            errUsage.total_tokens
          );
          // 写入 _lastCostInfo，BaseAction.run() 的 catch 块会自动保存到错误元数据
          this._lastCostInfo = costInfo;
          throw new Error(`模型调用失败: ${errMsg}`);
        }

        // API 调用成功，提取响应内容和 token 用量
        const successResult = result as LlmResult;
        resultContent = successResult.content;
        resultUsage = successResult.usage;
      } else {
        // ======== 纯文本路径 ========
        // 将提示词模板中的 {key} 占位符替换为 context.data 中的实际值
        let prompt: string;
        try {
          // 正则解析：\{(\w+)\}
          //   \{   —— 匹配字面左花括号
          //   (\w+) —— 捕获组：匹配一个或多个"单词字符"（字母/数字/下划线）作为键名
          //   \}   —— 匹配字面右花括号
          // replace 的回调函数：_ 是完整匹配（如 "{text}"），key 是捕获组（如 "text"）
          prompt = currentPromptTemplate.replace(/\{(\w+)\}/g, (_, key: string) => {
            if (!(key in context.data)) throw new Error(key);
            return String(context.data[key]);
          });
        } catch (e) {
          // 如果 context.data 中缺少模板需要的键，抛出更清晰的错误信息
          throw new Error(
            `提示词模板缺少必要的上下文数据: ${e instanceof Error ? e.message : String(e)}`
          );
        }

        // callModel 是简化调用接口：传入模型简称 + prompt，内部自动查找 API 配置
        const result = await callModel(this.model, prompt, this.temperature, this.maxTokens);
        resultContent = result.content;
        resultUsage = result.usage;
      }

      // ---- 2c. 累积统计 token 用量和成本 ----
      // 每次重试都会产生新的 token 费用，需要累加
      allUsage.prompt_tokens += resultUsage.prompt_tokens;
      allUsage.completion_tokens += resultUsage.completion_tokens;
      allUsage.total_tokens += resultUsage.total_tokens;

      // 计算本次调用的成本
      const costInfo = calculateCost(
        this.model,
        resultUsage.prompt_tokens,
        resultUsage.completion_tokens,
        resultUsage.total_tokens
      );

      // 累积总成本（首次初始化，后续累加）
      if (totalCostInfo === null) {
        // 首次调用：用展开运算符 {...} 创建副本（避免后续修改影响 costInfo）
        totalCostInfo = { ...costInfo };
      } else {
        // 后续重试：累加费用和 token 数
        totalCostInfo.total_cost += costInfo.total_cost;
        totalCostInfo.input_cost += costInfo.input_cost;
        totalCostInfo.output_cost += costInfo.output_cost;
        totalCostInfo.total_tokens += costInfo.total_tokens;
        totalCostInfo.input_tokens += costInfo.input_tokens;
        totalCostInfo.output_tokens += costInfo.output_tokens;
      }
      // 更新 _lastCostInfo，确保 BaseAction.run() 在任何时刻都能获取到最新的成本数据
      this._lastCostInfo = totalCostInfo;

      logger.info(
        `模型调用成功 - ` +
          `prompt_tokens=${resultUsage.prompt_tokens}, ` +
          `completion_tokens=${resultUsage.completion_tokens}, ` +
          `total_tokens=${resultUsage.total_tokens}, ` +
          `cost=¥${costInfo.total_cost.toFixed(4)}`
      );

      // ---- 2d. JSON 验证 ----
      response = resultContent;

      if (this.validateJson) {
        try {
          // 从 LLM 响应中提取并解析 JSON
          // validateAndCleanJson 能处理：Markdown 代码块包裹、多余的逗号、单引号等
          const validatedData = validateAndCleanJson(resultContent);

          // ====== 第一层验证：required_fields ======
          // 检查指定字段是否存在且非空
          if (
            this.requiredFields &&
            typeof validatedData === "object" &&
            validatedData !== null &&
            !Array.isArray(validatedData)
          ) {
            const dataObj = validatedData as Record<string, unknown>;
            for (const field of this.requiredFields) {
              const value = dataObj[field];
              // "空"的定义：undefined、null、空字符串、空对象 {}、空数组 []
              if (
                value === undefined ||
                value === null ||
                value === "" ||
                (typeof value === "object" &&
                  !Array.isArray(value) &&
                  Object.keys(value as object).length === 0) ||
                (Array.isArray(value) && value.length === 0)
              ) {
                throw new Error(
                  `❌ 字段 '${field}' 缺失或为空\n\n` +
                    `【实际字段】\n  ${Object.keys(dataObj).join(", ")}\n\n` +
                    `【修复建议】\n  请确保返回字段 '${field}' 且内容不为空`
                );
              }
            }
            logger.debug(`✓ 必需字段验证通过: ${this.requiredFields}`);
          }

          // ====== 第二层验证：json_rules ======
          // 检查字段存在性（required）和类型约束（types）
          if (
            Object.keys(this.jsonRules).length > 0 &&
            typeof validatedData === "object" &&
            validatedData !== null &&
            !Array.isArray(validatedData)
          ) {
            const dataObj = validatedData as Record<string, unknown>;

            // 2a. 必填字段检查
            // (this.jsonRules["required"] as string[] | undefined) ?? []
            // 含义：从 jsonRules 中取 "required" 字段，断言为字符串数组，不存在则用空数组
            for (const field of (this.jsonRules["required"] as string[] | undefined) ?? []) {
              if (!(field in dataObj)) {
                throw new Error(`缺少必填字段: ${field}`);
              }
            }

            // 2b. 类型约束检查
            // Object.entries() 将对象转为 [key, value] 数组，方便遍历
            for (const [field, typeName] of Object.entries(
              (this.jsonRules["types"] as Record<string, string> | undefined) ?? {}
            )) {
              if (field in dataObj) {
                // 从 TYPE_CHECKERS 映射表中查找类型检查函数
                const checker = TYPE_CHECKERS[typeName];
                if (checker && !checker(dataObj[field])) {
                  throw new Error(
                    `字段类型错误: '${field}' 应为 ${typeName}，` +
                      `实际为 ${Array.isArray(dataObj[field]) ? "array" : typeof dataObj[field]}`
                  );
                }
              }
            }
          }

          // ====== 第三层验证：自定义验证器 ======
          // 使用工厂模式创建的验证器实例，执行业务逻辑级别的深度验证
          if (this.validatorName) {
            const validator = this._getValidator();
            if (validator) {
              try {
                validator.validate(validatedData);
                logger.debug(`✓ 自定义验证通过: ${this.validatorName}`);
              } catch (ve) {
                throw new Error(`验证器 '${this.validatorName}' 失败:\n${ve}`);
              }
            }
          }

          // 三层验证全部通过，将解析后的 JSON 对象作为最终响应
          response = validatedData;

          // 打印验证成功日志（重试时附带累积统计信息）
          if (jsonAttempt > 0) {
            logger.info(
              `✓ JSON验证通过（第${jsonAttempt + 1}次尝试）- ` +
                `cumulative_prompt_tokens=${allUsage.prompt_tokens}, ` +
                `cumulative_completion_tokens=${allUsage.completion_tokens}, ` +
                `cumulative_total_tokens=${allUsage.total_tokens}, ` +
                `cumulative_cost=¥${totalCostInfo.total_cost.toFixed(4)}`
            );
          } else {
            logger.info("✓ JSON格式验证通过");
          }

          break; // 验证通过，跳出重试循环
        } catch (e) {
          // ---- JSON 验证失败处理 ----
          logger.warn(
            `❌ JSON验证失败（尝试 ${jsonAttempt + 1}/${this.jsonRetryMaxAttempts}）: ${e} - ` +
              `prompt_tokens=${resultUsage.prompt_tokens}, ` +
              `completion_tokens=${resultUsage.completion_tokens}, ` +
              `total_tokens=${resultUsage.total_tokens}, ` +
              `cost=¥${costInfo.total_cost.toFixed(4)}`
          );

          if (jsonAttempt < this.jsonRetryMaxAttempts - 1) {
            // 还有重试机会：等待一段时间后继续
            logger.info(
              `将在 ${this.jsonRetryDelay} 秒后重试 - ` +
                `cumulative_prompt_tokens=${allUsage.prompt_tokens}, ` +
                `cumulative_completion_tokens=${allUsage.completion_tokens}, ` +
                `cumulative_total_tokens=${allUsage.total_tokens}, ` +
                `cumulative_cost=¥${totalCostInfo.total_cost.toFixed(4)}`
            );
            // setTimeout + Promise 实现异步等待（不阻塞事件循环）
            await new Promise((resolve) =>
              setTimeout(resolve, this.jsonRetryDelay * 1000)
            );
            continue; // 继续下一次重试
          }

          // 达到最大重试次数，抛出携带成本信息的自定义异常
          logger.error(
            `❌ JSON验证失败，已达最大重试次数 (${this.jsonRetryMaxAttempts})`
          );
          // 截取原始响应的前 200 个字符作为预览，方便调试
          const rawPreview =
            typeof response === "string"
              ? response.slice(0, 200)
              : String(response).slice(0, 200);

          // 抛出 LLMValidationError（继承自 Error）
          // 它携带了 costInfo 和 usage，确保 BaseAction.run() 的 catch 块
          // 以及上层的 ConcurrentAction 都能获取到成本数据
          throw new LLMValidationError(
            `JSON验证失败（重试${this.jsonRetryMaxAttempts}次后仍失败）: ${e}\n` +
              `原始响应预览: ${rawPreview}\n` +
              `cumulative_prompt_tokens=${allUsage.prompt_tokens}, ` +
              `cumulative_completion_tokens=${allUsage.completion_tokens}, ` +
              `cumulative_total_tokens=${allUsage.total_tokens}, ` +
              `cumulative_cost=¥${totalCostInfo.total_cost.toFixed(4)}`,
            totalCostInfo,
            allUsage,
            jsonAttempt + 1,
            e
          );
        }
      } else {
        break; // 不验证 JSON，直接跳出循环
      }
    }

    // ---- 第三步：构造并返回 StepResult ----
    // 调用 resolveNextStep 而非直接使用 this.nextStep
    // 默认实现返回固定的 this.nextStep，子类（如 ConditionalLLMAction）可覆盖此方法实现动态路由
    return new StepResult(
      this.resolveNextStep(response),
      // data: 将模型响应存入 context.data，键名为 outputKey
      // [this.outputKey] 是计算属性名语法，等价于：{ "output": response }
      { [this.outputKey]: response },
      // metadata: 记录本次调用的完整信息，供日志系统和成本统计使用
      {
        model: this.model,                    // 使用的模型简称
        mode: isMultimodal ? "multimodal" : "text",  // 调用模式
        response_length:                      // 响应长度（字符数）
          typeof response === "string"
            ? response.length
            : String(response).length,
        usage: allUsage,                      // 累积 token 用量
        cost: totalCostInfo,                  // 累积成本信息
        json_validated: this.validateJson,    // 是否启用了 JSON 验证
        json_retry_attempts: jsonAttempt + 1, // 实际尝试次数（1 表示一次通过）
      }
    );
  }

  /**
   * 解析下一步 ID（供子类覆盖）
   *
   * 默认返回构造时传入的固定 nextStep。
   * 子类（如 ConditionalLLMAction）可覆盖此方法，根据模型响应动态决定下一步走向。
   *
   * @param response 模型的响应内容（可能是原始字符串，也可能是解析后的 JSON 对象）
   * @returns 下一步的 step ID
   */
  protected resolveNextStep(_response: unknown): string {
    return this.nextStep;
  }

  /**
   * 重试时增强提示词
   *
   * 在原始提示词末尾追加格式强调提示，引导模型返回有效的 JSON。
   * 第 2 次重试时追加基本提示，第 3 次及以后追加更强烈的提示。
   *
   * @param originalPrompt 原始提示词模板
   * @param attempt        当前尝试次数（从 0 开始，0 = 首次，不会调用此方法）
   * @returns 增强后的提示词
   */
  private _enhancePromptForJsonRetry(originalPrompt: string, attempt: number): string {
    let enhancement =
      "\n\n⚠️ 重要提示：\n" +
      "- 请**严格**返回有效的JSON格式\n" +
      "- 不要添加任何Markdown代码块标记（如 ```json）\n" +
      "- 不要添加任何注释或说明文字\n" +
      "- 确保所有字段都符合要求的类型\n";

    // 第 3 次及以后的尝试，追加更强烈的提醒
    if (attempt > 1) {
      enhancement += `- 这是第${attempt + 1}次尝试，请务必仔细检查格式\n`;
    }

    return originalPrompt + enhancement;
  }
}

// ============================================================
// ConditionalLLMAction —— 条件 LLM 动作
// ============================================================

/**
 * 条件 LLM 动作
 *
 * 继承自 LLMCallAction，复用父类的全部能力（模型调用、提示词替换、多模态、
 * JSON 验证、重试、成本统计），唯一的区别在于 nextStep 的决定方式：
 *   - LLMCallAction 的 nextStep 是固定的（在构造时确定）
 *   - ConditionalLLMAction 的 nextStep 是动态的（由 conditionFunc 根据模型输出决定）
 *
 * 实现原理：覆盖父类的 resolveNextStep() 方法，将模型响应传给条件函数，
 * 由函数返回值决定下一步走向（动态路由）。
 *
 * 使用场景示例——分类路由：
 *   const classifier = new ConditionalLLMAction(
 *     "gpt4",
 *     "判断以下文本的语言：{text}\n只回答：中文/英文/其他",
 *     (response) => {
 *       if (response.includes("中文")) return "chinese_pipeline";
 *       if (response.includes("英文")) return "english_pipeline";
 *       return "fallback_pipeline";
 *     },
 *     "language"
 *   );
 *   // 模型回复 "中文" → nextStep = "chinese_pipeline"
 *   // 模型回复 "英文" → nextStep = "english_pipeline"
 *
 * 默认不启用 JSON 验证（validateJson = false），行为与重构前一致。
 * 如果需要条件动作也支持 JSON 验证，可在 config 中传入相应配置。
 */
export class ConditionalLLMAction extends LLMCallAction {
  /**
   * 条件函数——接收模型响应文本，返回下一步的 ID
   *
   * 函数签名：(response: string) => string
   *   - 参数 response: 模型返回的原始文本
   *   - 返回值: 下一步的 step ID（如 "process_step"、"END"）
   *
   * 由调用方在构造时注入（依赖注入模式），保持动作类本身与业务逻辑解耦
   */
  readonly conditionFunc: (response: string) => string;

  /**
   * @param model           模型简称
   * @param promptTemplate  提示词模板
   * @param conditionFunc   条件函数，根据模型输出决定下一步
   * @param outputKey       输出键名，默认 "output"
   * @param config          额外配置
   */
  constructor(
    model: string,
    promptTemplate: string,
    conditionFunc: (response: string) => string,
    outputKey = "output",
    config: Record<string, unknown> = {}
  ) {
    // 调用 LLMCallAction 构造函数
    // nextStep 传 "END"（不会被使用，因为 resolveNextStep 被子类覆盖）
    // validateJson 传 false（默认不验证，行为与重构前一致）
    // 其余参数使用默认值：temperature/maxTokens/requiredFields/jsonRules 均为 undefined
    // jsonRetryMaxAttempts = 3, jsonRetryEnhancePrompt = false
    super(model, promptTemplate, outputKey, "END", false, undefined, undefined, undefined, undefined, 3, false, config);
    this.conditionFunc = conditionFunc;
  }

  /**
   * 覆盖父类的 resolveNextStep，用条件函数动态决定下一步
   *
   * 父类 LLMCallAction.execute() 在构造 StepResult 时会调用此方法。
   * 默认实现返回固定的 this.nextStep，这里改为将模型响应传给 conditionFunc，
   * 由业务逻辑决定下一步走向。
   *
   * @param response 模型的响应内容（转为字符串后传给 conditionFunc）
   * @returns 下一步的 step ID，由 conditionFunc 的返回值决定
   */
  protected resolveNextStep(response: unknown): string {
    return this.conditionFunc(String(response));
  }
}
