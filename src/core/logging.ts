/**
 * 结构化日志系统（Structured Logger）
 *
 * 本模块提供了一个基于事件的结构化日志记录器，用于记录工作流执行过程中的各类事件。
 * 与传统的"拼接字符串然后 console.log"不同，这里每条日志都是一个结构化的事件对象，
 * 方便后续做日志分析、成本统计、性能监控等。
 *
 * 双输出架构：
 *   1. 机器可读日志（workflow.jsonl）—— 每行一个 JSON 对象，方便程序解析和分析
 *      示例行：{"timestamp":"2024-01-01T12:00:00.000Z","level":"INFO","event_type":"step_start",...}
 *   2. 人类可读日志（workflow.log）—— 传统的文本格式，方便开发者直接查看
 *      示例行：[2024-01-01 12:00:00] INFO: [STEP] 步骤 step1 开始: PDF转图片
 *   3. 控制台输出 —— 与人类可读日志类似，实时显示在终端
 *
 * JSONL 格式说明：
 *   JSONL（JSON Lines）是一种文本格式，每行是一个独立的 JSON 对象。
 *   相比普通 JSON 文件（整个文件是一个数组），JSONL 的优势：
 *     - 可以逐行追加写入（append），无需读取整个文件
 *     - 可以逐行解析，处理大文件时不占用大量内存
 *     - 文件损坏时只影响损坏的行，其余行仍可解析
 */

// fs 是 Node.js 内置的文件系统模块
// 这里用到：fs.mkdirSync（创建目录）、fs.createWriteStream（创建写入流）
import * as fs from "fs";
// path 是 Node.js 内置的路径处理模块
// 这里用到：path.join（路径拼接）、path.basename（提取文件名）
import * as path from "path";

// ========================================
// 枚举定义
// ========================================

/**
 * 日志级别枚举
 *
 * 从低到高排列，级别越高表示事件越重要/严重。
 * 日志系统会根据配置的阈值级别过滤输出——
 * 例如设置 consoleLevel = WARNING，则 DEBUG 和 INFO 级别的日志不会在控制台显示。
 *
 * DEBUG:    调试信息，仅在排查问题时需要（如文件读写操作的详细信息）
 * INFO:     一般运行信息（如步骤开始/结束、工作流启动）
 * WARNING:  警告，不影响运行但需要注意（如 API 响应缺少 usage 字段）
 * ERROR:    错误，某个操作失败但程序仍可继续（如单个步骤执行失败）
 * CRITICAL: 致命错误，程序无法继续运行（如配置文件缺失、认证失败）
 */
export enum LogLevel {
  DEBUG = "DEBUG",
  INFO = "INFO",
  WARNING = "WARNING",
  ERROR = "ERROR",
  CRITICAL = "CRITICAL",
}

/**
 * 事件类型枚举
 *
 * 每条日志都属于一个事件类型，用于分类和过滤。
 * 这些类型覆盖了工作流执行的完整生命周期：
 *
 * WORKFLOW_START:  工作流开始执行
 * WORKFLOW_END:    工作流执行结束（成功或失败）
 * STEP_START:      单个步骤开始执行
 * STEP_END:        单个步骤执行结束
 * LLM_CALL:        一次 LLM API 调用（记录模型、token 用量、花费）
 * FILE_OPERATION:  文件操作（读取、写入、删除等）
 * ERROR:           错误事件
 * METRIC:          性能指标（如耗时、吞吐量）
 * CUSTOM:          自定义事件（不属于以上类型的通用日志）
 */
export enum EventType {
  WORKFLOW_START = "workflow_start",
  WORKFLOW_END = "workflow_end",
  STEP_START = "step_start",
  STEP_END = "step_end",
  LLM_CALL = "llm_call",
  FILE_OPERATION = "file_operation",
  ERROR = "error",
  METRIC = "metric",
  CUSTOM = "custom",
}

// ========================================
// 类型定义
// ========================================

