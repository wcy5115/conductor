/**
 * LLM 相关动作
 *
 * LLMCallAction      — 调用 LLM，支持 JSON 验证、多模态、重试、成本统计
 * ConditionalLLMAction — 调用 LLM 后由外部函数决定下一步（动态路由）
 */

import fs from "fs";
import { BaseAction } from "./base.js";
import { WorkflowContext, StepResult } from "../workflow_engine.js";
import { callModel, MODEL_MAPPINGS } from "../model_caller.js";
import { callLlmApi, Message, LlmResult } from "../llm_client.js";
import { calculateCost, CostResult } from "../cost_calculator.js";
import { validateAndCleanJson } from "../utils.js";
import { LLMValidationError } from "../exceptions.js";
import { BaseValidator } from "../validators/base.js";
import { getValidator } from "../validators/index.js";

const logger = {
  info: (msg: string) => console.info(msg),
  warn: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
  debug: (msg: string) => console.debug(msg),
};

// JSON 字段类型检查映射
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
// LLMCallAction
// ============================================================

/**
 * LLM 调用动作
 *
 * 使用指定模型处理输入并产生输出，支持：
 * - 文本 / 多模态（图片路径自动识别）
 * - JSON 格式验证与自动重试
 * - 三层验证：required_fields → json_rules → 自定义 validator
 * - 累积 token 用量与成本统计
 */
export class LLMCallAction extends BaseAction {
  readonly model: string;
  readonly promptTemplate: string;
  readonly outputKey: string;
  readonly nextStep: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly validateJson: boolean;
  readonly requiredFields?: string[];
  readonly jsonRules: Record<string, unknown>;
  readonly jsonRetryMaxAttempts: number;
  readonly jsonRetryEnhancePrompt: boolean;
  readonly validatorName?: string;
  readonly validatorConfig: Record<string, unknown>;
  readonly jsonRetryDelay: number;

