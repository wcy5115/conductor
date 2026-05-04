/**
 * Concurrent orchestration action.
 *
 * ConcurrentAction is the workflow-level concurrent orchestrator.
 * It dispatches a batch of items, such as pages to translate, to sub-steps
 * such as LLM calls or file reads, then collects results and cost data.
 *
 * concurrentProcess() in concurrent_utils.ts provides the lower-level runner.
 * This module handles orchestration: child contexts, sub-step dispatch,
 * resume checks, atomic file writes, and cost aggregation.
 */

// Node's file-system module, used for directories, writes, and existence checks.
import fs from "fs";
// Node's path module, used for path joins and directory names.
import path from "path";
// WorkflowContext stores shared workflow data. StepResult carries the next
// step name, produced data, and metadata after each action finishes.
import { WorkflowContext, StepResult } from "../workflow_engine.js";
// BaseAction provides the shared run(context) wrapper around execute().
import { BaseAction } from "./base.js";
// concurrentProcess is the lower-level concurrent runner. ProcessStats records
// success, failed, skipped counts, and per-item results.
import { concurrentProcess, ProcessStats } from "../concurrent_utils.js";
import {
  getActiveTerminalReporter,
  terminalInternalDebug,
  terminalInternalError,
  terminalInternalInfo,
  terminalInternalWarn,
} from "../core/terminal_reporter.js";
// aggregateCosts combines CostResult values by summing token and cost fields.
import { aggregateCosts, CostResult } from "../cost_calculator.js";
// LLMValidationError carries cost_info so failed validation attempts can still
// be included in API cost accounting.
import { LLMValidationError } from "../exceptions.js";
// LLMCallAction is one supported sub-step type.
import { LLMCallAction } from "./llm_actions.js";
// ReadFileAction is one supported sub-step type.
import { ReadFileAction } from "./io_actions.js";
// Shared helpers for nested data access, cost extraction, error formatting,
// resume validation, atomic writes, and path-template expansion.
import {
  deepGet,
  safeGetCostInfo,
  createZeroCostInfo,
  formatErrorContext,
  isValidOutputFile,
  atomicWriteFileSync,
  formatPathTemplate,
} from "./utils.js";

// Lightweight logger wrapper. This is separate from core/logging.ts,
// which handles workflow-level structured logs.
const logger = {
  info: (msg: string) => terminalInternalInfo(msg),
  warn: (msg: string) => terminalInternalWarn(msg),
  error: (msg: string) => terminalInternalError(msg),
  debug: (msg: string) => terminalInternalDebug(msg),
};

// ============================================================
// Interfaces
// ============================================================

/**
 * Configuration for saving each item result to a file.
 *
 * Each concurrently processed item can optionally be written to its own file.
 * This interface defines the output directory, filename template, and data key.
 *
 * YAML example:
 *   save_to_file:
 *     output_dir: "output/{book_name}/pages"
 *     filename_template: "page_{index:04d}.json"
 *     data_key: "result"
 */
export interface SaveToFileConfig {
  /** Output directory template. Supports placeholders such as "output/{book_name}/pages". */
  output_dir: string;
  /** Filename template. Supports zero-padding formats such as "page_{index:04d}.json". */
  filename_template: string;
  /** Key to read from the child step's context.data before saving, such as "result". */
  data_key: string;
}

/**
 * Sub-step configuration.
 *
 * Describes the sub-step to run for each item in the concurrent batch.
 * The type field selects the Action implementation; the other fields are
 * parameters for that action type.
 *
 * Supported type values:
 *   - "llm_call"      -> creates LLMCallAction
 *   - "read_file"     -> creates ReadFileAction
 *   - "data_process"  -> not supported because Python-style eval is unsafe in TS
 */
