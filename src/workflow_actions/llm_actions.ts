/**
 * LLM action module.
 *
 * This file defines the standard LLM action plus a conditional variant that
 * chooses the next step from the model response.
 */

import fs from "fs";
import { BaseAction } from "./base.js";
import { WorkflowContext, StepResult } from "../workflow_engine.js";
import { callModel, MODEL_MAPPINGS } from "../model_caller.js";
import { callLlmApi } from "../llm_client.js";
import type { Message, LlmResult, LlmCallOptions, RetryBackoff } from "../llm_client.js";
import { calculateCost, CostResult } from "../cost_calculator.js";
import { validateAndCleanJson } from "../utils.js";
import { LLMRetriableError, LLMValidationError } from "../exceptions.js";
import { BaseValidator } from "../validators/base.js";
import { getValidator } from "../validators/index.js";
import {
  terminalInternalDebug,
  terminalInternalError,
  terminalInternalInfo,
  terminalInternalWarn,
} from "../core/terminal_reporter.js";

/**
 * Lightweight logger that avoids a dependency on the core logging module.
 */
const logger = {
  info: (msg: string) => terminalInternalInfo(msg),
  warn: (msg: string) => terminalInternalWarn(msg),
  error: (msg: string) => terminalInternalError(msg),
  debug: (msg: string) => terminalInternalDebug(msg),
};

/**
 * Type check helpers used by json_rules validation.
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

function parseNumberOption(config: Record<string, unknown>, key: string): number | undefined {
  const value = config[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`llm_call field '${key}' must be a finite number`);
  }
  return value;
}

function parseRetryBackoffOption(config: Record<string, unknown>): RetryBackoff | undefined {
  const value = config["retry_backoff"];
  if (value === undefined) return undefined;
  if (value === "fixed" || value === "linear" || value === "exponential") {
    return value;
  }
  throw new Error("llm_call field 'retry_backoff' must be one of: fixed, linear, exponential");
}

// ============================================================
// LLMCallAction
// ============================================================

/**
 * Standard workflow action for calling an LLM.
 */
export class LLMCallAction extends BaseAction {
  /** Model alias from models.yaml, for example "gpt4" or "kimi". */
  readonly model: string;
  /**
   * Prompt template with {key} placeholders filled from context.data.
   */
  readonly promptTemplate: string;
  /**
   * Context key that stores the model response.
   */
  readonly outputKey: string;
  /** Next step ID. The default is "END". */
  readonly nextStep: string;
  /** Temperature from 0 to 2. */
  readonly temperature?: number;
  /** Maximum output tokens. */
  readonly maxTokens?: number;
  /** Optional timeout in seconds for long-running calls. */
  readonly timeout?: number;
  /** Optional maximum model/API retry attempts for retriable failures. */
  readonly maxRetries?: number;
  /** Optional base delay between model/API retry attempts, in seconds. */
  readonly retryDelay?: number;
  /** Optional model/API retry backoff policy. */
  readonly retryBackoff?: RetryBackoff;
  /**
   * Whether JSON validation is enabled. This must be passed explicitly.
   */
  readonly validateJson: boolean;
  /**
   * First validation layer: required fields that must be present and non-empty.
   */
  readonly requiredFields?: string[];
  /**
   * Second validation layer: json_rules required fields and type checks.
   */
  readonly jsonRules: Record<string, unknown>;
  /**
   * Maximum retry attempts after JSON validation failure.
   */
  readonly jsonRetryMaxAttempts: number;
  /**
   * Whether retry attempts should append extra formatting guidance.
   */
  readonly jsonRetryEnhancePrompt: boolean;
  /**
   * Third validation layer: optional validator name from validators/index.ts.
   */
  readonly validatorName?: string;
  /**
   * Configuration passed through to the custom validator constructor.
   */
  readonly validatorConfig: Record<string, unknown>;
  /**
   * Delay between JSON validation retries, in seconds.
   */
  readonly jsonRetryDelay: number;

