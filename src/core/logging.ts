/**
 * Structured logging system.
 *
 * This module provides an event-based structured logger for recording workflow
 * execution events. Instead of building ad hoc strings and passing them to
 * console.log, each log entry is a structured event object. That makes later
 * log analysis, cost statistics, and performance monitoring much easier.
 *
 * Output architecture:
 *   1. Machine-readable log (workflow.jsonl) - one JSON object per line, easy
 *      for programs to parse and analyze.
 *      Example line: {"timestamp":"2024-01-01T12:00:00.000Z","level":"INFO","event_type":"step_start",...}
 *   2. Human-readable log (workflow.log) - traditional text format for direct
 *      developer inspection.
 *      Example line: [2024-01-01 12:00:00] INFO: [STEP] Step step1 started: PDF to images
 *   3. Console output - similar to the human-readable log, shown live in the
 *      terminal.
 *
 * JSONL format notes:
 *   JSONL (JSON Lines) is a text format where each line is an independent JSON
 *   object. Compared with a regular JSON file where the whole file is one
 *   array, JSONL has a few useful properties:
 *     - It can be appended line by line without reading the whole file.
 *     - It can be parsed line by line without loading a large file into memory.
 *     - If the file is partially damaged, only damaged lines are affected.
 */

// fs is Node.js's built-in file system module.
// Used here for fs.mkdirSync and fs.createWriteStream.
import * as fs from "fs";
// path is Node.js's built-in path handling module.
// Used here for path.join and path.basename.
import * as path from "path";

// ========================================
// Enum Definitions
// ========================================

/**
 * Log level enum.
 *
 * Ordered from low to high. Higher levels indicate more important or severe
 * events. The logger filters output according to the configured threshold.
 * For example, if consoleLevel is WARNING, DEBUG and INFO messages will not be
 * shown in the console.
 *
 * DEBUG:    Detailed debugging information, such as file I/O details.
 * INFO:     Normal runtime information, such as step start/end events.
 * WARNING:  Something worth attention that does not stop execution.
 * ERROR:    An operation failed, but the program may still continue.
 * CRITICAL: A fatal error that prevents the program from continuing.
 */
export enum LogLevel {
  DEBUG = "DEBUG",
  INFO = "INFO",
  WARNING = "WARNING",
  ERROR = "ERROR",
  CRITICAL = "CRITICAL",
}

/**
 * Event type enum.
 *
 * Each log entry belongs to an event type for classification and filtering.
 * These types cover the full workflow execution lifecycle:
 *
 * WORKFLOW_START:  Workflow execution started.
 * WORKFLOW_END:    Workflow execution ended, successfully or unsuccessfully.
 * STEP_START:      A single step started.
 * STEP_END:        A single step ended.
 * LLM_CALL:        One LLM API call, including model, token usage, and cost.
 * FILE_OPERATION:  File operations such as read, write, or delete.
 * ERROR:           Error event.
 * METRIC:          Performance metric, such as duration or throughput.
 * CUSTOM:          General custom event that does not fit another type.
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
// Type Definitions
// ========================================

/**
 * Data structure for a log event.
 *
 * Each log entry is a LogEvent object serialized to JSON and written to the
 * JSONL file.
 *
 * timestamp:  ISO 8601 timestamp, such as "2024-01-01T12:00:00.000Z".
 * level:      Log level ("DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL").
 * event_type: Event type. See the EventType enum.
 * data:       Event payload. Different event types use different data shapes.
 *             Record<string, unknown> is similar to Python's dict[str, Any].
 * [key: string]: unknown allows global context fields from setContext().
 *
 * Example STEP_END event:
 *   {
 *     timestamp: "2024-01-01T12:00:05.000Z",
 *     level: "INFO",
 *     event_type: "step_end",
 *     data: { step_id: "step1", duration: 5.23, cost: { total_cost: 0.0012 } },
 *     workflow_name: "ocr_pipeline"    // Context field injected by setContext.
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
 * Options for the StructuredLogger constructor.
 *
 * logDir:          Directory for log files. Defaults to "logs".
 * consoleLevel:    Minimum console output level. Defaults to INFO.
 * fileLevel:       Minimum file output level. Defaults to DEBUG.
 * enableConsole:   Whether to enable console output. Defaults to true.
 * enableSystemLog: Whether to enable workflow.jsonl. Defaults to true.
 * enableHumanLog:  Whether to enable workflow.log. Defaults to true.
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
// Log Level Priority (For Filtering)
// ========================================

/**
 * Numeric priority map for log levels.
 *
 * Higher numbers mean higher severity. shouldLog() uses this map to decide
 * whether a message should be emitted. For example, if consoleLevel is
 * WARNING(30), only WARNING(30), ERROR(40), and CRITICAL(50) messages are
 * shown in the console; DEBUG(10) and INFO(20) are filtered out.
 */