export interface ActionConfig {
  /** Sub-step type: "llm_call" | "read_file" | "data_process". */
  type: string;
  /** LLM model name, used only by llm_call. */
  model?: string;
  /** Prompt template, used only by llm_call. */
  prompt_template?: string;
  /** Whether to validate JSON output, used only by llm_call. */
  validate_json?: boolean;
  /** Required JSON fields, used only by llm_call. */
  required_fields?: string[];
  /** JSON validation rules, used only by llm_call. */
  json_rules?: Record<string, unknown>;
  /** Maximum JSON retry attempts, used only by llm_call. */
  json_retry_max_attempts?: number;
  /** Whether to enhance prompts during JSON retries, used only by llm_call. */
  json_retry_enhance_prompt?: boolean;
  /** File path template, used only by read_file. */
  path_template?: string;
  /** Output key where the sub-step stores its result in context.data. */
  output_key?: string;
  /** Temperature, used only by llm_call. */
  temperature?: number;
  /** Maximum token count, used only by llm_call. */
  max_tokens?: number;
  /** API timeout in seconds, used only by llm_call. */
  timeout?: number;
  /** File encoding, used only by read_file. */
  encoding?: string;
  /** Whether a missing file is allowed, used only by read_file. */
  missing_ok?: boolean;
  /** Additional extension settings, such as validator and validator_config. */
  [key: string]: unknown;
}

// ============================================================
// Factory Function
// ============================================================

/**
 * Creates a sub-step Action from configuration.
 *
 * The config.type field selects which Action to create:
 *   - "llm_call"      -> LLMCallAction
 *   - "read_file"     -> ReadFileAction
 *   - "data_process"  -> unsupported and throws
 *
 * @param config Sub-step config read from YAML process_steps.
 * @param workflowDir Directory containing the workflow YAML, for relative paths.
 * @returns Executable BaseAction instance.
 * @throws Error for unknown or unsupported types.
 *
 * Example:
 *   const action = _createActionFromConfig({
 *     type: "llm_call",
 *     model: "deepseek-chat",
 *     prompt_template: "Translate this content: {item}",
 *     validate_json: true,
 *   });
 */
function _createActionFromConfig(
  config: ActionConfig,
  _workflowDir?: string
): BaseAction {
  // Read the sub-step type to decide which Action to create.
  const actionType = config.type;

  if (actionType === "llm_call") {
    // LLM sub-step.
    // model and prompt_template are required.
    if (!config.model) {
      throw new Error("llm_call sub-step is missing required field 'model'");
    }
    if (!config.prompt_template) {
      throw new Error("llm_call sub-step is missing required field 'prompt_template'");
    }

    // Build extra validator-related config for LLMCallAction.
    // These fields are passed through the config object rather than explicit constructor args.
    const extraConfig: Record<string, unknown> = {};
    if (config.validator) extraConfig["validator"] = config.validator;
    if (config.validator_config) extraConfig["validator_config"] = config.validator_config;

    return new LLMCallAction(
      config.model,
      config.prompt_template,
      config.output_key ?? "result",
      "END",
      config.validate_json ?? false,
      config.temperature,
      config.max_tokens,
      config.timeout as number | undefined,
      config.required_fields,
      config.json_rules,
      config.json_retry_max_attempts ?? 3,
      config.json_retry_enhance_prompt ?? false,
      extraConfig,
    );
  }

  if (actionType === "read_file") {
    // File-reading sub-step.
    if (!config.path_template) {
      throw new Error("read_file sub-step is missing required field 'path_template'");
    }

    return new ReadFileAction(
      config.path_template,
      config.output_key ?? "file_content",
      (config.encoding as BufferEncoding) ?? "utf-8",
      config.missing_ok ?? false,
      "END",
    );
  }

  if (actionType === "data_process") {
    // Data processing sub-step.
    // The Python version used eval(), which is unsafe and uncontrolled in TypeScript.
    // Use a future registration mechanism instead.
    throw new Error(
      `data_process is not supported yet. ` +
      `Reason: the Python version used eval(), which is unsafe in TypeScript. ` +
      `Use a registration mechanism after workflow_loader support is available.`
    );
  }

  throw new Error(`Unknown sub-step type: '${actionType}'. Supported types: llm_call, read_file, data_process`);
}

// ============================================================
// ConcurrentAction
// ============================================================