/**
 * 日志事件的数据结构
 *
 * 每条日志本质上是一个 LogEvent 对象，序列化为 JSON 后写入 JSONL 文件。
 *
 * timestamp:  ISO 8601 格式的时间戳，如 "2024-01-01T12:00:00.000Z"
 * level:      日志级别（"DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL"）
 * event_type: 事件类型（见 EventType 枚举）
 * data:       事件携带的数据（不同事件类型有不同的 data 内容）
 *             类型 Record<string, unknown> 等价于 Python 的 dict[str, Any]
 * [key: string]: unknown — 允许合并上下文字段（通过 setContext 设置的全局字段）
 *
 * 示例（一条 STEP_END 事件）：
 *   {
 *     timestamp: "2024-01-01T12:00:05.000Z",
 *     level: "INFO",
 *     event_type: "step_end",
 *     data: { step_id: "step1", duration: 5.23, cost: { total_cost: 0.0012 } },
 *     workflow_name: "ocr_pipeline"    ← 这是通过 setContext 注入的上下文字段
 *   }
 */
export interface LogEvent {
  timestamp: string;
  level: string;
  event_type: string;
  data: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * StructuredLogger 构造函数的选项
 *
 * logDir:          日志文件存放目录，默认 "logs"
 * consoleLevel:    控制台输出的最低级别，默认 INFO（不显示 DEBUG）
 * fileLevel:       文件输出的最低级别，默认 DEBUG（全部记录）
 * enableConsole:   是否启用控制台输出，默认 true
 * enableSystemLog: 是否启用机器可读日志（workflow.jsonl），默认 true
 * enableHumanLog:  是否启用人类可读日志（workflow.log），默认 true
 */
export interface StructuredLoggerOptions {
  logDir?: string;
  consoleLevel?: LogLevel;
  fileLevel?: LogLevel;
  enableConsole?: boolean;
  enableSystemLog?: boolean;
  enableHumanLog?: boolean;
}

// ========================================
// 日志级别优先级（用于过滤）
// ========================================

/**
 * 日志级别的数值优先级映射
 *
 * 数值越大表示级别越高。用于 shouldLog() 函数判断某条日志是否应该输出。
 * 例如：consoleLevel 设为 WARNING(30)，则只有 WARNING(30)、ERROR(40)、CRITICAL(50)
 *       级别的日志会在控制台显示，DEBUG(10) 和 INFO(20) 会被过滤掉。
 */
const LEVEL_PRIORITY: Record<string, number> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
  CRITICAL: 50,
};

/**
 * 判断某条日志是否应该输出
 *
 * @param messageLevel 这条日志的级别（如 "INFO"）
 * @param threshold    输出阈值（如 LogLevel.WARNING）
 * @returns true 表示应该输出，false 表示应该过滤掉
 *
 * 示例：
 *   shouldLog("DEBUG", LogLevel.INFO)     → false（10 < 20，被过滤）
 *   shouldLog("WARNING", LogLevel.INFO)   → true （30 ≥ 20，输出）
 *   shouldLog("ERROR", LogLevel.WARNING)  → true （40 ≥ 30，输出）
 */
function shouldLog(messageLevel: string, threshold: LogLevel): boolean {
  // ?? 0 是防御性编码：如果传入了未知的级别字符串，默认优先级为 0（最低）
  return (LEVEL_PRIORITY[messageLevel] ?? 0) >= (LEVEL_PRIORITY[threshold] ?? 0);
}

// ========================================
// StructuredLogger 类
// ========================================

/**
 * 结构化日志记录器
 *
 * 这是日志系统的核心类，提供三层 API：
 *
 * 第一层 —— 底层核心方法：
 *   logEvent()  接收原始事件数据，分发到三个输出目标
 *
 * 第二层 —— 通用便捷方法（按级别）：
 *   debug() / info() / warning() / error()  自动设置对应级别
 *
 * 第三层 —— 领域事件方法（按业务含义）：
 *   workflowStart() / workflowEnd()  —— 工作流生命周期
 *   stepStart() / stepEnd()          —— 步骤生命周期
 *   llmCall()                        —— LLM 调用记录
 *   fileOperation()                  —— 文件操作记录
 *
 * 使用示例：
 *   // 创建日志器，日志文件存放在 data/project/logs/ 目录
 *   const logger = new StructuredLogger({ logDir: "data/project/logs" });
 *
 *   // 记录工作流开始
 *   logger.workflowStart("ocr_pipeline", { input: "document.pdf" });
 *
 *   // 记录步骤开始和结束
 *   logger.stepStart("step1", "PDF转图片", { pdf: "document.pdf" });
 *   logger.stepEnd("step1", { images: 20 }, { total_cost: 0 }, 5.23);
 *
 *   // 记录 LLM 调用
 *   logger.llmCall("gpt-4o", 1500, 500, 0.0125, "step2");
 *
 *   // 完成后关闭（释放文件流）
 *   logger.close();
 */