const LEVEL_PRIORITY: Record<string, number> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
  CRITICAL: 50,
};

/**
 * Decide whether a log message should be emitted.
 *
 * @param messageLevel Level of this log message, such as "INFO".
 * @param threshold    Output threshold, such as LogLevel.WARNING.
 * @returns true if the message should be emitted, false if it should be filtered.
 *
 * Examples:
 *   shouldLog("DEBUG", LogLevel.INFO)     -> false (10 < 20, filtered)
 *   shouldLog("WARNING", LogLevel.INFO)   -> true  (30 >= 20, emitted)
 *   shouldLog("ERROR", LogLevel.WARNING)  -> true  (40 >= 30, emitted)
 */
function shouldLog(messageLevel: string, threshold: LogLevel): boolean {
  // ?? 0 is defensive: unknown level strings default to the lowest priority.
  return (LEVEL_PRIORITY[messageLevel] ?? 0) >= (LEVEL_PRIORITY[threshold] ?? 0);
}

// ========================================
// StructuredLogger Class
// ========================================

/**
 * Structured logger.
 *
 * This is the core logger class. It provides three API layers:
 *
 * Layer 1 - low-level core method:
 *   logEvent() receives raw event data and dispatches it to the output targets.
 *
 * Layer 2 - general convenience methods by level:
 *   debug() / info() / warning() / error() set the corresponding level.
 *
 * Layer 3 - domain event methods:
 *   workflowStart() / workflowEnd() record workflow lifecycle events.
 *   stepStart() / stepEnd() record step lifecycle events.
 *   llmCall() records LLM calls.
 *   fileOperation() records file operations.
 *
 * Usage example:
 *   // Create a logger with log files under data/project/logs/.
 *   const logger = new StructuredLogger({ logDir: "data/project/logs" });
 *
 *   // Record workflow start.
 *   logger.workflowStart("ocr_pipeline", { input: "document.pdf" });
 *
 *   // Record step start and end.
 *   logger.stepStart("step1", "PDF to images", { pdf: "document.pdf" });
 *   logger.stepEnd("step1", { images: 20 }, { total_cost: 0 }, 5.23);
 *
 *   // Record an LLM call.
 *   logger.llmCall("gpt-4o", 1500, 500, 0.0125, "step2");
 *
 *   // Close the logger when finished to release file streams.
 *   logger.close();
 */
export class StructuredLogger {
  // ---- Configuration fields ----

  /** Directory path for log files. */
  private logDir: string;
  /** Minimum log level shown in the console. */
  private consoleLevel: LogLevel;
  /** Minimum log level written to workflow.log. */
  private fileLevel: LogLevel;
  /** Whether console output is enabled. */
  private enableConsole: boolean;
  /** Whether the machine-readable workflow.jsonl log is enabled. */
  private enableSystemLog: boolean;
  /** Whether the human-readable workflow.log file is enabled. */
  private enableHumanLog: boolean;

  // ---- File write streams ----

  /**
   * Write stream for the system log (workflow.jsonl).
   *
   * fs.WriteStream is a Node.js writable stream. Calling .write() appends data
   * to the file. Streams are preferable to calling fs.writeFileSync each time:
   *   - The file does not need to be opened and closed for every write.
   *   - Data can be buffered in memory and flushed in batches.
   *   - Writes are non-blocking and do not stall the main thread.
   */
  private systemLogStream: fs.WriteStream | null = null;
  /** Write stream for the human-readable log (workflow.log). */
  private humanLogStream: fs.WriteStream | null = null;

  // ---- Context ----