/**
 * Concurrent orchestration action that dispatches items to sub-steps.
 *
 * Flow:
 *   1. Read the items array from context.data[itemsKey].
 *   2. Create the output directory when saveToFile is configured.
 *   3. Initialize the allCosts collection.
 *   4. Build [item, index] tuples.
 *   5. Define processItem for resume checks, child contexts, sub-steps, costs, and writes.
 *   6. Run concurrentProcess().
 *   7. Aggregate all costs.
 *   8. Enforce failOnError.
 *   9. Return StepResult.
 *
 * Typical uses:
 *   - PDF OCR: process page images concurrently
 *   - Batch translation: translate text chunks concurrently
 *   - Batch file reads: read many source files concurrently
 *
 * YAML example:
 *   type: concurrent
 *   items_key: pages
 *   max_concurrent: 5
 *   process_steps:
 *     - type: llm_call
 *       model: deepseek-chat
 *       prompt_template: "Translate: {item}"
 *       validate_json: true
 *   save_to_file:
 *     output_dir: "output/{book_name}"
 *     filename_template: "page_{index:04d}.json"
 *     data_key: result
 */
export class ConcurrentAction extends BaseAction {
  /**
   * Key in context.data that stores the items array.
   * For example, itemsKey = "pages" reads context.data["pages"].
   */
  private readonly itemsKey: string;

  /**
   * Sub-step config list. Usually one step, but multiple serial sub-steps are supported.
   * Each item runs these sub-steps in order.
   */
  private readonly processSteps: ActionConfig[];

  /** Maximum number of items processed at once. Defaults to 5. */
  private readonly maxConcurrent: number;

  /** Initial dispatch delay in seconds, used to smooth API load spikes. */
  private readonly taskDispatchDelay?: number;

  /** Circuit-breaker threshold: stop dispatching after this many consecutive failures. */
  private readonly circuitBreakerThreshold: number;

  /**
   * Key where processed results are stored in context.data.
   * For example, outputKey = "results" stores all results in context.data["results"].
   */
  private readonly outputKey: string;

  /** Optional file-save config. Without it, results remain in memory only. */
  private readonly saveToFile?: SaveToFileConfig;

  /**
   * Whether item failures should throw and stop the workflow.
   *   true  -> throw if any item fails
   *   false -> tolerate failures and continue
   */
  private readonly failOnError: boolean;

  /** Next step name after this action finishes. */
  private readonly nextStep: string;

  /** Step ID used in log output. */
  private readonly stepId: string;

  /** Workflow YAML directory, used to resolve relative save_to_file paths. */
  private readonly workflowDir?: string;

  /**
   * Creates a concurrent orchestration action.
 *
   * @param itemsKey Key in context.data that stores the items array.
   * @param processSteps Sub-step config list.
   * @param maxConcurrent Maximum concurrency. Defaults to 5.
   * @param taskDispatchDelay Initial dispatch delay in seconds.
   * @param circuitBreakerThreshold Circuit-breaker threshold. Defaults to 10.
   * @param outputKey Key where results are stored in context.data. Defaults to "results".
   * @param saveToFile Optional file-save config.
   * @param failOnError Whether failures should throw. Defaults to true.
   * @param nextStep Next step name. Defaults to "END".
   * @param name Optional action name.
   * @param stepId Step ID. Defaults to "concurrent".
   * @param workflowDir Optional workflow directory.
   */
  constructor(
    itemsKey: string,
    processSteps: ActionConfig[],
    maxConcurrent = 5,
    taskDispatchDelay?: number,
    circuitBreakerThreshold = 10,
    outputKey = "results",
    saveToFile?: SaveToFileConfig,
    failOnError = true,
    nextStep = "END",
    name?: string,
    stepId = "concurrent",
    workflowDir?: string,
  ) {
    super(name);
    this.itemsKey = itemsKey;
    this.processSteps = processSteps;
    this.maxConcurrent = maxConcurrent;
    this.taskDispatchDelay = taskDispatchDelay;
    this.circuitBreakerThreshold = circuitBreakerThreshold;
    this.outputKey = outputKey;
    this.saveToFile = saveToFile;
    this.failOnError = failOnError;
    this.nextStep = nextStep;
    this.stepId = stepId;
    this.workflowDir = workflowDir;
  }

