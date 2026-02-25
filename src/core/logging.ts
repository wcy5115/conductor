/**
 * Structured Logger - 结构化日志系统
 * 基于事件的日志记录，支持多种输出格式和目标
 */

import * as fs from "fs";
import * as path from "path";

// ========================================
// 枚举
// ========================================

export enum LogLevel {
  DEBUG = "DEBUG",
  INFO = "INFO",
  WARNING = "WARNING",
  ERROR = "ERROR",
  CRITICAL = "CRITICAL",
}

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

export interface LogEvent {
  timestamp: string;
  level: string;
  event_type: string;
  data: Record<string, unknown>;
  [key: string]: unknown; // 合并上下文字段
}

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

const LEVEL_PRIORITY: Record<string, number> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
  CRITICAL: 50,
};

function shouldLog(messageLevel: string, threshold: LogLevel): boolean {
  return (LEVEL_PRIORITY[messageLevel] ?? 0) >= (LEVEL_PRIORITY[threshold] ?? 0);
}

// ========================================
// StructuredLogger 类
// ========================================

/**
 * 结构化日志记录器
 *
 * 特点：
 * 1. 基于事件（Event-based）而非字符串拼接
 * 2. 双输出：人类可读（Console + workflow.log）+ 机器可读（workflow.jsonl）
 * 3. 自动添加时间戳、上下文信息
 * 4. 支持成本追踪、性能分析
 *
 * 用法：
 *   const logger = new StructuredLogger({ logDir: "data/project/logs" });
 *   logger.stepStart("step1", "PDF转图片", { pdf: "file.pdf" });
 *   logger.stepEnd("step1", { images: 20 }, { tokens: 0 });
 */
export class StructuredLogger {
  private logDir: string;
  private consoleLevel: LogLevel;
  private fileLevel: LogLevel;
  private enableConsole: boolean;
  private enableSystemLog: boolean;
  private enableHumanLog: boolean;

  private systemLogStream: fs.WriteStream | null = null;
  private humanLogStream: fs.WriteStream | null = null;

  private context: Record<string, unknown> = {};

  constructor(options: StructuredLoggerOptions = {}) {
    this.logDir = options.logDir ?? "logs";
    this.consoleLevel = options.consoleLevel ?? LogLevel.INFO;
    this.fileLevel = options.fileLevel ?? LogLevel.DEBUG;
    this.enableConsole = options.enableConsole ?? true;
    this.enableSystemLog = options.enableSystemLog ?? true;
    this.enableHumanLog = options.enableHumanLog ?? true;

    fs.mkdirSync(this.logDir, { recursive: true });
    this._setupStreams();
  }

  // ========================================
  // 初始化
  // ========================================

  private _setupStreams(): void {
    if (this.enableSystemLog) {
      const systemLogPath = path.join(this.logDir, "workflow.jsonl");
      this.systemLogStream = fs.createWriteStream(systemLogPath, { flags: "a", encoding: "utf-8" });
    }

    if (this.enableHumanLog) {
      const humanLogPath = path.join(this.logDir, "workflow.log");
      this.humanLogStream = fs.createWriteStream(humanLogPath, { flags: "a", encoding: "utf-8" });
    }
  }

  // ========================================
  // 核心日志方法
  // ========================================

  logEvent(
    eventType: string,
    data: Record<string, unknown>,
    level: string = "INFO",
    message?: string
  ): void {
    const event: LogEvent = {
      timestamp: new Date().toISOString(),
      level,
      event_type: eventType,
      data,
      ...this.context,
    };

    // 1. 写入系统日志（JSONL）
    if (this.systemLogStream) {
      this.systemLogStream.write(JSON.stringify(event) + "\n");
    }

    // 2. 写入人类日志（TXT）
    if (this.humanLogStream && message && shouldLog(level, this.fileLevel)) {
      const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
      this.humanLogStream.write(`[${ts}] ${level}: ${message}\n`);
    }

    // 3. 控制台输出
    if (this.enableConsole && message && shouldLog(level, this.consoleLevel)) {
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
  // 便捷方法 - 通用日志
  // ========================================

  debug(message: string, data: Record<string, unknown> = {}): void {
    this.logEvent(EventType.CUSTOM, data, "DEBUG", message);
  }

  info(message: string, data: Record<string, unknown> = {}): void {
    this.logEvent(EventType.CUSTOM, data, "INFO", message);
  }

  warning(message: string, data: Record<string, unknown> = {}): void {
    this.logEvent(EventType.CUSTOM, data, "WARNING", message);
  }

  error(message: string, error?: Error, data: Record<string, unknown> = {}): void {
    const errorData = { ...data };
    if (error) {
      errorData["error_type"] = error.constructor.name;
      errorData["error_message"] = error.message;
    }
    this.logEvent(EventType.ERROR, errorData, "ERROR", message);
  }

  // ========================================
  // 便捷方法 - 工作流事件
  // ========================================

  workflowStart(workflowName: string, config: Record<string, unknown>): void {
    this.context["workflow_name"] = workflowName;
    const message = `[START] 工作流开始: ${workflowName}`;
    this.logEvent(EventType.WORKFLOW_START, { workflow_name: workflowName, config }, "INFO", message);
  }

  workflowEnd(status: string = "completed", stats?: Record<string, unknown>): void {
    let message = `[DONE] 工作流完成: ${status}`;
    const duration = stats?.["duration"] as number | undefined;
    if (duration !== undefined) {
      message += ` (耗时 ${duration.toFixed(2)}秒)`;
    }
    this.logEvent(EventType.WORKFLOW_END, { status, stats: stats ?? {} }, "INFO", message);
  }

  stepStart(stepId: string, stepName: string, inputs?: Record<string, unknown>): void {
    const message = `[STEP] 步骤 ${stepId} 开始: ${stepName}`;
    this.logEvent(
      EventType.STEP_START,
      { step_id: stepId, step_name: stepName, inputs: inputs ?? {} },
      "INFO",
      message
    );
  }

  stepEnd(
    stepId: string,
    outputs?: Record<string, unknown>,
    cost?: Record<string, unknown>,
    duration?: number
  ): void {
    let message = `[OK] 步骤 ${stepId} 完成`;
    if (duration !== undefined) message += ` (耗时 ${duration.toFixed(2)}秒)`;
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

  fileOperation(
    operation: string,
    filePath: string,
    size?: number,
    extra: Record<string, unknown> = {}
  ): void {
    let message = `📄 ${operation}: ${path.basename(filePath)}`;
    if (size !== undefined) message += ` (${(size / 1024).toFixed(2)} KB)`;

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

  setContext(data: Record<string, unknown>): void {
    Object.assign(this.context, data);
  }

  clearContext(): void {
    this.context = {};
  }

  // ========================================
  // 清理
  // ========================================

  close(): void {
    this.systemLogStream?.end();
    this.humanLogStream?.end();
    this.systemLogStream = null;
    this.humanLogStream = null;
  }

  toString(): string {
    return `StructuredLogger(logDir='${this.logDir}')`;
  }
}