  /**
   * Global context fields that are merged into every log event.
   *
   * For example, if context is { workflow_name: "ocr_pipeline" }, every later
   * log entry automatically includes workflow_name without passing it each time.
   */
  private context: Record<string, unknown> = {};

  /**
   * Constructor.
   *
   * @param options Configuration options. All are optional and have defaults.
   */
  constructor(options: StructuredLoggerOptions = {}) {
    // Use nullish coalescing so defaults apply only for null/undefined values.
    this.logDir = options.logDir ?? "logs";
    this.consoleLevel = options.consoleLevel ?? LogLevel.INFO;
    this.fileLevel = options.fileLevel ?? LogLevel.DEBUG;
    this.enableConsole = options.enableConsole ?? true;
    this.enableSystemLog = options.enableSystemLog ?? true;
    this.enableHumanLog = options.enableHumanLog ?? true;

    // Ensure the log directory exists. recursive: true behaves like mkdir -p.
    fs.mkdirSync(this.logDir, { recursive: true });
    // Initialize file write streams.
    this._setupStreams();
  }

  // ========================================
  // Initialization
  // ========================================

  /**
   * Initialize write streams for log files.
   *
   * Creates JSONL and/or text log write streams according to the configuration.
   * flags: "a" opens files in append mode, so new log entries are added to the
   * end without overwriting existing content. Logs from multiple runs can
   * therefore accumulate in the same file.
   */
  private _setupStreams(): void {
    if (this.enableSystemLog) {
      // Machine-readable log: one JSON object per line.
      const systemLogPath = path.join(this.logDir, "workflow.jsonl");
      this.systemLogStream = fs.createWriteStream(systemLogPath, { flags: "a", encoding: "utf-8" });
    }

    if (this.enableHumanLog) {
      // Human-readable log: traditional text format.
      const humanLogPath = path.join(this.logDir, "workflow.log");
      this.humanLogStream = fs.createWriteStream(humanLogPath, { flags: "a", encoding: "utf-8" });
    }
  }

  // ========================================
  // Core Logging Method
  // ========================================