  /**
   * Lazily created validator instance.
   */
  private _validatorInstance?: BaseValidator;

  /**
   * @param model Model alias such as "gpt4".
   * @param promptTemplate Prompt template such as "Translate: {text}".
   * @param outputKey Output key, default "output".
   * @param nextStep Next step ID, default "END".
   * @param validateJson Whether JSON validation is enabled.
   * @param temperature Optional temperature.
   * @param maxTokens Optional output token limit.
   * @param timeout Optional timeout in seconds.
   * @param requiredFields Optional required fields.
   * @param jsonRules Optional JSON validation rules.
   * @param jsonRetryMaxAttempts Maximum JSON retry attempts.
   * @param jsonRetryEnhancePrompt Whether to strengthen the retry prompt.
   * @param config Extra config, including validator settings.
   * @param name Action name used in logs.
   */
  constructor(
    model: string,
    promptTemplate: string,
    outputKey = "output",
    nextStep = "END",
    /** Must be passed explicitly as true or false. */
    validateJson: boolean | undefined = undefined,
    temperature?: number,
    maxTokens?: number,
    timeout?: number,
    requiredFields?: string[],
    jsonRules?: Record<string, unknown>,
    jsonRetryMaxAttempts = 3,
    jsonRetryEnhancePrompt = false,
    config: Record<string, unknown> = {},
    name?: string
  ) {
    super(name, config);

    // Force callers to choose validation behavior explicitly.
    if (validateJson === undefined) {
      throw new Error(
        "LLMCallAction requires the 'validateJson' argument (true/false)\n" +
          "Example:\n" +
          "  validateJson: true   // validate JSON output\n" +
          "  validateJson: false  // do not validate"
      );
    }

    this.model = model;
    this.promptTemplate = promptTemplate;
    this.outputKey = outputKey;
    this.nextStep = nextStep;
    this.validateJson = validateJson;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.timeout = timeout;
    this.maxRetries = parseNumberOption(config, "max_retries");
    this.retryDelay = parseNumberOption(config, "retry_delay");
    this.retryBackoff = parseRetryBackoffOption(config);
    this.requiredFields = requiredFields;
    // Default nullish jsonRules to an empty object.
    this.jsonRules = jsonRules ?? {};
    this.jsonRetryMaxAttempts = jsonRetryMaxAttempts;
    this.jsonRetryEnhancePrompt = jsonRetryEnhancePrompt;
    // Read validator settings from config.
    this.validatorName = config["validator"] as string | undefined;
    this.validatorConfig = (config["validator_config"] as Record<string, unknown>) ?? {};
    // Read the retry delay from the environment.
    this.jsonRetryDelay = parseFloat(process.env["JSON_RETRY_DELAY"] ?? "2.0");
  }

  private _llmRetryOptions(): Pick<LlmCallOptions, "max_retries" | "retry_delay" | "retry_backoff"> {
    const options: Pick<LlmCallOptions, "max_retries" | "retry_delay" | "retry_backoff"> = {};
    if (this.maxRetries !== undefined) options.max_retries = this.maxRetries;
    if (this.retryDelay !== undefined) options.retry_delay = this.retryDelay;
    if (this.retryBackoff !== undefined) options.retry_backoff = this.retryBackoff;
    return options;
  }

  /**
   * Return the cached validator instance, creating it on first use.
   */
  private _getValidator(): BaseValidator | null {
    // Create and cache the validator on first use.
    if (this.validatorName && !this._validatorInstance) {
      try {
        // getValidator is a factory that builds a validator by name.
        this._validatorInstance = getValidator(this.validatorName, this.validatorConfig);
        logger.info(`Loaded validator: ${this.validatorName}`);
      } catch (e) {
        logger.error(`Failed to load validator: ${e}`);
        throw e;
      }
    }
    // Return null when no validator is configured.
    return this._validatorInstance ?? null;
  }