  private _validatorInstance?: BaseValidator;

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
    super(undefined, config);

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
    this.jsonRules = jsonRules ?? {};
    this.jsonRetryMaxAttempts = jsonRetryMaxAttempts;
    this.jsonRetryEnhancePrompt = jsonRetryEnhancePrompt;
    this.validatorName = config["validator"] as string | undefined;
    this.validatorConfig = (config["validator_config"] as Record<string, unknown>) ?? {};
    this.jsonRetryDelay = parseFloat(process.env["JSON_RETRY_DELAY"] ?? "2.0");
  }

  /** 获取验证器实例（懒加载，首次调用时实例化并缓存） */
  private _getValidator(): BaseValidator | null {
    if (this.validatorName && !this._validatorInstance) {
      try {
        this._validatorInstance = getValidator(this.validatorName, this.validatorConfig);
        logger.info(`✓ 加载验证器: ${this.validatorName}`);
      } catch (e) {
        logger.error(`❌ 加载验证器失败: ${e}`);
        throw e;
      }
    }
    return this._validatorInstance ?? null;
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    // 累计统计
    let totalCostInfo: CostResult | null = null;
    const allUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    // 检测多模态模式（item 为图片文件路径）
    const itemData = context.data["item"] ?? "";
    const isMultimodal =
      typeof itemData === "string" &&
      /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(itemData);

    const basePromptTemplate = this.promptTemplate;
    let response: unknown = null;
    let jsonAttempt = 0;

    for (jsonAttempt = 0; jsonAttempt < this.jsonRetryMaxAttempts; jsonAttempt++) {
      // 1. 准备本次尝试的 prompt（重试时可增强）
      let currentPromptTemplate = basePromptTemplate;
      if (jsonAttempt > 0 && this.jsonRetryEnhancePrompt) {
        currentPromptTemplate = this._enhancePromptForJsonRetry(basePromptTemplate, jsonAttempt);
      }

      logger.info(
        `调用模型 ${this.model} (${isMultimodal ? "多模态" : "文本"}模式) - ` +
          `JSON验证尝试 ${jsonAttempt + 1}/${this.jsonRetryMaxAttempts}`
      );

      // 2. 调用模型
      let resultContent = "";
      let resultUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

      if (isMultimodal) {
        // --- 多模态路径 ---
        const imagePath = itemData as string;
        if (!fs.existsSync(imagePath)) {
          throw new Error(`图片文件不存在: ${imagePath}`);
        }

        // 过滤含 {item} 占位符的行，避免误送路径字符串
        const promptText = currentPromptTemplate
          .split("\n")
          .filter((line) => !line.includes("{item}"))
          .join("\n");

        // 解析模型配置
        const entry = MODEL_MAPPINGS[this.model];
        if (entry === undefined) {
          throw new Error(`未知的模型: ${this.model}`);
        }
        const modelConfig = Array.isArray(entry)
          ? (() => {
              const enabled = entry.filter((c) => c.enabled === true);
              if (enabled.length === 0)
                throw new Error(`模型 '${this.model}' 没有启用的配置`);
              return enabled[0]!;
            })()
          : entry;

        const messages: Message[] = [
          {
            role: "user",
            content: [
              { type: "text", text: promptText },
              { type: "image", path: imagePath },
            ],
          },
        ];

        const [status, result] = await callLlmApi(messages, modelConfig.api_url, modelConfig.api_key, modelConfig.model_name, {
          temperature: this.temperature ?? modelConfig.temperature ?? 0.7,
          max_tokens: this.maxTokens ?? modelConfig.max_tokens ?? 4000,
          extra_params: modelConfig.extra_params ?? {},
        });

        if (status !== "success") {
          const errObj = result as Record<string, unknown>;
          const errUsage = (errObj["usage"] as typeof resultUsage | undefined) ??
            { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
          const errMsg =
            typeof errObj["error"] === "string"
              ? errObj["error"]
              : JSON.stringify(errObj);

          const costInfo = calculateCost(
            this.model,
            errUsage.prompt_tokens,
            errUsage.completion_tokens,
            errUsage.total_tokens
          );
          this._lastCostInfo = costInfo;
          throw new Error(`模型调用失败: ${errMsg}`);
        }

        const successResult = result as LlmResult;
        resultContent = successResult.content;
        resultUsage = successResult.usage;
      } else {
        // --- 纯文本路径 ---
        let prompt: string;
        try {
          prompt = currentPromptTemplate.replace(/\{(\w+)\}/g, (_, key: string) => {
            if (!(key in context.data)) throw new Error(key);
            return String(context.data[key]);
          });
        } catch (e) {
          throw new Error(
            `提示词模板缺少必要的上下文数据: ${e instanceof Error ? e.message : String(e)}`
          );
        }

        const result = await callModel(this.model, prompt, this.temperature, this.maxTokens);
        resultContent = result.content;
        resultUsage = result.usage;
      }

      // 3. 统计成本（累积）
      allUsage.prompt_tokens += resultUsage.prompt_tokens;
      allUsage.completion_tokens += resultUsage.completion_tokens;
      allUsage.total_tokens += resultUsage.total_tokens;

      const costInfo = calculateCost(
        this.model,
        resultUsage.prompt_tokens,
        resultUsage.completion_tokens,
        resultUsage.total_tokens
      );

      if (totalCostInfo === null) {
        totalCostInfo = { ...costInfo };
      } else {
        totalCostInfo.total_cost += costInfo.total_cost;
        totalCostInfo.input_cost += costInfo.input_cost;
        totalCostInfo.output_cost += costInfo.output_cost;
        totalCostInfo.total_tokens += costInfo.total_tokens;
        totalCostInfo.input_tokens += costInfo.input_tokens;
        totalCostInfo.output_tokens += costInfo.output_tokens;
      }
      this._lastCostInfo = totalCostInfo;

      logger.info(
        `模型调用成功 - ` +
          `prompt_tokens=${resultUsage.prompt_tokens}, ` +
          `completion_tokens=${resultUsage.completion_tokens}, ` +
          `total_tokens=${resultUsage.total_tokens}, ` +
          `cost=¥${costInfo.total_cost.toFixed(4)}`
      );

      // 4. JSON 验证
      response = resultContent;

      if (this.validateJson) {
        try {
          const validatedData = validateAndCleanJson(resultContent);

          // 第一层：required_fields（字段存在且非空）
          if (
            this.requiredFields &&
            typeof validatedData === "object" &&
            validatedData !== null &&
            !Array.isArray(validatedData)
          ) {
            const dataObj = validatedData as Record<string, unknown>;
            for (const field of this.requiredFields) {
              const value = dataObj[field];
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

          // 第二层：json_rules（字段存在性 + 类型约束）
          if (
            Object.keys(this.jsonRules).length > 0 &&
            typeof validatedData === "object" &&
            validatedData !== null &&
            !Array.isArray(validatedData)
          ) {
            const dataObj = validatedData as Record<string, unknown>;

            for (const field of (this.jsonRules["required"] as string[] | undefined) ?? []) {
              if (!(field in dataObj)) {
                throw new Error(`缺少必填字段: ${field}`);
              }
            }

            for (const [field, typeName] of Object.entries(
              (this.jsonRules["types"] as Record<string, string> | undefined) ?? {}
            )) {
              if (field in dataObj) {
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

          // 第三层：自定义验证器
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

          response = validatedData;

          // 验证成功日志
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
          logger.warn(
            `❌ JSON验证失败（尝试 ${jsonAttempt + 1}/${this.jsonRetryMaxAttempts}）: ${e} - ` +
              `prompt_tokens=${resultUsage.prompt_tokens}, ` +
              `completion_tokens=${resultUsage.completion_tokens}, ` +
              `total_tokens=${resultUsage.total_tokens}, ` +
              `cost=¥${costInfo.total_cost.toFixed(4)}`
          );

          if (jsonAttempt < this.jsonRetryMaxAttempts - 1) {
            logger.info(
              `将在 ${this.jsonRetryDelay} 秒后重试 - ` +
                `cumulative_prompt_tokens=${allUsage.prompt_tokens}, ` +
                `cumulative_completion_tokens=${allUsage.completion_tokens}, ` +
                `cumulative_total_tokens=${allUsage.total_tokens}, ` +
                `cumulative_cost=¥${totalCostInfo.total_cost.toFixed(4)}`
            );
            await new Promise((resolve) =>
              setTimeout(resolve, this.jsonRetryDelay * 1000)
            );
            continue;
          }

          // 达到最大重试次数，抛出携带成本信息的自定义异常
          logger.error(
            `❌ JSON验证失败，已达最大重试次数 (${this.jsonRetryMaxAttempts})`
          );
          const rawPreview =
            typeof response === "string"
              ? response.slice(0, 200)
              : String(response).slice(0, 200);

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
        break; // 不验证 JSON，直接跳出
      }
    }

    return new StepResult(
      this.nextStep,
      { [this.outputKey]: response },
      {
        model: this.model,
        mode: isMultimodal ? "multimodal" : "text",
        response_length:
          typeof response === "string"
            ? response.length
            : String(response).length,
        usage: allUsage,
        cost: totalCostInfo,
        json_validated: this.validateJson,
        json_retry_attempts: jsonAttempt + 1,
      }
    );
  }

  /** 重试时在 prompt 末尾追加格式强调提示 */
  private _enhancePromptForJsonRetry(originalPrompt: string, attempt: number): string {
    let enhancement =
      "\n\n⚠️ 重要提示：\n" +
      "- 请**严格**返回有效的JSON格式\n" +
      "- 不要添加任何Markdown代码块标记（如 ```json）\n" +
      "- 不要添加任何注释或说明文字\n" +
      "- 确保所有字段都符合要求的类型\n";

    if (attempt > 1) {
      enhancement += `- 这是第${attempt + 1}次尝试，请务必仔细检查格式\n`;
    }

    return originalPrompt + enhancement;
  }
}

// ============================================================
// ConditionalLLMAction
// ============================================================

/**
 * 条件 LLM 动作
 *
 * 调用模型后，将输出传给外部注入的 conditionFunc，
 * 由它返回 nextStep，实现基于 LLM 输出的动态分支跳转。
 */
export class ConditionalLLMAction extends BaseAction {
  readonly model: string;
  readonly promptTemplate: string;
  readonly conditionFunc: (response: string) => string;
  readonly outputKey: string;

  constructor(
    model: string,
    promptTemplate: string,
    conditionFunc: (response: string) => string,
    outputKey = "output",
    config: Record<string, unknown> = {}
  ) {
    super(undefined, config);
    this.model = model;
    this.promptTemplate = promptTemplate;
    this.conditionFunc = conditionFunc;
    this.outputKey = outputKey;
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    const prompt = this.promptTemplate.replace(
      /\{(\w+)\}/g,
      (_, key: string) => String(context.data[key] ?? "")
    );

    const result = await callModel(this.model, prompt);
    const response = result.content;
    const usage = result.usage;

    logger.info(
      `模型调用tokens: ${usage.prompt_tokens}/${usage.completion_tokens}/${usage.total_tokens}`
    );

    const nextStep = this.conditionFunc(response);

    return new StepResult(
      nextStep,
      { [this.outputKey]: response },
      { model: this.model, condition_result: nextStep }
    );
  }
}
