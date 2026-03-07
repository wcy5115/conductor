/**
 * 并发编排动作
 *
 * ConcurrentAction 是工作流中的"并发编排器"：
 * 把一批 item（如待翻译的页面列表）分发给子步骤（LLM 调用、文件读取等）并行处理，
 * 最终收集所有结果和成本信息。
 *
 * 底层并发执行器由 concurrent_utils.ts 的 concurrentProcess() 提供，
 * 本模块负责上层编排逻辑：创建子上下文、调度子步骤、断点续存、原子写文件、成本汇总。
 */

// fs 是 Node.js 内置的文件系统模块，用于创建目录、写入文件、检查文件是否存在
import fs from "fs";
// path 是 Node.js 内置的路径处理模块，用于路径拼接（path.join）和取目录名（path.dirname）
import path from "path";
// WorkflowContext 是工作流的全局上下文，context.data 是步骤间共享的数据容器
// StepResult 是每个步骤执行完毕后的返回值，包含：下一步名称、新数据、元数据
import { WorkflowContext, StepResult } from "../workflow_engine.js";
// BaseAction 是所有动作的抽象基类，提供 run(context) 模板方法，子类只需实现 execute()
import { BaseAction } from "./base.js";
// concurrentProcess 是底层并发执行引擎，支持渐进式派发、熔断器、进度跟踪
// ProcessStats 是执行统计结果，包含 success/failed/skipped 计数和每个 item 的详细结果
import { concurrentProcess, ProcessStats } from "../concurrent_utils.js";
// aggregateCosts 将多个 CostResult 对象汇总为一个（求和 tokens 和费用）
// CostResult 是成本信息接口，包含 input/output tokens、费用、是否有定价等字段
import { aggregateCosts, CostResult } from "../cost_calculator.js";
// LLMValidationError 是 LLM 验证失败时抛出的异常，携带 cost_info，
// 确保即使验证失败也能正确统计已消耗的 API 成本
import { LLMValidationError } from "../exceptions.js";
// LLMCallAction 是 LLM 调用动作，作为子步骤工厂的可选类型之一
import { LLMCallAction } from "./llm_actions.js";
// ReadFileAction 是读取文件动作，作为子步骤工厂的可选类型之一
import { ReadFileAction } from "./io_actions.js";
// deepGet 从嵌套对象中按点路径取值，如 "result.text" → obj.result.text
// safeGetCostInfo 安全提取成本信息，兼容多种字段命名，缺失字段自动补零
// createZeroCostInfo 创建全零的成本信息字典，用作默认值
// formatErrorContext 将异常、索引、item 等拼成一行可读的错误日志字符串
// isValidOutputFile 根据文件扩展名选择验证策略（JSON 做解析验证，其他只检查非空），用于断点续存
// atomicWriteFileSync 先写 .tmp 再 rename，避免中断产生半截文件
// formatPathTemplate 将路径模板中的 {key} / {key:04d} 占位符替换为实际值
import {
  deepGet,
  safeGetCostInfo,
  createZeroCostInfo,
  formatErrorContext,
  isValidOutputFile,
  atomicWriteFileSync,
  formatPathTemplate,
} from "./utils.js";

// 简易日志对象：把 console.xxx 包一层，各模块统一用 logger.info() 而非直接 console.info()
// 注意：这与 core/logging.ts 的 StructuredLogger 无关，后者是工作流级别的业务日志
const logger = {
  info: (msg: string) => console.info(msg),
  warn: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
  debug: (msg: string) => console.debug(msg),
};

// ============================================================
// 接口定义
// ============================================================

/**
 * 保存到文件的配置
 *
 * 并发处理的每个 item 结果可选择写入独立的 JSON 文件，
 * 此接口定义了输出目录、文件名模板和要保存的数据键名。
 *
 * 使用示例（YAML 配置）：
 *   save_to_file:
 *     output_dir: "output/{book_name}/pages"
 *     filename_template: "page_{index:04d}.json"
 *     data_key: "result"
 */
