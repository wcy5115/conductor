/**
 * Workflow action utility functions.
 *
 * Includes shared helpers for file validation, directory management, cost
 * metadata, error formatting, path templates, and nested data lookup.
 *
 * Note: create_simple_action and create_llm_action are not migrated here.
 * They were thin constructor wrappers; direct construction is clearer in TS.
 */

// Node's file-system module, used for reads, writes, stat checks, and existence checks.
import fs from "fs";
// Node's path module, used for path joins and extension checks.
import path from "path";
import {
  terminalInternalDebug,
  terminalInternalError,
  terminalInternalInfo,
} from "../core/terminal_reporter.js";

/**
 * Lightweight logger wrapper.
 *
 * It currently delegates to console methods. Keeping a single wrapper makes it
 * easier to switch this module to a formal logger later.
 */
const logger = {
  debug: (msg: string) => terminalInternalDebug(msg),
  info: (msg: string) => terminalInternalInfo(msg),
  error: (msg: string) => terminalInternalError(msg),
};

/**
 * Validate that a JSON file exists, is large enough, parses correctly, and
 * contains non-empty data.
 *
 * @param filepath File path.
 * @param minSize Minimum file size in bytes. Defaults to 10.
 */
export function isValidJsonFile(filepath: string, minSize = 10): boolean {
  if (!fs.existsSync(filepath)) return false;

  const stat = fs.statSync(filepath);
  if (stat.size < minSize) {
    logger.debug(`File is too small and may be invalid: ${filepath} (${stat.size} bytes)`);
    return false;
  }

  try {
    const content = fs.readFileSync(filepath, "utf-8");
    const data: unknown = JSON.parse(content);

    if (data === null || data === undefined) {
      logger.debug(`File content is null/undefined: ${filepath}`);
      return false;
    }

    if (
      typeof data === "object" &&
      !Array.isArray(data) &&
      Object.keys(data as object).length === 0
    ) {
      logger.debug(`File content is an empty object: ${filepath}`);
      return false;
    }

    if (Array.isArray(data) && data.length === 0) {
      logger.debug(`File content is an empty array: ${filepath}`);
      return false;
    }

    if (typeof data === "string" && !data.trim()) {
      logger.debug(`File content is an empty string: ${filepath}`);
      return false;
    }

    return true;
  } catch (e) {
    if (e instanceof SyntaxError) {
      logger.debug(`Invalid JSON format: ${filepath} - ${e}`);
    } else {
      logger.error(`Failed to read file: ${filepath} - ${e}`);
    }
    return false;
  }
}

/**
 * Validate that an output file already exists and is usable for resume.
 *
 * Strategy by extension:
 *   - .json -> parse and verify non-empty JSON via isValidJsonFile().
 *   - other files -> valid when the file exists and is non-empty.
 *
 * @param filepath File path.
 * @returns true when the file is valid and work can be skipped.
 */
export function isValidOutputFile(filepath: string): boolean {
  if (!fs.existsSync(filepath)) return false;

  const stat = fs.statSync(filepath);
  if (stat.size === 0) return false;

  const ext = path.extname(filepath).toLowerCase();

  if (ext === ".json") {
    return isValidJsonFile(filepath);
  }

  // Non-JSON files cannot be parsed for completeness, so callers rely on
  // atomic writes to guarantee files are either complete or absent.
  return true;
}

/**
 * Atomically write a file by writing a temporary file first, then renaming it.
 *
 * This prevents resume checks from treating partially written files as valid
 * after an interrupted process.
 *
 * @param filepath Target file path.
 * @param content String content to write.
 */
export function atomicWriteFileSync(filepath: string, content: string): void {
  const tmpPath = filepath + ".tmp";

  try {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  } catch {
    // A stale temp file may have already been removed by another process.
  }

  try {
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, filepath);
  } catch (e) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Preserve the original write/rename error.
    }
    throw e;
  }
}

/**
 * Ensure a base directory and its required subdirectories exist.
 *
 * @param baseDir Base directory.
 * @param subdirs Subdirectory names. Defaults to ["outputs"].
 * @returns A path map where each key is the directory name.
 */
export function ensureDirectoryStructure(
  baseDir: string,
  subdirs: string[] = ["outputs"]
): Record<string, string> {
  fs.mkdirSync(baseDir, { recursive: true });

  const paths: Record<string, string> = { base: baseDir };
  for (const subdir of subdirs) {
    const subdirPath = path.join(baseDir, subdir);
    fs.mkdirSync(subdirPath, { recursive: true });
    paths[subdir] = subdirPath;
  }

  logger.debug(`Directory structure ensured: ${baseDir} (subdirs: ${subdirs})`);
  return paths;
}