export class StructuredLogger {
  // ---- 配置字段 ----

  /** 日志文件存放目录的路径 */
  private logDir: string;
  /** 控制台输出的最低日志级别（低于此级别的不在控制台显示） */
  private consoleLevel: LogLevel;
  /** 文件输出的最低日志级别（低于此级别的不写入 workflow.log） */
  private fileLevel: LogLevel;
  /** 是否启用控制台输出 */
  private enableConsole: boolean;
  /** 是否启用机器可读日志文件（workflow.jsonl） */
  private enableSystemLog: boolean;
  /** 是否启用人类可读日志文件（workflow.log） */
  private enableHumanLog: boolean;

  // ---- 文件写入流 ----

  /**
   * 系统日志的写入流（workflow.jsonl）
   *
   * fs.WriteStream 是 Node.js 的可写流，调用 .write() 将数据写入文件。
   * 使用流（而非每次 fs.writeFileSync）的好处：
   *   - 不需要每次写入都打开和关闭文件，性能更好
   *   - 数据会先缓冲在内存中，批量写入磁盘，减少 I/O 次数
   *   - 非阻塞，不会卡住主线程
   */
  private systemLogStream: fs.WriteStream | null = null;
  /** 人类可读日志的写入流（workflow.log） */
  private humanLogStream: fs.WriteStream | null = null;

  // ---- 上下文 ----

  /**
   * 全局上下文字段，会自动合并到每条日志事件中
   *
   * 例如设置 context = { workflow_name: "ocr_pipeline" }，
   * 之后每条日志都会自动携带 workflow_name 字段，无需每次手动传入。
   */
  private context: Record<string, unknown> = {};

  /**
   * 构造函数
   *
   * @param options 配置选项（全部可选，有合理的默认值）
   */
  constructor(options: StructuredLoggerOptions = {}) {
    // 使用 ?? 空值合并运算符设置默认值（仅在值为 null/undefined 时使用默认值）
    this.logDir = options.logDir ?? "logs";
    this.consoleLevel = options.consoleLevel ?? LogLevel.INFO;
    this.fileLevel = options.fileLevel ?? LogLevel.DEBUG;
    this.enableConsole = options.enableConsole ?? true;
    this.enableSystemLog = options.enableSystemLog ?? true;
    this.enableHumanLog = options.enableHumanLog ?? true;

    // 确保日志目录存在（recursive: true 表示自动创建中间目录，类似 mkdir -p）
    fs.mkdirSync(this.logDir, { recursive: true });
    // 初始化文件写入流
    this._setupStreams();
  }

  // ========================================
  // 初始化
  // ========================================

  /**
   * 初始化日志文件的写入流
   *
   * 根据配置决定是否创建 JSONL 和/或 TXT 日志文件的写入流。
   * flags: "a" 表示以追加模式（append）打开文件——
   *   新日志会添加到文件末尾，不会覆盖已有内容。
   *   这样多次运行程序的日志会累积在同一个文件中。
   */
  private _setupStreams(): void {
    if (this.enableSystemLog) {
      // 机器可读日志：每行一个 JSON 对象
      const systemLogPath = path.join(this.logDir, "workflow.jsonl");
      this.systemLogStream = fs.createWriteStream(systemLogPath, { flags: "a", encoding: "utf-8" });
    }

    if (this.enableHumanLog) {
      // 人类可读日志：传统的文本格式
      const humanLogPath = path.join(this.logDir, "workflow.log");
      this.humanLogStream = fs.createWriteStream(humanLogPath, { flags: "a", encoding: "utf-8" });
    }
  }

  // ========================================
  // 核心日志方法
  // ========================================