  /**
   * Render a prompt template from context data.
   *
   * In multimodal mode, the image path is sent separately, so callers may omit
   * the raw {item} value from the text prompt while still keeping the line.
   */
  private _renderPromptTemplate(
    template: string,
    context: WorkflowContext,
    options: { omitItemValue?: boolean } = {}
  ): string {
    try {
      return template.replace(/\{(\w+)\}/g, (_, key: string) => {
        if (options.omitItemValue && key === "item") {
          return "";
        }
        if (!(key in context.data)) {
          throw new Error(key);
        }
        return String(context.data[key]);
      });
    } catch (e) {
      throw new Error(
        `Prompt template is missing required context data: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /**
   * Execute the LLM call, including optional JSON validation and retries.
   */
  async execute(context: WorkflowContext): Promise<StepResult> {
    // Aggregate usage and cost across retries.
    let totalCostInfo: CostResult | null = null;
    const allUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    // Detect image-input mode from the item path.
    const itemData = context.data["item"] ?? "";
    const isMultimodal =
      typeof itemData === "string" &&
      /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(itemData);

    const basePromptTemplate = this.promptTemplate;
    let response: unknown = null;
    let jsonAttempt = 0;

    for (jsonAttempt = 0; jsonAttempt < this.jsonRetryMaxAttempts; jsonAttempt++) {
      // Prepare the prompt for this attempt.
      let currentPromptTemplate = basePromptTemplate;
      if (jsonAttempt > 0 && this.jsonRetryEnhancePrompt) {
        currentPromptTemplate = this._enhancePromptForJsonRetry(basePromptTemplate, jsonAttempt);
      }

      logger.info(
        `Calling model ${this.model} (${isMultimodal ? "multimodal" : "text"} mode) - ` +
          `JSON validation attempt ${jsonAttempt + 1}/${this.jsonRetryMaxAttempts}`
      );

      let resultContent = "";
      let resultUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

      if (isMultimodal) {
        // Send text plus the image payload.
        const imagePath = itemData as string;
        if (!fs.existsSync(imagePath)) {
          throw new Error(`Image file does not exist: ${imagePath}`);
        }

        const promptText = this._renderPromptTemplate(currentPromptTemplate, context, {
          omitItemValue: true,
        });

        const entry = MODEL_MAPPINGS[this.model];
        if (entry === undefined) {
          throw new Error(`Unknown model: ${this.model}`);
        }
        const modelConfig = Array.isArray(entry)
          ? (() => {
              const enabled = entry.filter((c) => c.enabled === true);
              if (enabled.length === 0)
                throw new Error(`Model '${this.model}' has no enabled configuration`);
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

        const callOptions: LlmCallOptions = {
          temperature: this.temperature ?? modelConfig.temperature ?? 0.7,
          max_tokens: this.maxTokens ?? modelConfig.max_tokens ?? 4000,
          ...this._llmRetryOptions(),
          extra_params: modelConfig.extra_params ?? {},
        };
        if (this.timeout !== undefined) {
          callOptions.timeout = this.timeout;
        }
        const [status, result] = await callLlmApi(messages, modelConfig.api_url, modelConfig.api_key, modelConfig.model_name, callOptions);

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
          if (status === "retriable_error") {
            throw new LLMRetriableError(`Model call failed: ${errMsg}`, {
              causeValue: result,
              errorType:
                typeof errObj["error_type"] === "string"
                  ? errObj["error_type"]
                  : undefined,
            });
          }
          throw new Error(`Model call failed: ${errMsg}`);
        }

        const successResult = result as LlmResult;
        resultContent = successResult.content;
        resultUsage = successResult.usage;
      } else {
        const prompt = this._renderPromptTemplate(currentPromptTemplate, context);

        const result = await callModel(
          this.model,
          prompt,
          this.temperature,
          this.maxTokens,
          this.timeout,
          this._llmRetryOptions(),
        );
        resultContent = result.content;
        resultUsage = result.usage;
      }

      // Accumulate usage and cost.
      allUsage.prompt_tokens += resultUsage.prompt_tokens;
      allUsage.completion_tokens += resultUsage.completion_tokens;
      allUsage.total_tokens += resultUsage.total_tokens;

      // Calculate the cost of this attempt.
      const costInfo = calculateCost(
        this.model,
        resultUsage.prompt_tokens,
        resultUsage.completion_tokens,
        resultUsage.total_tokens
      );

      // Accumulate the total cost across retries.
      if (totalCostInfo === null) {
        // Clone the first result so later updates do not mutate costInfo.
        totalCostInfo = { ...costInfo };
      } else {
        // Add the later retry totals.
        totalCostInfo.total_cost += costInfo.total_cost;
        totalCostInfo.input_cost += costInfo.input_cost;
        totalCostInfo.output_cost += costInfo.output_cost;
        totalCostInfo.total_tokens += costInfo.total_tokens;
        totalCostInfo.input_tokens += costInfo.input_tokens;
        totalCostInfo.output_tokens += costInfo.output_tokens;
      }
      // Keep the latest cost summary available to BaseAction.run().
      this._lastCostInfo = totalCostInfo;

      logger.info(
        `Model call succeeded - ` +
          `prompt_tokens=${resultUsage.prompt_tokens}, ` +
          `completion_tokens=${resultUsage.completion_tokens}, ` +
          `total_tokens=${resultUsage.total_tokens}, ` +
          `cost=¥${costInfo.total_cost.toFixed(4)}`
      );

      // Validate JSON when requested.
      response = resultContent;

      if (this.validateJson) {
        try {
          const validatedData = validateAndCleanJson(resultContent);

          // First validation layer: required_fields.
          if (
            this.requiredFields &&
            typeof validatedData === "object" &&
            validatedData !== null &&
            !Array.isArray(validatedData)
          ) {
            const dataObj = validatedData as Record<string, unknown>;
            for (const field of this.requiredFields) {
              const value = dataObj[field];
              // Treat undefined, null, empty strings, empty objects, and empty
              // arrays as missing.
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
                  `Field '${field}' is missing or empty\n\n` +
                    `[Actual fields]\n  ${Object.keys(dataObj).join(", ")}\n\n` +
                    `[Suggested fix]\n  Make sure '${field}' is present and non-empty`
                );
              }
            }
            logger.debug(`Required field validation passed: ${this.requiredFields}`);
          }

          // Second validation layer: json_rules.
          if (
            Object.keys(this.jsonRules).length > 0 &&
            typeof validatedData === "object" &&
            validatedData !== null &&
            !Array.isArray(validatedData)
          ) {
            const dataObj = validatedData as Record<string, unknown>;

            // Required fields.
            for (const field of (this.jsonRules["required"] as string[] | undefined) ?? []) {
              if (!(field in dataObj)) {
                throw new Error(`Missing required field: ${field}`);
              }
            }

            // Type constraints.
            for (const [field, typeName] of Object.entries(
              (this.jsonRules["types"] as Record<string, string> | undefined) ?? {}
            )) {
              if (field in dataObj) {
                const checker = TYPE_CHECKERS[typeName];
                if (checker && !checker(dataObj[field])) {
                  throw new Error(
                    `Invalid field type: '${field}' should be ${typeName}, ` +
                      `got ${Array.isArray(dataObj[field]) ? "array" : typeof dataObj[field]}`
                  );
                }
              }
            }
          }

          // Third validation layer: custom validator.
          if (this.validatorName) {
            const validator = this._getValidator();
            if (validator) {
              try {
                validator.validate(validatedData);
                logger.debug(`Custom validator passed: ${this.validatorName}`);
              } catch (ve) {
                throw new Error(`Validator '${this.validatorName}' failed:\n${ve}`);
              }
            }
          }

          response = validatedData;

          // Log the successful validation.
          if (jsonAttempt > 0) {
            logger.info(
              `JSON validation passed (attempt ${jsonAttempt + 1}) - ` +
                `cumulative_prompt_tokens=${allUsage.prompt_tokens}, ` +
                `cumulative_completion_tokens=${allUsage.completion_tokens}, ` +
                `cumulative_total_tokens=${allUsage.total_tokens}, ` +
                `cumulative_cost=¥${totalCostInfo.total_cost.toFixed(4)}`
            );
          } else {
            logger.info("JSON validation passed");
          }

          break;
        } catch (e) {
          logger.warn(
            `JSON validation failed (${jsonAttempt + 1}/${this.jsonRetryMaxAttempts}): ${e} - ` +
              `prompt_tokens=${resultUsage.prompt_tokens}, ` +
              `completion_tokens=${resultUsage.completion_tokens}, ` +
              `total_tokens=${resultUsage.total_tokens}, ` +
              `cost=¥${costInfo.total_cost.toFixed(4)}`
          );

          if (jsonAttempt < this.jsonRetryMaxAttempts - 1) {
            logger.info(
              `Retrying in ${this.jsonRetryDelay} seconds - ` +
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

          logger.error(
            `JSON validation failed after ${this.jsonRetryMaxAttempts} attempts`
          );
          const rawPreview =
            typeof response === "string"
              ? response.slice(0, 200)
              : String(response).slice(0, 200);

          throw new LLMValidationError(
            `JSON validation failed after ${this.jsonRetryMaxAttempts} attempts: ${e}\n` +
              `Response preview: ${rawPreview}\n` +
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
        break;
      }
    }

    return new StepResult(
      this.resolveNextStep(response),
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

  /**
   * Resolve the next step ID. Subclasses may override this for routing logic.
   */
  protected resolveNextStep(_response: unknown): string {
    return this.nextStep;
  }

  /**
   * Add extra formatting instructions for JSON retry attempts.
   */
  private _enhancePromptForJsonRetry(originalPrompt: string, attempt: number): string {
    let enhancement =
      "\n\nImportant:\n" +
      "- Return valid JSON only\n" +
      "- Do not add Markdown code fences such as ```json\n" +
      "- Do not add comments or explanatory text\n" +
      "- Make sure every field matches the required type\n";

    if (attempt > 1) {
      enhancement += `- This is attempt ${attempt + 1}; check the format carefully\n`;
    }

    return originalPrompt + enhancement;
  }
}

// ============================================================
// ConditionalLLMAction
// ============================================================

/**
 * LLM action whose next step comes from a caller-provided condition function.
 *
 * Example routing usage:
 *   const classifier = new ConditionalLLMAction(
 *     "gpt4",
 *     "Detect the language of this text: {text}\nReply only with: Chinese/English/Other",
 *     (response) => {
 *       if (response.includes("Chinese")) return "chinese_pipeline";
 *       if (response.includes("English")) return "english_pipeline";
 *       return "fallback_pipeline";
 *     },
 *     "language"
 *   );
 */
export class ConditionalLLMAction extends LLMCallAction {
  /**
   * Function that receives the model response text and returns the next step ID.
   */
  readonly conditionFunc: (response: string) => string;

  /**
   * @param model Model alias.
   * @param promptTemplate Prompt template.
   * @param conditionFunc Routing function based on the model response.
   * @param outputKey Output key, default "output".
   * @param config Extra configuration.
   */
  constructor(
    model: string,
    promptTemplate: string,
    conditionFunc: (response: string) => string,
    outputKey = "output",
    config: Record<string, unknown> = {}
  ) {
    // The fixed nextStep is unused because resolveNextStep() is overridden.
    super(model, promptTemplate, outputKey, "END", false, undefined, undefined, undefined, undefined, undefined, 3, false, config);
    this.conditionFunc = conditionFunc;
  }

  /**
   * Use the condition function to choose the next step dynamically.
   */
  protected resolveNextStep(response: unknown): string {
    return this.conditionFunc(String(response));
  }
}