export interface SaveToFileConfig {
  /** 输出目录路径模板，支持 {key} 占位符，例如 "output/{book_name}/pages" */
  output_dir: string;
  /** 文件名模板，支持 {index:04d} 零补全格式，例如 "page_{index:04d}.json" */
  filename_template: string;
  /** 从子步骤结果的 context.data 中取哪个键的值来保存，例如 "result" */
  data_key: string;
}

/**
 * 子步骤配置
 *
 * 描述并发处理中每个 item 需要执行的子步骤。
 * type 字段决定创建哪种 Action 实例，其他字段是该类型的参数。
 *
 * 支持的 type 值：
 *   - "llm_call"      → 创建 LLMCallAction（调用 LLM 处理 item）
 *   - "read_file"     → 创建 ReadFileAction（读取文件内容）
 *   - "data_process"  → 暂不支持（Python 版用 eval 执行，TS 中不安全）
 */
export interface ActionConfig {
  /** 子步骤类型："llm_call" | "read_file" | "data_process" */
  type: string;
  /** LLM 模型名称（仅 llm_call 类型使用） */
  model?: string;
  /** Prompt 模板字符串（仅 llm_call 类型使用） */
  prompt_template?: string;
  /** 是否验证 JSON 格式输出（仅 llm_call 类型使用） */
  validate_json?: boolean;
  /** JSON 必填字段列表（仅 llm_call 类型使用） */
  required_fields?: string[];
  /** JSON 验证规则（仅 llm_call 类型使用） */
  json_rules?: Record<string, unknown>;
  /** JSON 重试最大次数（仅 llm_call 类型使用） */
  json_retry_max_attempts?: number;
  /** JSON 重试时是否增强 prompt（仅 llm_call 类型使用） */
  json_retry_enhance_prompt?: boolean;
  /** 文件路径模板（仅 read_file 类型使用） */
  path_template?: string;
  /** 输出键名（子步骤结果存入 context.data 的键名） */
  output_key?: string;
  /** 温度参数（仅 llm_call 类型使用） */
  temperature?: number;
  /** 最大 token 数（仅 llm_call 类型使用） */
  max_tokens?: number;
  /** API 调用超时时间秒数（仅 llm_call 类型使用） */
  timeout?: number;
  /** 文件编码（仅 read_file 类型使用） */
  encoding?: string;
  /** 文件不存在时是否容忍（仅 read_file 类型使用） */
  missing_ok?: boolean;
  /** 其他扩展配置项（如 validator、validator_config 等） */
  [key: string]: unknown;
}

// ============================================================
// 工厂函数
// ============================================================

/**
 * 根据配置创建子步骤 Action 实例
 *
 * 这是一个工厂函数，根据 config.type 字段决定创建哪种 Action：
 *   - "llm_call"      → LLMCallAction（调用 LLM）
 *   - "read_file"     → ReadFileAction（读取文件）
 *   - "data_process"  → 暂不支持，抛出错误
 *
 * @param config     子步骤配置（从 YAML 的 process_steps 中读取）
 * @param workflowDir 工作流 YAML 所在目录，用于解析相对路径
 * @returns 可执行的 BaseAction 实例
 * @throws Error 未知的 type 或暂不支持的 type
 *
 * 使用示例：
 *   const action = _createActionFromConfig({
 *     type: "llm_call",
 *     model: "deepseek-chat",
 *     prompt_template: "翻译以下内容：{item}",
 *     validate_json: true,
 *   });
 */