  /**
   * 记录一条日志事件（底层核心方法，所有便捷方法最终都调用这里）
   *
   * 工作流程：
   *   1. 构建 LogEvent 对象（添加时间戳、合并上下文）
   *   2. 写入 JSONL 文件（机器可读，无级别过滤——全部记录）
   *   3. 写入 TXT 文件（人类可读，受 fileLevel 过滤）
   *   4. 控制台输出（受 consoleLevel 过滤，并根据级别选择 console 方法）
   *
   * @param eventType 事件类型（见 EventType 枚举）
   * @param data      事件数据（不同事件类型携带不同的数据）
   * @param level     日志级别，默认 "INFO"
   * @param message   人类可读的消息文本（用于 TXT 文件和控制台；JSONL 不需要）
   */
  logEvent(
    eventType: string,
    data: Record<string, unknown>,
    level: string = "INFO",
    message?: string
  ): void {
    // 构建事件对象
    // ...this.context 将上下文字段展开合并到事件中
    // 例如 context = { workflow_name: "ocr" }，则事件中会多出 workflow_name 字段
    const event: LogEvent = {
      timestamp: new Date().toISOString(),
      level,
      event_type: eventType,
      data,
      ...this.context,
    };

    // 1. 写入系统日志（JSONL）—— 不做级别过滤，所有事件都记录
    //    JSON.stringify 将对象序列化为 JSON 字符串，加 \n 换行（JSONL 格式要求每行一条）
    if (this.systemLogStream) {
      this.systemLogStream.write(JSON.stringify(event) + "\n");
    }

    // 2. 写入人类可读日志（TXT）—— 受 fileLevel 过滤
    if (this.humanLogStream && message && shouldLog(level, this.fileLevel)) {
      // 将 ISO 时间戳 "2024-01-01T12:00:00.000Z" 转为更易读的 "2024-01-01 12:00:00"
      // .replace("T", " ") 将 T 替换为空格
      // .slice(0, 19) 截取前 19 个字符（去掉毫秒和时区后缀 ".000Z"）
      const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
      this.humanLogStream.write(`[${ts}] ${level}: ${message}\n`);
    }

    // 3. 控制台输出 —— 受 consoleLevel 过滤
    if (this.enableConsole && message && shouldLog(level, this.consoleLevel)) {
      // 根据日志级别选择不同的 console 方法：
      //   ERROR/CRITICAL → console.error（红色输出，输出到 stderr）
      //   WARNING        → console.warn（黄色输出）
      //   DEBUG          → console.debug（灰色输出，部分终端默认隐藏）
      //   INFO 及其他    → console.log（标准输出）
      const consoleFn = level === "ERROR" || level === "CRITICAL"
        ? console.error
        : level === "WARNING"
        ? console.warn
        : level === "DEBUG"
        ? console.debug
        : console.log;
      consoleFn(`${level}: ${message}`);
    }
  }

  // ========================================
  // 便捷方法 - 通用日志（第二层 API）
  // ========================================

  /**
   * 记录调试级别日志
   *
   * 用于记录详细的调试信息，生产环境通常不在控制台显示（consoleLevel 默认是 INFO）。
   * 但会写入 JSONL 文件，需要排查问题时可以查看。
   *
   * @param message 日志消息
   * @param data    附加数据（可选）
   */
  debug(message: string, data: Record<string, unknown> = {}): void {
    this.logEvent(EventType.CUSTOM, data, "DEBUG", message);
  }

  /**
   * 记录信息级别日志
   *
   * 用于记录正常的运行信息，如"步骤开始"、"文件已保存"等。
   */
  info(message: string, data: Record<string, unknown> = {}): void {
    this.logEvent(EventType.CUSTOM, data, "INFO", message);
  }

  /**
   * 记录警告级别日志
   *
   * 用于记录值得注意但不影响程序运行的情况，如"API 缺少 usage 字段"。
   */
  warning(message: string, data: Record<string, unknown> = {}): void {
    this.logEvent(EventType.CUSTOM, data, "WARNING", message);
  }