  /**
   * Record one log event.
   *
   * This is the low-level core method used by all convenience methods.
   *
   * Flow:
   *   1. Build a LogEvent object with timestamp and context fields.
   *   2. Write to the JSONL file. This path is machine-readable and unfiltered.
   *   3. Write to the text file. This path is human-readable and fileLevel-filtered.
   *   4. Write to the console. This path is consoleLevel-filtered and selects
   *      a console method according to the log level.
   *
   * @param eventType Event type. See the EventType enum.
   * @param data      Event payload. Different event types use different data.
   * @param level     Log level. Defaults to "INFO".
   * @param message   Human-readable message for text logs and console output.
   */
  logEvent(
    eventType: string,
    data: Record<string, unknown>,
    level: string = "INFO",
    message?: string
  ): void {
    // Build the event object.
    // ...this.context spreads global context fields into the event.
    // For example, context = { workflow_name: "ocr" } adds workflow_name.
    const event: LogEvent = {
      timestamp: new Date().toISOString(),
      level,
      event_type: eventType,
      data,
      ...this.context,
    };

    // 1. Write the system log (JSONL). This is unfiltered and records all events.
    //    JSON.stringify serializes the event, and \n keeps one object per line.
    if (this.systemLogStream) {
      this.systemLogStream.write(JSON.stringify(event) + "\n");
    }

    // 2. Write the human-readable log (TXT). This is filtered by fileLevel.
    if (this.humanLogStream && message && shouldLog(level, this.fileLevel)) {
      // Convert ISO timestamp "2024-01-01T12:00:00.000Z" to
      // "2024-01-01 12:00:00" by replacing T and dropping milliseconds/timezone.
      const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
      this.humanLogStream.write(`[${ts}] ${level}: ${message}\n`);
    }

    // 3. Console output. This is filtered by consoleLevel.
    if (this.enableConsole && message && shouldLog(level, this.consoleLevel)) {
      // Pick a console method according to log level:
      //   ERROR/CRITICAL -> console.error (stderr)
      //   WARNING        -> console.warn
      //   DEBUG          -> console.debug
      //   INFO and other -> console.log
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
  // Convenience Methods - General Logs (Layer 2 API)
  // ========================================

  /**
   * Record a debug-level log.
   *
   * Use this for detailed debugging information. Production runs usually do not
   * show these messages in the console because consoleLevel defaults to INFO.
   * They are still written to JSONL for later troubleshooting.
   *
   * @param message Log message.
   * @param data    Optional additional data.
   */
  debug(message: string, data: Record<string, unknown> = {}): void {
    this.logEvent(EventType.CUSTOM, data, "DEBUG", message);
  }

  /**
   * Record an info-level log.
   *
   * Use this for normal runtime information, such as "step started" or
   * "file saved".
   */
  info(message: string, data: Record<string, unknown> = {}): void {
    this.logEvent(EventType.CUSTOM, data, "INFO", message);
  }

  /**
   * Record a warning-level log.
   *
   * Use this for notable situations that do not stop execution, such as an API
   * response missing a usage field.
   */
  warning(message: string, data: Record<string, unknown> = {}): void {
    this.logEvent(EventType.CUSTOM, data, "WARNING", message);
  }

  /**
   * Record an error-level log.
   *
   * Use this for error events. Passing an Error object automatically extracts
   * error_type and error_message.
   *
   * @param message Error description.
   * @param error   Optional Error object. The class name and message are extracted.
   * @param data    Optional additional data.
   *
   * Example:
   *   try { ... } catch (e) {
   *     logger.error("Failed to read file", e as Error, { path: "/tmp/data.json" });
   *   }
   *   // data will contain error_type: "Error" and error_message: "ENOENT: no such file..."
   */
  error(message: string, error?: Error, data: Record<string, unknown> = {}): void {
    // Shallow-copy data so the caller's object is not modified.
    const errorData = { ...data };
    if (error) {
      // error.constructor.name gets the error class name, such as TypeError.
      errorData["error_type"] = error.constructor.name;
      // error.message gets the error message text.
      errorData["error_message"] = error.message;
    }
    this.logEvent(EventType.ERROR, errorData, "ERROR", message);
  }

  // ========================================
  // Convenience Methods - Workflow Events (Layer 3 API)
  // ========================================

  /**
   * Record a workflow start event.
   *
   * Called when the workflow engine starts execution. Stores workflowName in
   * context so later logs automatically include workflow_name.
   *
   * @param workflowName Workflow name, such as "ocr_pipeline".
   * @param config       Workflow configuration information.
   */
  workflowStart(workflowName: string, config: Record<string, unknown>): void {
    // Store the workflow name so later logs automatically include workflow_name.
    this.context["workflow_name"] = workflowName;
    const message = `[START] Workflow started: ${workflowName}`;
    this.logEvent(EventType.WORKFLOW_START, { workflow_name: workflowName, config }, "INFO", message);
  }

  /**
   * Record a workflow end event.
   *
   * @param status Completion status. Defaults to "completed"; may also be "failed".
   * @param stats  Optional statistics, such as { duration: 120.5, total_cost: 0.85 }.
   */
  workflowEnd(status: string = "completed", stats?: Record<string, unknown>): void {
    let message = `[DONE] Workflow completed: ${status}`;
    // Append duration display when stats contains a duration field.
    const duration = stats?.["duration"] as number | undefined;
    if (duration !== undefined) {
      // Keep two decimal places.
      message += ` (duration ${duration.toFixed(2)}s)`;
    }
    this.logEvent(EventType.WORKFLOW_END, { status, stats: stats ?? {} }, "INFO", message);
  }

  /**
   * Record a step start event.
   *
   * @param stepId   Step ID, such as "step1" or "pdf_to_images".
   * @param stepName Display name for the step, such as "PDF to images".
   * @param inputs   Optional step inputs for debugging.
   */
  stepStart(stepId: string, stepName: string, inputs?: Record<string, unknown>): void {
    const message = `[STEP] Step ${stepId} started: ${stepName}`;
    this.logEvent(
      EventType.STEP_START,
      { step_id: stepId, step_name: stepName, inputs: inputs ?? {} },
      "INFO",
      message
    );
  }

  /**
   * Record a step end event.
   *
   * @param stepId   Step ID.
   * @param outputs  Optional step outputs.
   * @param cost     Optional cost information, such as { total_cost: 0.0012, currency: "CNY" }.
   * @param duration Optional step duration in seconds.
   *
   * Console output example:
   *   INFO: [OK] Step step1 completed (duration 5.23s) [cost: ¥0.0012]
   */
  stepEnd(
    stepId: string,
    outputs?: Record<string, unknown>,
    cost?: Record<string, unknown>,
    duration?: number
  ): void {
    let message = `[OK] Step ${stepId} completed`;
    // Append duration when available.
    if (duration !== undefined) message += ` (duration ${duration.toFixed(2)}s)`;
    // Append cost when available, displayed in CNY with four decimal places.
    const totalCost = cost?.["total_cost"] as number | undefined;
    if (totalCost !== undefined) message += ` [cost: ¥${totalCost.toFixed(4)}]`;

    this.logEvent(
      EventType.STEP_END,
      { step_id: stepId, outputs: outputs ?? {}, cost: cost ?? {}, duration },
      "INFO",
      message
    );
  }

  // ========================================
  // Convenience Methods - LLM Calls
  // ========================================

  /**
   * Record one LLM API call.
   *
   * Each LLM call should be logged for cost statistics and performance analysis.
   *
   * @param model        Model name, such as "gpt-4o".
   * @param inputTokens  Number of input tokens.
   * @param outputTokens Number of output tokens.
   * @param cost         Cost of this call in CNY.
   * @param taskId       Optional related task/step ID for per-step cost stats.
   * @param extra        Optional extra data, such as prompt length or retry count.
   *
   * Console output example:
   *   INFO: 🤖 LLM: gpt-4o [task step2] - 2000 tokens, ¥0.0125
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
    if (taskId) message += ` [task ${taskId}]`;
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
  // Convenience Methods - File Operations
  // ========================================

  /**
   * Record a file operation.
   *
   * This logs at DEBUG level, so it is not shown in the console by default.
   * Use it to trace file I/O during workflow execution.
   *
   * @param operation Operation type, such as "read", "write", or "delete".
   * @param filePath  File path.
   * @param size      Optional file size in bytes.
   * @param extra     Optional extra data.
   *
   * Console output example at DEBUG level:
   *   DEBUG: 📄 write: output.json (15.23 KB)
   */
  fileOperation(
    operation: string,
    filePath: string,
    size?: number,
    extra: Record<string, unknown> = {}
  ): void {
    // path.basename extracts only the file name so the message stays compact.
    // For example, "/data/project/output/result.json" becomes "result.json".
    let message = `📄 ${operation}: ${path.basename(filePath)}`;
    if (size !== undefined) {
      // Convert bytes to KB and keep two decimal places.
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
  // Context Management
  // ========================================

  /**
   * Set global context fields.
   *
   * After setting context, all later log events automatically include these
   * fields. This is useful for "set once, use many times" data that should not
   * be passed to every logEvent call manually.
   *
   * Example:
   *   logger.setContext({ workflow_name: "ocr", batch_id: "2024-01-01" });
   *   logger.info("Processing started");
   *   // JSONL output includes: { ..., workflow_name: "ocr", batch_id: "2024-01-01", ... }
   *
   * @param data Key-value pairs to merge into context.
   */
  setContext(data: Record<string, unknown>): void {
    // Object.assign merges every data property into this.context.
    // New values overwrite old values for duplicate keys.
    Object.assign(this.context, data);
  }

  /**
   * Clear all context fields.
   *
   * Usually called after a workflow ends so context from one workflow does not
   * leak into the next workflow's logs.
   */
  clearContext(): void {
    this.context = {};
  }

  // ========================================
  // Cleanup
  // ========================================

  /**
   * Close the logger and release file write streams.
   *
   * Call this before program exit to ensure:
   *   1. Buffered data is flushed to disk.
   *   2. File handles are released correctly.
   *
   * ?.end() uses optional chaining: if a stream is null, it is skipped safely.
   */
  close(): void {
    this.systemLogStream?.end();
    this.humanLogStream?.end();
    // Set streams to null to prevent writes after close.
    this.systemLogStream = null;
    this.humanLogStream = null;
  }

  /**
   * Return the logger string representation for debugging.
   *
   * Example: StructuredLogger(logDir='data/project/logs')
   */
  toString(): string {
    return `StructuredLogger(logDir='${this.logDir}')`;
  }
}