function _createActionFromConfig(
  config: ActionConfig,
  _workflowDir?: string
): BaseAction {
  // 取出子步骤类型，决定创建哪种 Action
  const actionType = config.type;

  if (actionType === "llm_call") {
    // ====== LLM 调用子步骤 ======
    // 必填字段检查：model 和 prompt_template 缺一不可
    if (!config.model) {
      throw new Error("llm_call 子步骤缺少必填字段 'model'");
    }
    if (!config.prompt_template) {
      throw new Error("llm_call 子步骤缺少必填字段 'prompt_template'");
    }

    // 构建传给 LLMCallAction 的额外配置（validator 相关字段）
    // 这些字段不在 LLMCallAction 构造函数的显式参数中，而是通过 config 字典传入
    const extraConfig: Record<string, unknown> = {};
    if (config.validator) extraConfig["validator"] = config.validator;
    if (config.validator_config) extraConfig["validator_config"] = config.validator_config;

    return new LLMCallAction(
      config.model,
      config.prompt_template,
      config.output_key ?? "result",       // 子步骤结果存入 context.data 的键名
      "END",                                // nextStep 固定为 "END"，因为子步骤不需要链式跳转
      config.validate_json ?? false,        // 是否验证 JSON 格式
      config.temperature,                   // 温度参数（可选）
      config.max_tokens,                    // 最大 token 数（可选）
      config.timeout as number | undefined, // API 超时时间（可选）
      config.required_fields,               // JSON 必填字段列表（可选）
      config.json_rules,                    // JSON 验证规则（可选）
      config.json_retry_max_attempts ?? 3,  // JSON 重试最大次数
      config.json_retry_enhance_prompt ?? false, // 重试时是否增强 prompt
      extraConfig,                          // 额外配置（validator 等）
    );
  }

  if (actionType === "read_file") {
    // ====== 文件读取子步骤 ======
    if (!config.path_template) {
      throw new Error("read_file 子步骤缺少必填字段 'path_template'");
    }

    return new ReadFileAction(
      config.path_template,
      config.output_key ?? "file_content", // 读取内容存入的键名
      (config.encoding as BufferEncoding) ?? "utf-8",
      config.missing_ok ?? false,          // 文件不存在时是否容忍
      "END",                                // nextStep 固定为 "END"
    );
  }

  if (actionType === "data_process") {
    // ====== 数据处理子步骤 ======
    // Python 版使用 eval() 动态执行用户代码，在 TypeScript 中不安全且不可控。
    // 等 workflow_loader 迁移后，改用注册机制（用户预先注册处理函数，YAML 中引用函数名）。
    throw new Error(
      `data_process 类型暂不支持。` +
      `原因：Python 版使用 eval() 执行，TS 中不安全。` +
      `请等待 workflow_loader 迁移后使用注册机制替代。`
    );
  }

  // 未知类型，直接报错
  throw new Error(`未知的子步骤类型: '${actionType}'，支持的类型: llm_call, read_file, data_process`);
}

// ============================================================
// ConcurrentAction — 并发编排动作
// ============================================================

/**
 * 并发编排动作 —— 把一批 item 分发给子步骤并行处理
 *
 * 工作原理（九步流程）：
 *   1. 从 context.data[itemsKey] 取出待处理的 items 数组
 *   2. 如果配了 saveToFile，创建输出目录
 *   3. 初始化 allCosts 成本收集数组
 *   4. 构建 [item, index] 元组列表
 *   5. 定义 processItem 函数（断点续存 → 创建子上下文 → 执行子步骤 → 收集成本 → 原子写文件）
 *   6. 调用 concurrentProcess() 批量并发执行
 *   7. aggregateCosts() 汇总所有成本
 *   8. failOnError 检查（如果有失败且 failOnError=true，抛出错误）
 *   9. 返回 StepResult
 *
 * 典型使用场景：
 *   - PDF OCR：并发处理每一页的图片识别
 *   - 批量翻译：并发调用 LLM 翻译每个文本段落
 *   - 批量文件读取：并发读取多个源文件
 *
 * YAML 配置示例：
 *   type: concurrent
 *   items_key: pages
 *   max_concurrent: 5
 *   process_steps:
 *     - type: llm_call
 *       model: deepseek-chat
 *       prompt_template: "翻译：{item}"
 *       validate_json: true
 *   save_to_file:
 *     output_dir: "output/{book_name}"
 *     filename_template: "page_{index:04d}.json"
 *     data_key: result
 */
export class ConcurrentAction extends BaseAction {
  /**
   * context.data 中存放 items 数组的键名
   * 例如 itemsKey = "pages"，则从 context.data["pages"] 取出待处理列表
   */
  private readonly itemsKey: string;

  /**
   * 子步骤配置列表（通常只有一个，但支持多个串行子步骤）
   * 每个 item 会依次执行这些子步骤
   */
  private readonly processSteps: ActionConfig[];

  /** 最大并发数，控制同时处理多少个 item，默认 5 */
  private readonly maxConcurrent: number;