  /**
   * Executes the concurrent orchestration flow.
   *
   * @param context Workflow context.
   * @returns StepResult with processed results and aggregated cost metadata.
   */
  async execute(context: WorkflowContext): Promise<StepResult> {
    // ============================================================
    // Step 1: read the items array from context.data
    // ============================================================
    // For itemsKey = "pages", this reads context.data["pages"].
    // Throw a clear error when the key is missing or not an array.
    // Batch timer used to calculate total duration.
    const batchStart = Date.now();
    // Optional structured workflow logger, which may write both .log and .jsonl.
    const slog = context.workflowLogger;

    const rawItems = context.data[this.itemsKey];
    if (!Array.isArray(rawItems)) {
      throw new Error(
        `[Step ${this.stepId}] context.data["${this.itemsKey}"] is not an array. ` +
        `Actual type: ${typeof rawItems}, value: ${JSON.stringify(rawItems)?.slice(0, 100)}`
      );
    }
    // The concrete item type is left to the configured sub-steps.
    const items = rawItems as unknown[];
    const reporter = getActiveTerminalReporter();

    logger.info(
      `[Step ${this.stepId}] Starting concurrent processing for ${items.length} item(s) ` +
      `(concurrency: ${this.maxConcurrent}, circuit breaker: ${this.circuitBreakerThreshold})`
    );

    // ============================================================
    // Step 2: create the output directory when saveToFile is configured
    // ============================================================
    // Output directory templates support placeholders such as "output/{book_name}/pages".
    let outputDir: string | undefined;
    if (this.saveToFile) {
      try {
        outputDir = formatPathTemplate(this.saveToFile.output_dir, context.data);
      } catch (e) {
        throw new Error(
          `[Step ${this.stepId}] Failed to resolve save_to_file.output_dir template: ${e}`
        );
      }
      // recursive: true creates parent directories as needed.
      fs.mkdirSync(outputDir, { recursive: true });
      logger.info(`[Step ${this.stepId}] Output directory: ${outputDir}`);
    }

    // ============================================================
    // Step 3: initialize cost collection
    // ============================================================
    // Each item can append sub-step cost info, then aggregateCosts() combines it.
    const allCosts: CostResult[] = [];

    // ============================================================
    // Step 4: build [item, index] tuples
    // ============================================================
    // processItem needs both the item value and its original list position.
    const itemTuples: Array<[unknown, number]> = items.map(
      (item, idx) => [item, idx]
    );

    // ============================================================
    // Step 5: define processItem
    // ============================================================
    // concurrentProcess calls this once per item.
    // Return format: [ProcessStatus, result]
    //   - "success" + result data
    //   - "skipped" + skip metadata
    //   - "fatal_error" + error description
    const processItem = async (
      tuple: [unknown, number]
    ): Promise<["success" | "skipped" | "fatal_error", unknown]> => {
      const [item, index] = tuple;
      // Per-task timer.
      const taskStart = Date.now();

      // Build a compact label for logs.
      let _label: string;
      if (typeof item === "string") {
        // For file paths, use only the filename.
        const parts = item.replace(/\\/g, "/").split("/");
        _label = parts[parts.length - 1] || item.slice(0, 60);
      } else if (item !== null && typeof item === "object") {
        _label = JSON.stringify(item).slice(0, 60);
      } else {
        _label = String(item).slice(0, 60);
      }

      logger.info(`[Step ${this.stepId}] Starting item [${index + 1}/${items.length}] ${_label}`);

      // ----- Resume check -----
      // If saveToFile is configured, a valid existing output means this item
      // was completed in a previous run and can be skipped.
      if (this.saveToFile && outputDir) {
        try {
          // Use a 1-based index for filenames so numbering matches saved files.
          const filenameVars: Record<string, unknown> = {
            ...context.data,
            item,
            item_index: index,
            index: index + 1,
          };
          const filename = formatPathTemplate(
            this.saveToFile.filename_template,
            filenameVars
          );
          const outputPath = path.join(outputDir, filename);

          // isValidOutputFile uses extension-specific validation:
          //   .json -> parse validation, guarding against partial JSON
          //   .txt and others -> exists and non-empty, relying on atomic writes
          if (isValidOutputFile(outputPath)) {
            logger.debug(
              `[Step ${this.stepId}] Skipping already processed item ${index}: ${outputPath}`
            );
            // Structured log event for resume diagnostics.
            if (slog) {
              slog.logEvent("concurrent_task_skip", {
                step_id: this.stepId,
                index: index + 1,
                total: items.length,
                item: _label,
                reason: "file_exists_and_valid",
                file: outputPath,
              }, "INFO");
            }
            return ["skipped", { saved_file: outputPath, item: String(item) }];
          }
        } catch {
          // If the filename template cannot be resolved, do not skip.
          // This can happen on the first run before variables are available.
        }
      }

      // ----- Child context -----
      // Each item gets an isolated child context to avoid concurrent mutation
      // of the parent context.data. Parent data is copied and item metadata is added.
      const childContext = new WorkflowContext({
        workflowId: `${context.workflowId}_item_${index}`,
        data: {
          ...context.data,
          item,
          item_index: index,
        },
        metadata: { ...context.metadata },
      });

      // ----- Run sub-steps in sequence -----
      // Most configs use one sub-step, but multiple serial sub-steps are supported.
      // Each sub-step's output is merged into childContext.data for the next one.
      for (let stepIdx = 0; stepIdx < this.processSteps.length; stepIdx++) {
        // The loop guarantees stepIdx is in range.
        const stepConfig = this.processSteps[stepIdx]!;
        const stepType = stepConfig.type ?? "unknown";
        const stepStart = Date.now();

        // Create an Action instance from the configured sub-step.
        const action = _createActionFromConfig(stepConfig, this.workflowDir);

        try {
          // action.run() is BaseAction's wrapper around execute().
          const result = await action.run(childContext);

          // Debug-level sub-step duration log.
          const stepElapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
          logger.debug(
            `[Step ${this.stepId}] [${index + 1}] Sub-step ${stepIdx + 1}(${stepType}) completed in ${stepElapsed}s`
          );

          // Merge the sub-step result for later sub-steps or file saving.
          Object.assign(childContext.data, result.data);

          // ----- Collect cost info -----
          // Append cost metadata from sub-steps such as LLM calls.
          const costInfo = safeGetCostInfo(result.metadata);
          if (costInfo && costInfo["pricing_available"]) {
            allCosts.push(costInfo as unknown as CostResult);
          }
        } catch (e) {
          // ----- Lenient mode: skip missing upstream files -----
          // Node uses code === "ENOENT" for missing files.
          // When failOnError is false, missing upstream files skip only this item.
          const isFileNotFound = e instanceof Error
            && (e as NodeJS.ErrnoException).code === "ENOENT";
          if (isFileNotFound && !this.failOnError) {
            const elapsed = ((Date.now() - taskStart) / 1000).toFixed(1);
            logger.warn(
              `[Step ${this.stepId}] [${index + 1}/${items.length}] ${_label} ` +
              `upstream file is missing; skipping automatically (${elapsed}s): ${e}`
            );
            if (slog) {
              slog.logEvent("concurrent_task_skip", {
                step_id: this.stepId,
                index: index + 1,
                total: items.length,
                item: _label,
                reason: "upstream_file_missing",
                error: String(e).slice(0, 200),
                duration: parseFloat(elapsed),
              }, "WARNING");
            }
            return ["skipped", { reason: "upstream_file_missing", item: String(item), index }];
          }

          // Preserve LLM cost even when validation fails.
          if (e instanceof LLMValidationError) {
            const costResult: CostResult = {
              input_cost: e.cost_info.input_cost,
              output_cost: e.cost_info.output_cost,
              total_cost: e.cost_info.total_cost,
              currency: "CNY",
              input_tokens: e.usage_info.prompt_tokens,
              output_tokens: e.usage_info.completion_tokens,
              total_tokens: e.cost_info.total_tokens,
              pricing_available: e.cost_info.pricing_available,
            };
            allCosts.push(costResult);
          }

          // Format a readable error message for logs and stats.
          const elapsed = ((Date.now() - taskStart) / 1000).toFixed(1);
          const errMsg = formatErrorContext(e, item, stepConfig as Record<string, unknown>, index);
          logger.error(
            `[Step ${this.stepId}] [${index + 1}/${items.length}] ${_label} ` +
            `failed (${elapsed}s): ${errMsg}`
          );
          // Structured failure event.
          if (slog) {
            slog.logEvent("concurrent_task_fail", {
              step_id: this.stepId,
              index: index + 1,
              total: items.length,
              item: _label,
              error: errMsg.slice(0, 300),
              error_type: e instanceof Error ? e.constructor.name : "Error",
              duration: parseFloat(elapsed),
            }, "ERROR");
          }

          // concurrentProcess records this fatal error in stats.
          return ["fatal_error", errMsg];
        }
      }

      // ----- Atomic file write -----
      // When saveToFile is configured, write the selected child-context data.
      // Atomic writes avoid leaving partial files after interruptions.
      if (this.saveToFile && outputDir) {
        try {
          // deepGet supports dotted paths, such as data_key = "result.translated_text".
          const dataToSave = deepGet(
            childContext.data,
            this.saveToFile.data_key
          );

          // Build the output filename.
          const filenameVars: Record<string, unknown> = {
            ...childContext.data,
            index: index + 1,
          };
          const filename = formatPathTemplate(
            this.saveToFile.filename_template,
            filenameVars
          );
          const outputPath = path.join(outputDir, filename);

          // Write to a .tmp file and rename it, preventing partial outputs.
          // This is especially important for non-JSON resume checks.
          const content = typeof dataToSave === "string"
            ? dataToSave
            : JSON.stringify(dataToSave, null, 2);
          atomicWriteFileSync(outputPath, content);

          // Log the successful save.
          const elapsed = ((Date.now() - taskStart) / 1000).toFixed(1);
          logger.info(
            `[Step ${this.stepId}] [${index + 1}/${items.length}] ${_label} ` +
            `completed -> ${path.basename(outputPath)} in ${elapsed}s`
          );
          if (slog) {
            slog.logEvent("concurrent_task_done", {
              step_id: this.stepId,
              index: index + 1,
              total: items.length,
              item: _label,
              output_file: outputPath,
              duration: parseFloat(elapsed),
            }, "INFO");
          }

          // Return the saved file path. Cost has already been collected.
          return ["success", { saved_file: outputPath, item: String(item) }];
        } catch (e) {
          // File save failure.
          const elapsed = ((Date.now() - taskStart) / 1000).toFixed(1);
          const errMsg = formatErrorContext(e, item, undefined, index);
          logger.error(
            `[Step ${this.stepId}] [${index + 1}/${items.length}] ${_label} ` +
            `failed to save file (${elapsed}s): ${errMsg}`
          );
          if (slog) {
            slog.logEvent("concurrent_task_fail", {
              step_id: this.stepId,
              index: index + 1,
              total: items.length,
              item: _label,
              error: errMsg.slice(0, 300),
              error_type: "save_file_error",
              duration: parseFloat(elapsed),
            }, "ERROR");
          }
          return ["fatal_error", errMsg];
        }
      }

      // Without saveToFile, return data from the child context.
      const elapsed = ((Date.now() - taskStart) / 1000).toFixed(1);
      logger.info(
        `[Step ${this.stepId}] [${index + 1}/${items.length}] ${_label} completed in ${elapsed}s`
      );
      if (slog) {
        slog.logEvent("concurrent_task_done", {
          step_id: this.stepId,
          index: index + 1,
          total: items.length,
          item: _label,
          duration: parseFloat(elapsed),
        }, "INFO");
      }

      // Use the final sub-step's output_key as the result key.
      const lastStep = this.processSteps[this.processSteps.length - 1];
      const outputData = lastStep !== undefined
        ? childContext.data[lastStep.output_key ?? "result"]
        : childContext.data;

      return ["success", outputData];
    };

    // ============================================================
    // Step 6: run concurrentProcess()
    // ============================================================
    // concurrentProcess handles semaphore concurrency, ramp-up dispatch, and circuit breaking.
    const stats: ProcessStats = await concurrentProcess(
      itemTuples,
      processItem,
      this.maxConcurrent,
      this.taskDispatchDelay,
      `[Step ${this.stepId}] Concurrent processing`,
      this.circuitBreakerThreshold,
      reporter
        ? {
            onBatchStart: (event) => {
              reporter.batchStart({
                stepId: this.stepId,
                stepName: this.name,
                total: event.total,
                concurrency: event.maxConcurrent,
              });
            },
            onItemDone: (event) => {
              reporter.batchItemDone({
                stepId: this.stepId,
                stepName: this.name,
                total: event.total,
                success: event.success,
                failed: event.failed,
                skipped: event.skipped,
                status: event.status,
                itemLabel: event.itemLabel,
              });
            },
            onBatchFinish: (event) => {
              reporter.batchFinish({
                stepId: this.stepId,
                stepName: this.name,
                total: event.total,
                success: event.success,
                failed: event.failed,
                skipped: event.skipped,
                durationSeconds: event.durationSeconds,
                circuitBreakerTriggered: event.circuitBreakerTriggered,
              });
            },
            onCircuitBreaker: () => {
              reporter.warn(
                `Step ${this.stepId} stopped dispatching after repeated failures`
              );
            },
          }
        : undefined,
    );

    // ============================================================
    // Step 7: aggregate costs
    // ============================================================
    // Combine all sub-step cost metadata into a single total.
    const totalCost = allCosts.length > 0
      ? aggregateCosts(allCosts)
      : createZeroCostInfo();

    const batchElapsed = ((Date.now() - batchStart) / 1000).toFixed(1);
    logger.info(
      `[Step ${this.stepId}] Concurrent processing finished: ` +
      `success ${stats.success}, failed ${stats.failed}, skipped ${stats.skipped}, ` +
      `total duration ${batchElapsed}s`
    );

    // List failed tasks for quick diagnosis.
    const failedItems = stats.items.filter(
      (it) => it.status !== "success" && it.status !== "skipped"
    );
    if (failedItems.length > 0) {
      logger.warn(
        `[Step ${this.stepId}] Failed task list (${failedItems.length}):\n` +
        failedItems.map((it) => {
          const errText = it.result && typeof it.result === "object"
            ? String((it.result as Record<string, unknown>)["error"] ?? "Unknown error").slice(0, 120)
            : "Unknown error";
          return `  - ${it.item}: ${errText}`;
        }).join("\n")
      );
    }

    // Write a JSONL batch summary when structured logging is available.
    if (slog) {
      slog.logEvent("concurrent_batch_done", {
        step_id: this.stepId,
        total: stats.total,
        success: stats.success,
        failed: stats.failed,
        skipped: stats.skipped,
        duration: parseFloat(batchElapsed),
        failed_items: failedItems.map((it) => ({
          item: it.item,
          error: (it.result && typeof it.result === "object"
            ? String((it.result as Record<string, unknown>)["error"] ?? "")
            : ""
          ).slice(0, 200),
        })),
      }, failedItems.length > 0 ? "WARNING" : "INFO");
    }

    // ============================================================
    // Step 8: enforce failOnError
    // ============================================================
    // If any item failed and failOnError is true, stop the workflow.
    if (this.failOnError && stats.failed > 0) {
      throw new Error(
        `[Step ${this.stepId}] Concurrent processing had ${stats.failed} failed item(s) ` +
        `(total ${stats.total}). ` +
        `Set fail_on_error: false to ignore failures and continue.`
      );
    }

    // ============================================================
    // Step 9: return StepResult
    // ============================================================
    const hasSavedFile = (result: unknown): boolean =>
      result !== null &&
      typeof result === "object" &&
      typeof (result as Record<string, unknown>)["saved_file"] === "string";

    // Include cached save-to-file skips so resumed runs return a complete output list.
    const results = stats.items
      .filter((r) => r.status === "success" || (r.status === "skipped" && hasSavedFile(r.result)))
      .map((r) => r.result);

    return new StepResult(
      this.nextStep,
      {
        // Result array, keyed by outputKey.
        [this.outputKey]: results,
        // Processing stats for downstream steps or logs.
        [`${this.outputKey}_stats`]: {
          total: stats.total,
          success: stats.success,
          failed: stats.failed,
          skipped: stats.skipped,
          circuit_breaker_triggered: stats.circuitBreakerTriggered,
        },
      },
      {
        // Cost metadata.
        cost: totalCost,
        // Processing stats metadata.
        concurrent_stats: {
          total: stats.total,
          success: stats.success,
          failed: stats.failed,
          skipped: stats.skipped,
        },
      },
    );
  }
}