  /**
   * 记录错误级别日志
   *
   * 用于记录错误事件。可选传入 Error 对象，会自动提取 error_type 和 error_message。
   *
   * @param message 错误描述
   * @param error   Error 对象（可选），会自动提取类名和消息
   * @param data    附加数据（可选）
   *
   * 示例：
   *   try { ... } catch (e) {
   *     logger.error("文件读取失败", e as Error, { path: "/tmp/data.json" });
   *   }
   *   // data 中会包含：error_type: "Error", error_message: "ENOENT: no such file..."
   */
  error(message: string, error?: Error, data: Record<string, unknown> = {}): void {
    // 展开 data 的浅拷贝，避免修改调用方传入的对象
    const errorData = { ...data };
    if (error) {
      // error.constructor.name 获取错误类名（如 "TypeError"、"RangeError"）
      errorData["error_type"] = error.constructor.name;
      // error.message 获取错误消息文本
      errorData["error_message"] = error.message;
    }
    this.logEvent(EventType.ERROR, errorData, "ERROR", message);
  }

  // ========================================
  // 便捷方法 - 工作流事件（第三层 API）
  // ========================================

  /**
   * 记录工作流开始事件
   *
   * 在工作流引擎（workflow_engine.ts）开始执行时调用。
   * 会将 workflowName 存入上下文，后续所有日志自动携带 workflow_name 字段。
   *
   * @param workflowName 工作流名称（如 "ocr_pipeline"）
   * @param config       工作流配置信息
   */
  workflowStart(workflowName: string, config: Record<string, unknown>): void {
    // 将工作流名称存入上下文——之后的每条日志都会自动包含 workflow_name 字段
    this.context["workflow_name"] = workflowName;
    const message = `[START] 工作流开始: ${workflowName}`;
    this.logEvent(EventType.WORKFLOW_START, { workflow_name: workflowName, config }, "INFO", message);
  }

  /**
   * 记录工作流结束事件
   *
   * @param status 完成状态，默认 "completed"，也可能是 "failed"
   * @param stats  统计信息（可选），如 { duration: 120.5, total_cost: 0.85 }
   */
  workflowEnd(status: string = "completed", stats?: Record<string, unknown>): void {
    let message = `[DONE] 工作流完成: ${status}`;
    // 如果统计信息中有 duration 字段，追加耗时显示
    const duration = stats?.["duration"] as number | undefined;
    if (duration !== undefined) {
      // toFixed(2) 保留两位小数
      message += ` (耗时 ${duration.toFixed(2)}秒)`;
    }
    this.logEvent(EventType.WORKFLOW_END, { status, stats: stats ?? {} }, "INFO", message);
  }

  /**
   * 记录步骤开始事件
   *
   * @param stepId   步骤 ID（如 "step1"、"pdf_to_images"）
   * @param stepName 步骤显示名称（如 "PDF转图片"）
   * @param inputs   步骤输入数据（可选，用于调试）
   */
  stepStart(stepId: string, stepName: string, inputs?: Record<string, unknown>): void {
    const message = `[STEP] 步骤 ${stepId} 开始: ${stepName}`;
    this.logEvent(
      EventType.STEP_START,
      { step_id: stepId, step_name: stepName, inputs: inputs ?? {} },
      "INFO",
      message
    );
  }

  /**
   * 记录步骤结束事件
   *
   * @param stepId   步骤 ID
   * @param outputs  步骤输出数据（可选）
   * @param cost     成本信息（可选），如 { total_cost: 0.0012, currency: "CNY" }
   * @param duration 步骤耗时（秒，可选）
   *
   * 控制台输出示例：
   *   INFO: [OK] 步骤 step1 完成 (耗时 5.23秒) [成本: ¥0.0012]
   */
  stepEnd(
    stepId: string,
    outputs?: Record<string, unknown>,
    cost?: Record<string, unknown>,
    duration?: number
  ): void {
    let message = `[OK] 步骤 ${stepId} 完成`;
    // 如果有耗时信息，追加到消息中
    if (duration !== undefined) message += ` (耗时 ${duration.toFixed(2)}秒)`;
    // 如果有成本信息，追加成本（以人民币显示，保留 4 位小数）
    const totalCost = cost?.["total_cost"] as number | undefined;
    if (totalCost !== undefined) message += ` [成本: ¥${totalCost.toFixed(4)}]`;

    this.logEvent(
      EventType.STEP_END,
      { step_id: stepId, outputs: outputs ?? {}, cost: cost ?? {}, duration },
      "INFO",
      message
    );
  }

  // ========================================
  // 便捷方法 - LLM 调用
  // ========================================