/**
 * Create a zero-cost metadata object.
 *
 * Used as a safe default so callers do not need to handle undefined cost data.
 */
export function createZeroCostInfo(): Record<string, unknown> {
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    input_cost: 0.0,
    output_cost: 0.0,
    total_cost: 0.0,
    currency: "CNY",
    pricing_available: false,
  };
}

/**
 * Safely read cost metadata from a StepResult or history metadata object.
 *
 * - Accepts both output_tokens and completion_tokens.
 * - Fills missing numeric fields with zero.
 * - Returns zero-cost metadata when metadata is invalid.
 *
 * @param metadata Metadata from StepResult.metadata or a context.history entry.
 */
export function safeGetCostInfo(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object") {
    return createZeroCostInfo();
  }

  const cost = metadata["cost"];
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) {
    return createZeroCostInfo();
  }

  const costObj = cost as Record<string, unknown>;

  if (!("output_tokens" in costObj)) {
    costObj["output_tokens"] =
      "completion_tokens" in costObj ? costObj["completion_tokens"] : 0;
  }

  const defaults: Record<string, unknown> = {
    total_cost: 0.0,
    input_cost: 0.0,
    output_cost: 0.0,
    input_tokens: 0,
    total_tokens: 0,
    currency: "CNY",
  };
  for (const [field, def] of Object.entries(defaults)) {
    if (!(field in costObj)) {
      costObj[field] = def;
    }
  }

  return costObj;
}

/**
 * Format error context into a single readable log line.
 *
 * @param error Error object or thrown value.
 * @param item Current item being processed.
 * @param stepConfig Optional step config used to extract type/model.
 * @param index Optional item index.
 */
export function formatErrorContext(
  error: unknown,
  item?: unknown,
  stepConfig?: Record<string, unknown>,
  index?: number
): string {
  const errName = error instanceof Error ? error.constructor.name : "Error";
  const parts = [`Error: ${errName}: ${String(error)}`];

  if (index !== undefined) {
    parts.push(`Item index: ${index}`);
  }

  if (item !== undefined) {
    let itemStr = String(item);
    if (itemStr.length > 100) {
      itemStr = itemStr.slice(0, 100) + "...";
    }
    parts.push(`Item: ${itemStr}`);
  }

  if (stepConfig) {
    const stepType = stepConfig["type"] ?? "unknown";
    parts.push(`Step type: ${stepType}`);
    if ("model" in stepConfig) {
      parts.push(`Model: ${stepConfig["model"]}`);
    }
  }

  return parts.join(" | ");
}

/**
 * Format a path template by replacing placeholders with values.
 *
 * Supported placeholders:
 *   {key}     -> string form of vars[key]
 *   {key:04d} -> zero-padded number, for example index=3 becomes "0003"
 *
 * @param template Path string containing placeholders.
 * @param vars Replacement variables keyed by placeholder name.
 * @throws Error when the template references a missing variable.
 */
export function formatPathTemplate(
  template: string,
  vars: Record<string, unknown>
): string {
  return template.replace(/\{(\w+)(?::0(\d+)d)?\}/g, (_, key: string, width?: string) => {
    if (!(key in vars)) throw new Error(`Path template is missing variable: ${key}`);
    const val = vars[key];
    if (width !== undefined && typeof val === "number") {
      return String(val).padStart(parseInt(width), "0");
    }
    return String(val);
  });
}

/**
 * Read a value from a nested object by dot-separated path.
 *
 * Examples:
 *   deepGet({ a: { b: { c: 42 } } }, "a.b.c") -> 42
 *   deepGet({ a: { b: 1 } }, "a.x.y", "default") -> "default"
 *   deepGet({ name: "test" }, "name") -> "test"
 *
 * @param data Source object.
 * @param keyPath Dot-separated path, such as "a.b.c".
 * @param defaultValue Value returned when the path is missing.
 */
export function deepGet(
  data: Record<string, unknown>,
  keyPath: string,
  defaultValue: unknown = undefined
): unknown {
  let current: unknown = data;
  for (const key of keyPath.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return defaultValue;
    }
    const obj = current as Record<string, unknown>;
    if (!(key in obj)) return defaultValue;
    current = obj[key];
  }
  return current;
}
