/**
 * Input/output actions.
 *
 * This file contains actions that perform file I/O or logging side effects,
 * such as saving data, reading files, and merging JSON files.
 */

// fs is Node.js's built-in filesystem module.
import fs from "fs";
// path is Node.js's built-in path helper module.
import path from "path";
// WorkflowContext stores shared data for the workflow, and StepResult is the
// value each action returns after execution finishes.
import { WorkflowContext, StepResult } from "../workflow_engine.js";
// BaseAction provides the shared run() wrapper that calls execute().
import { BaseAction } from "./base.js";
// formatPathTemplate expands placeholders such as {key} and {key:04d}.
import { formatPathTemplate } from "./utils.js";
import {
  terminalInternalDebug,
  terminalInternalError,
  terminalInternalInfo,
  terminalInternalWarn,
} from "../core/terminal_reporter.js";

/**
 * A small glob matcher.
 *
 * It supports:
 *   *  -> zero or more characters
 *   ?  -> exactly one character
 *
 * It intentionally does not support recursive `**` matching or `{a,b}`
 * alternation because the current workflows only need simple same-directory
 * patterns like `*.json`.
 */
function matchGlobPattern(filename: string, pattern: string): boolean {
  // Escape regex metacharacters first, then translate glob wildcards.
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexStr = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${regexStr}$`).test(filename);
}

// ============================================================
// SaveDataAction
// ============================================================

/**
 * Saves the current workflow data through a caller-provided function.
 *
 * Unlike DataProcessAction, this action is side-effect-only: it does not
 * merge new data back into the workflow context.
 */
export class SaveDataAction extends BaseAction {
  private readonly saveFunc: (data: Record<string, unknown>) => void;
  private readonly nextStep: string;

  constructor(
    saveFunc: (data: Record<string, unknown>) => void,
    nextStep: string = "END",
    name?: string,
    config: Record<string, unknown> = {}
  ) {
    super(name, config);
    this.saveFunc = saveFunc;
    this.nextStep = nextStep;
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    this.saveFunc(context.data);
    return new StepResult(this.nextStep, {}, { saved: true });
  }
}

// ============================================================
// LogAction
// ============================================================

/**
 * Maps log levels to console output methods.
 *
 * Both `warning` and `warn` are supported because both spellings are common
 * in workflow config files.
 */
const LOG_LEVEL_MAP: Record<string, (msg: string) => void> = {
  debug: (msg) => terminalInternalDebug(msg),
  info: (msg) => terminalInternalInfo(msg),
  warning: (msg) => terminalInternalWarn(msg), // Keep compatibility with Python-style naming.
  warn: (msg) => terminalInternalWarn(msg),
  error: (msg) => terminalInternalError(msg),
};

/**
 * Logs the current workflow data at a chosen level.
 *
 * The `{data}` placeholder is replaced with `JSON.stringify(context.data)`.
 */
export class LogAction extends BaseAction {
  private readonly messageTemplate: string;
  private readonly logLevel: string;
  private readonly nextStep: string;

  constructor(
    messageTemplate: string = "Current data: {data}",
    logLevel: string = "INFO",
    nextStep: string = "END",
    name?: string,
    config: Record<string, unknown> = {}
  ) {
    super(name, config);
    this.messageTemplate = messageTemplate;
    this.logLevel = logLevel.toLowerCase();
    this.nextStep = nextStep;
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    const message = this.messageTemplate.replace(
      "{data}",
      JSON.stringify(context.data)
    );

    // Use an inline fallback so the function type is always concrete.
    const logFn =
      LOG_LEVEL_MAP[this.logLevel] ?? ((msg: string) => terminalInternalInfo(msg));
    logFn(message);

    return new StepResult(this.nextStep, {}, { logged: true });
  }
}

// ============================================================
// ReadFileAction
// ============================================================

/**
 * Reads a file from disk and stores its contents in the workflow context.
 *
 * The path template supports placeholders handled by formatPathTemplate():
 *   {index}      - 1-based index derived from item_index
 *   {item_index} - 0-based item index from context.data
 *   {item}       - current item value from context.data
 *   {key:04d}    - zero-padded number formatting
 *   and any other key already present in context.data
 */
export class ReadFileAction extends BaseAction {
  private readonly pathTemplate: string;
  private readonly outputKey: string;
  private readonly encoding: BufferEncoding;
  private readonly missingOk: boolean;
  private readonly nextStep: string;

  constructor(
    pathTemplate: string,
    outputKey: string = "file_content",
    encoding: BufferEncoding = "utf-8",
    missingOk: boolean = false,
    nextStep: string = "END",
    name?: string,
    config: Record<string, unknown> = {}
  ) {
    super(name, config);
    this.pathTemplate = pathTemplate;
    this.outputKey = outputKey;
    this.encoding = encoding;
    this.missingOk = missingOk;
    this.nextStep = nextStep;
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    const formatVars: Record<string, unknown> = { ...context.data };
    if (typeof formatVars["item_index"] === "number") {
      formatVars["index"] = (formatVars["item_index"] as number) + 1;
    }

    let filepath: string;
    try {
      filepath = formatPathTemplate(this.pathTemplate, formatVars);
    } catch (e) {
      throw new Error(`read_file path_template is missing variables: ${e}`);
    }

    let content: string;
    if (!fs.existsSync(filepath)) {
      if (this.missingOk) {
        terminalInternalWarn(`read_file: file does not exist, returning empty content: ${filepath}`);
        content = "";
      } else {
        throw new Error(`read_file: file does not exist: ${filepath}`);
      }
    } else {
      content = fs.readFileSync(filepath, this.encoding);
      terminalInternalDebug(
        `read_file: read succeeded: ${filepath} (${content.length} chars)`
      );
    }

    return new StepResult(
      this.nextStep,
      { [this.outputKey]: content },
      { file_path: filepath, chars_read: content.length }
    );
  }
}

// ============================================================
// MergeJsonFilesAction
// ============================================================

/**
 * Reads multiple JSON files from a directory, combines them into one array,
 * and writes the merged result to an output file.
 */
export class MergeJsonFilesAction extends BaseAction {
  private readonly inputDir: string;
  private readonly outputFile: string;
  private readonly pattern: string;
  private readonly sortBy: string;
  private readonly outputKey: string;
  private readonly nextStep: string;
  private readonly stepId: string;

  constructor(
    inputDir: string,
    outputFile: string,
    pattern: string = "*.json",
    sortBy: string = "filename",
    outputKey: string = "merged_data",
    nextStep: string = "END",
    name: string = "MergeJsonFiles",
    stepId: string = "unknown",
    config: Record<string, unknown> = {}
  ) {
    super(name, config);
    this.inputDir = inputDir;
    this.outputFile = outputFile;
    this.pattern = pattern;
    this.sortBy = sortBy;
    this.outputKey = outputKey;
    this.nextStep = nextStep;
    this.stepId = stepId;
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    let inputDir: string;
    let outputFile: string;
    try {
      inputDir = formatPathTemplate(this.inputDir, context.data);
      outputFile = formatPathTemplate(this.outputFile, context.data);
    } catch (e) {
      throw new Error(`Path template is missing required context data: ${e}`);
    }

    terminalInternalInfo(`[Step ${this.stepId}] Starting JSON merge`);
    terminalInternalInfo(`[Step ${this.stepId}] Input directory: ${inputDir}`);
    terminalInternalInfo(`[Step ${this.stepId}] Output file: ${outputFile}`);

    const returnEmptyMergeResult = (
      statusMetadata: Record<string, unknown>
    ): StepResult => {
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, JSON.stringify([], null, 2), "utf-8");

      return new StepResult(
        this.nextStep,
        {
          [this.outputKey]: [],
          [`${this.outputKey}_count`]: 0,
          [`${this.outputKey}_file`]: outputFile,
        },
        {
          input_dir: inputDir,
          output_file: outputFile,
          files_merged: 0,
          files_failed: 0,
          failed_files: [],
          merged_count: 0,
          ...statusMetadata,
        }
      );
    };

    if (!fs.existsSync(inputDir)) {
      terminalInternalError(`[Step ${this.stepId}] Input directory does not exist: ${inputDir}`);
      return returnEmptyMergeResult({
        error: `Input directory does not exist: ${inputDir}`,
      });
    }

    const allFiles = fs.readdirSync(inputDir);
    let jsonFiles = allFiles
      .filter((f) => matchGlobPattern(f, this.pattern))
      .map((f) => path.join(inputDir, f));

    if (jsonFiles.length === 0) {
      terminalInternalWarn(
        `[Step ${this.stepId}] No matching JSON files found: ${path.join(inputDir, this.pattern)}`
      );
      return returnEmptyMergeResult({
        warning: "No matching JSON files found",
      });
    }

    if (this.sortBy === "filename") {
      jsonFiles.sort();
    } else if (this.sortBy === "modified_time") {
      jsonFiles.sort(
        (a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs
      );
    }

    terminalInternalInfo(
      `[Step ${this.stepId}] Found ${jsonFiles.length} JSON files, preparing to merge`
    );

    const mergedData: unknown[] = [];
    const failedFiles: string[] = [];

    for (const jsonFile of jsonFiles) {
      try {
        const content = fs.readFileSync(jsonFile, "utf-8");
        mergedData.push(JSON.parse(content));
      } catch (e) {
        terminalInternalError(`[Step ${this.stepId}] Failed to read file ${jsonFile}: ${e}`);
        failedFiles.push(jsonFile);
      }
    }

    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, JSON.stringify(mergedData, null, 2), "utf-8");

    terminalInternalInfo(
      `[Step ${this.stepId}] Successfully merged ${mergedData.length} files into: ${outputFile}`
    );

    if (failedFiles.length > 0) {
      terminalInternalWarn(
        `[Step ${this.stepId}] ${failedFiles.length} files failed to read`
      );
    }

    return new StepResult(
      this.nextStep,
      {
        [this.outputKey]: mergedData,
        [`${this.outputKey}_count`]: mergedData.length,
        [`${this.outputKey}_file`]: outputFile,
      },
      {
        input_dir: inputDir,
        output_file: outputFile,
        files_merged: mergedData.length,
        files_failed: failedFiles.length,
        failed_files: failedFiles,
        merged_count: mergedData.length,
      }
    );
  }
}