  /**
   * 记录一次 LLM API 调用
   *
   * 每次调用大语言模型都应该记录，用于成本统计和性能分析。
   *
   * @param model        模型名称（如 "gpt-4o"）
   * @param inputTokens  输入消耗的 token 数
   * @param outputTokens 输出消耗的 token 数
   * @param cost         本次调用的花费（人民币）
   * @param taskId       关联的任务/步骤 ID（可选，用于按步骤统计成本）
   * @param extra        额外数据（可选，如 prompt 长度、重试次数等）
   *
   * 控制台输出示例：
   *   INFO: 🤖 LLM: gpt-4o [任务 step2] - 2000 tokens, ¥0.0125
   */
  llmCall(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cost: number,
    taskId?: string,
    extra: Record<string, unknown> = {}
  ): void {
    let message = `🤖 LLM: ${model}`;
    if (taskId) message += ` [任务 ${taskId}]`;
    message += ` - ${inputTokens + outputTokens} tokens, ¥${cost.toFixed(4)}`;

    this.logEvent(
      EventType.LLM_CALL,
      {
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        cost,
        task_id: taskId,
        ...extra,
      },
      "INFO",
      message
    );
  }

  // ========================================
  // 便捷方法 - 文件操作
  // ========================================

  /**
   * 记录文件操作
   *
   * 记录级别为 DEBUG（调试级别），默认不在控制台显示。
   * 用于追踪工作流执行过程中的文件读写操作。
   *
   * @param operation 操作类型，如 "read"、"write"、"delete"
   * @param filePath  文件路径
   * @param size      文件大小（字节，可选）
   * @param extra     额外数据（可选）
   *
   * 控制台输出示例（DEBUG 级别）：
   *   DEBUG: 📄 write: output.json (15.23 KB)
   */
  fileOperation(
    operation: string,
    filePath: string,
    size?: number,
    extra: Record<string, unknown> = {}
  ): void {
    // path.basename 提取文件名（不含目录路径），让消息更简洁
    // 例如 "/data/project/output/result.json" → "result.json"
    let message = `📄 ${operation}: ${path.basename(filePath)}`;
    if (size !== undefined) {
      // 将字节数转为 KB 显示（÷1024），保留 2 位小数
      message += ` (${(size / 1024).toFixed(2)} KB)`;
    }

    this.logEvent(
      EventType.FILE_OPERATION,
      { operation, file_path: filePath, size, ...extra },
      "DEBUG",
      message
    );
  }

  // ========================================
  // 上下文管理
  // ========================================

  /**
   * 设置全局上下文字段
   *
   * 设置后，后续所有日志事件都会自动包含这些字段。
   * 适用于"一次设置，多次使用"的场景，避免每次 logEvent 都重复传入。
   *
   * 示例：
   *   logger.setContext({ workflow_name: "ocr", batch_id: "2024-01-01" });
   *   logger.info("处理开始");
   *   // JSONL 中会输出：{ ..., workflow_name: "ocr", batch_id: "2024-01-01", ... }
   *
   * @param data 要合并到上下文中的键值对
   */
  setContext(data: Record<string, unknown>): void {
    // Object.assign 将 data 的所有属性合并到 this.context 上
    // 如果有同名键，新值会覆盖旧值
    Object.assign(this.context, data);
  }

  /**
   * 清除所有上下文字段
   *
   * 通常在工作流结束后调用，防止上下文污染下一次工作流的日志。
   */
  clearContext(): void {
    this.context = {};
  }

  // ========================================
  // 清理
  // ========================================

  /**
   * 关闭日志器，释放文件写入流
   *
   * 程序退出前应调用此方法，确保：
   *   1. 缓冲区中的数据被刷新（flush）到磁盘
   *   2. 文件句柄被正确释放（操作系统对打开的文件数有限制）
   *
   * ?.end() 是可选链调用：如果 stream 为 null（未启用）则跳过，不会报错
   */
  close(): void {
    this.systemLogStream?.end();
    this.humanLogStream?.end();
    // 设为 null，防止 close 后再调用 write 导致错误
    this.systemLogStream = null;
    this.humanLogStream = null;
  }

  /**
   * 返回日志器的字符串表示（用于调试）
   *
   * 示例：StructuredLogger(logDir='data/project/logs')
   */
  toString(): string {
    return `StructuredLogger(logDir='${this.logDir}')`;
  }
}