  /** 初始任务派发延迟（秒），平滑 API 调用的负载峰值，默认读取环境变量 */
  private readonly taskDispatchDelay?: number;

  /** 熔断器阈值：连续失败多少次后停止派发新任务，默认 10 */
  private readonly circuitBreakerThreshold: number;

  /**
   * 处理结果存入 context.data 的键名
   * 例如 outputKey = "results"，则最终 context.data["results"] 是所有结果的数组
   */
  private readonly outputKey: string;

  /** 保存到文件的配置（可选），不配置则结果只存在内存中 */
  private readonly saveToFile?: SaveToFileConfig;

  /**
   * 是否在有失败项时抛出错误中断工作流
   *   true  → 有任何 item 处理失败就抛出 Error（默认）
   *   false → 容忍失败，继续执行后续步骤
   */
  private readonly failOnError: boolean;

  /** 执行完毕后跳转到的下一步骤名称 */
  private readonly nextStep: string;

  /** 步骤 ID，用于日志输出中的标识 */
  private readonly stepId: string;

  /** 工作流 YAML 所在目录，用于解析 save_to_file 中的相对路径 */
  private readonly workflowDir?: string;

  /**
   * 构造并发编排动作
   *
   * @param itemsKey               context.data 中存放 items 数组的键名
   * @param processSteps           子步骤配置列表
   * @param maxConcurrent          最大并发数（默认 5）
   * @param taskDispatchDelay      初始派发延迟秒数（可选）
   * @param circuitBreakerThreshold 熔断阈值（默认 10）
   * @param outputKey              结果存入 context.data 的键名（默认 "results"）
   * @param saveToFile             保存到文件的配置（可选）
   * @param failOnError            有失败时是否抛错（默认 true）
   * @param nextStep               下一步骤名称（默认 "END"）
   * @param name                   动作名称（可选，默认类名）
   * @param stepId                 步骤 ID（默认 "concurrent"）
   * @param workflowDir            工作流目录（可选）
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
   * 执行并发编排（核心方法，九步流程）
   *
   * @param context 工作流上下文
   * @returns StepResult，包含所有处理结果和汇总成本
   */
  async execute(context: WorkflowContext): Promise<StepResult> {
    // ============================================================
    // 第一步：从 context.data 取出待处理的 items 数组
    // ============================================================
    // 例如 itemsKey = "pages"，则 items = context.data["pages"]
    // 如果键不存在或值不是数组，抛出明确的错误
    // 批次计时起点，用于在处理结束时计算总耗时
    const batchStart = Date.now();
    // 获取结构化日志记录器（同时写 .log 和 .jsonl），可能为 null
    const slog = context.workflowLogger;

    const rawItems = context.data[this.itemsKey];
    if (!Array.isArray(rawItems)) {
      throw new Error(
        `[步骤${this.stepId}] context.data["${this.itemsKey}"] 不是数组，` +
        `实际类型: ${typeof rawItems}，值: ${JSON.stringify(rawItems)?.slice(0, 100)}`
      );
    }
    // 类型断言为 unknown[]，后续处理时每个 item 的具体类型由子步骤自行解释
    const items = rawItems as unknown[];

    logger.info(
      `[步骤${this.stepId}] 开始并发处理 ${items.length} 个项目 ` +
      `(并发数: ${this.maxConcurrent}, 熔断阈值: ${this.circuitBreakerThreshold})`
    );

    // ============================================================
    // 第二步：创建输出目录（如果配置了 saveToFile）
    // ============================================================
    // 输出目录路径支持占位符，例如 "output/{book_name}/pages"
    // formatPathTemplate 会将 {book_name} 替换为 context.data["book_name"] 的实际值
    let outputDir: string | undefined;
    if (this.saveToFile) {
      try {
        outputDir = formatPathTemplate(this.saveToFile.output_dir, context.data);
      } catch (e) {
        throw new Error(
          `[步骤${this.stepId}] save_to_file.output_dir 模板解析失败: ${e}`
        );
      }
      // recursive: true 表示如果父目录不存在则自动递归创建
      fs.mkdirSync(outputDir, { recursive: true });
      logger.info(`[步骤${this.stepId}] 输出目录: ${outputDir}`);
    }

    // ============================================================
    // 第三步：初始化成本收集数组
    // ============================================================
    // 每个 item 处理完后，如果子步骤产生了成本信息（如 LLM 调用），就追加到这里
    // 最终用 aggregateCosts() 汇总为一个总成本
    const allCosts: CostResult[] = [];

    // ============================================================
    // 第四步：构建 [item, index] 元组列表
    // ============================================================
    // concurrentProcess 需要一个数组作为输入，这里把每个 item 和它的索引打包在一起，
    // 方便 processItem 函数内部同时获取 item 内容和它在原始列表中的位置
    const itemTuples: Array<[unknown, number]> = items.map(
      (item, idx) => [item, idx]
    );

    // ============================================================
    // 第五步：定义 processItem 函数
    // ============================================================
    // 这个函数会被 concurrentProcess 并发调用，每个 item 执行一次
    // 返回值格式：[ProcessStatus, result]
    //   - "success" + 结果数据
    //   - "skipped" + null（断点续存跳过）
    //   - "fatal_error" + 错误描述
    const processItem = async (
      tuple: [unknown, number]
    ): Promise<["success" | "skipped" | "fatal_error", unknown]> => {
      const [item, index] = tuple;
      // 任务计时起点
      const taskStart = Date.now();

      // 生成简洁的任务标签（文件路径取文件名、长字符串截断等）
      let _label: string;
      if (typeof item === "string") {
        // 文件路径只取文件名部分
        const parts = item.replace(/\\/g, "/").split("/");
        _label = parts[parts.length - 1] || item.slice(0, 60);
      } else if (item !== null && typeof item === "object") {
        _label = JSON.stringify(item).slice(0, 60);
      } else {
        _label = String(item).slice(0, 60);
      }

      logger.info(`[步骤${this.stepId}] 开始处理 [${index + 1}/${items.length}] ${_label}`);

      // ----- 断点续存检查 -----
      // 如果配置了 saveToFile，检查输出文件是否已经存在且有效
      // 如果文件已存在，说明之前的运行已经处理过这个 item，直接跳过
      // 这是"断点续存"的核心机制：中断后重新运行时，已完成的 item 不会重复处理
      if (this.saveToFile && outputDir) {
        try {
          // 构建文件名模板的变量：index 是 1-based（与文件编号对齐）
          const filenameVars: Record<string, unknown> = {
            ...context.data,
            item,
            item_index: index,
            index: index + 1,  // 1-based 编号，与保存文件时一致
          };
          const filename = formatPathTemplate(
            this.saveToFile.filename_template,
            filenameVars
          );
          const outputPath = path.join(outputDir, filename);

          // isValidOutputFile 根据扩展名选择验证策略：
          //   .json → 解析验证（防止半截 JSON）
          //   .txt 等 → 只检查存在且非空（需配合原子写入保证完整性）
          if (isValidOutputFile(outputPath)) {
            logger.debug(
              `[步骤${this.stepId}] 跳过已处理项目 ${index}: ${outputPath}`
            );
            // 结构化日志：记录跳过事件，方便排查断点续存行为
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
            return ["skipped", null];
          }
        } catch {
          // 文件名模板解析失败时不跳过，继续正常处理
          // 这种情况可能是首次运行，变量还没有值
        }
      }

      // ----- 创建子上下文 -----
      // 每个 item 有自己独立的子上下文，避免并发修改同一个 context.data
      // 子上下文继承父上下文的所有数据，额外注入 item 和 item_index
      const childContext = new WorkflowContext({
        workflowId: `${context.workflowId}_item_${index}`,
        data: {
          ...context.data,          // 继承父上下文的所有数据
          item,                      // 当前正在处理的 item
          item_index: index,         // 0-based 索引
        },
        metadata: { ...context.metadata },
      });

      // ----- 依次执行子步骤 -----
      // processSteps 通常只有一个（如一次 LLM 调用），但支持多个串行子步骤
      // 每个子步骤的输出会合并进 childContext.data，供下一个子步骤使用
      for (let stepIdx = 0; stepIdx < this.processSteps.length; stepIdx++) {
        // 非空断言（!）：stepIdx 由 for 循环保证在 [0, length) 范围内
        const stepConfig = this.processSteps[stepIdx]!;
        const stepType = stepConfig.type ?? "unknown";
        const stepStart = Date.now();

        // 用工厂函数根据配置创建 Action 实例
        const action = _createActionFromConfig(stepConfig, this.workflowDir);

        try {
          // action.run() 是 BaseAction 的模板方法：计时 → execute() → 注入元数据
          const result = await action.run(childContext);

          // 子步骤耗时日志（debug 级别，不干扰正常输出）
          const stepElapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
          logger.debug(
            `[步骤${this.stepId}] [${index + 1}] 子步骤${stepIdx + 1}(${stepType}) 完成 耗时${stepElapsed}s`
          );

          // 将子步骤结果合并进子上下文，供后续子步骤或文件保存使用
          Object.assign(childContext.data, result.data);

          // ----- 收集成本信息 -----
          // 如果子步骤返回了成本信息（如 LLM 调用的 token 用量），追加到 allCosts
          const costInfo = safeGetCostInfo(result.metadata);
          if (costInfo && costInfo["pricing_available"]) {
            allCosts.push(costInfo as unknown as CostResult);
          }
        } catch (e) {
          // ----- 宽松模式：上游文件缺失时自动跳过此项 -----
          // Node.js 的文件未找到错误携带 code === "ENOENT"，等价于 Python 的 FileNotFoundError
          // 当 failOnError 为 false 时，缺失文件不应中断整个批次，只需跳过当前 item
          // 典型场景：上一步骤只成功处理了部分文件，本步骤并发读取时部分文件不存在
          const isFileNotFound = e instanceof Error
            && (e as NodeJS.ErrnoException).code === "ENOENT";
          if (isFileNotFound && !this.failOnError) {
            const elapsed = ((Date.now() - taskStart) / 1000).toFixed(1);
            logger.warn(
              `[步骤${this.stepId}] [${index + 1}/${items.length}] ${_label} ` +
              `上游文件缺失，自动跳过(耗时${elapsed}s): ${e}`
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

          // 捕获 LLMValidationError 时，即使失败也要记录已消耗的成本
          if (e instanceof LLMValidationError) {
            // LLMValidationError 携带 cost_info，确保重试成本不丢失
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

          // 格式化错误上下文，生成可读的日志消息
          const elapsed = ((Date.now() - taskStart) / 1000).toFixed(1);
          const errMsg = formatErrorContext(e, item, stepConfig as Record<string, unknown>, index);
          logger.error(
            `[步骤${this.stepId}] [${index + 1}/${items.length}] ${_label} ` +
            `失败(耗时${elapsed}s): ${errMsg}`
          );
          // 结构化日志：记录失败事件
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

          // 返回 fatal_error，concurrentProcess 会记录到 stats 中
          return ["fatal_error", errMsg];
        }
      }

      // ----- 原子写文件 -----
      // 如果配了 saveToFile，把子上下文中指定键的数据写入 JSON 文件
      // "原子写"是指：先写入完整内容再关闭文件，避免写到一半中断产生损坏文件
      if (this.saveToFile && outputDir) {
        try {
          // 从子上下文中取出要保存的数据
          // deepGet 支持点路径，如 data_key = "result.translated_text"
          const dataToSave = deepGet(
            childContext.data,
            this.saveToFile.data_key
          );

          // 构建文件名
          const filenameVars: Record<string, unknown> = {
            ...childContext.data,
            index: index + 1,  // 1-based 编号
          };
          const filename = formatPathTemplate(
            this.saveToFile.filename_template,
            filenameVars
          );
          const outputPath = path.join(outputDir, filename);

          // 原子写入：先写 .tmp 再 rename，避免中断产生半截文件
          // 这对非 JSON 文件尤其重要——断点续存时只检查"存在且非空"，
          // 如果没有原子写入，半截的 .txt 文件会被误判为有效
          const content = typeof dataToSave === "string"
            ? dataToSave
            : JSON.stringify(dataToSave, null, 2);
          atomicWriteFileSync(outputPath, content);

          // 保存成功：记录耗时和输出文件名
          const elapsed = ((Date.now() - taskStart) / 1000).toFixed(1);
          logger.info(
            `[步骤${this.stepId}] [${index + 1}/${items.length}] ${_label} ` +
            `完成 → ${path.basename(outputPath)} 耗时${elapsed}s`
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

          // 返回文件路径（成本已收集到 allCosts）
          return ["success", { saved_file: outputPath, item: String(item) }];
        } catch (e) {
          // 文件保存失败
          const elapsed = ((Date.now() - taskStart) / 1000).toFixed(1);
          const errMsg = formatErrorContext(e, item, undefined, index);
          logger.error(
            `[步骤${this.stepId}] [${index + 1}/${items.length}] ${_label} ` +
            `保存文件失败(耗时${elapsed}s): ${errMsg}`
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

      // 没有配置 saveToFile 时，返回子上下文中的数据
      const elapsed = ((Date.now() - taskStart) / 1000).toFixed(1);
      logger.info(
        `[步骤${this.stepId}] [${index + 1}/${items.length}] ${_label} 完成 耗时${elapsed}s`
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

      // 取最后一个子步骤的 output_key 作为结果键名
      const lastStep = this.processSteps[this.processSteps.length - 1];
      const outputData = lastStep !== undefined
        ? childContext.data[lastStep.output_key ?? "result"]
        : childContext.data;

      return ["success", outputData];
    };

    // ============================================================
    // 第六步：调用 concurrentProcess() 批量并发执行
    // ============================================================
    // concurrentProcess 内部实现：信号量控制并发数 + 渐进式派发 + 熔断器
    const stats: ProcessStats = await concurrentProcess(
      itemTuples,
      processItem,
      this.maxConcurrent,
      this.taskDispatchDelay,
      `[步骤${this.stepId}] 并发处理`,
      this.circuitBreakerThreshold,
    );

    // ============================================================
    // 第七步：汇总成本
    // ============================================================
    // 将所有子步骤的成本信息合并为一个总计
    const totalCost = allCosts.length > 0
      ? aggregateCosts(allCosts)
      : createZeroCostInfo();

    const batchElapsed = ((Date.now() - batchStart) / 1000).toFixed(1);
    logger.info(
      `[步骤${this.stepId}] 并发处理完成: ` +
      `成功 ${stats.success}, 失败 ${stats.failed}, 跳过 ${stats.skipped} ` +
      `总耗时 ${batchElapsed}s`
    );

    // 列出失败任务清单，方便快速定位问题
    const failedItems = stats.items.filter(
      (it) => it.status !== "success" && it.status !== "skipped"
    );
    if (failedItems.length > 0) {
      logger.warn(
        `[步骤${this.stepId}] 失败任务列表 (${failedItems.length}个):\n` +
        failedItems.map((it) => {
          const errText = it.result && typeof it.result === "object"
            ? String((it.result as Record<string, unknown>)["error"] ?? "未知错误").slice(0, 120)
            : "未知错误";
          return `  - ${it.item}: ${errText}`;
        }).join("\n")
      );
    }

    // 写入 JSONL 批次汇总
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
    // 第八步：failOnError 检查
    // ============================================================
    // 如果有失败的 item 且 failOnError=true，抛出错误中断工作流
    if (this.failOnError && stats.failed > 0) {
      throw new Error(
        `[步骤${this.stepId}] 并发处理中有 ${stats.failed} 个项目失败 ` +
        `(总计 ${stats.total} 个)。` +
        `设置 fail_on_error: false 可忽略失败继续执行。`
      );
    }

    // ============================================================
    // 第九步：返回 StepResult
    // ============================================================
    // 收集所有成功项目的结果到数组中
    const results = stats.items
      .filter((r) => r.status === "success")
      .map((r) => r.result);

    return new StepResult(
      this.nextStep,
      {
        // 处理结果数组，键名由 outputKey 决定
        [this.outputKey]: results,
        // 处理统计信息，供后续步骤或日志使用
        [`${this.outputKey}_stats`]: {
          total: stats.total,
          success: stats.success,
          failed: stats.failed,
          skipped: stats.skipped,
          circuit_breaker_triggered: stats.circuitBreakerTriggered,
        },
      },
      {
        // 元数据：成本信息
        cost: totalCost,
        // 元数据：处理统计
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
