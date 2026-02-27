/**
 * 工作流动作工具函数
 *
 * 包含文件校验、目录管理、成本数据处理、错误格式化等通用功能。
 * 均为纯函数，不依赖任何动作类。
 *
 * 注：create_simple_action / create_llm_action 两个工厂函数不迁移。
 * 理由：仅是构造函数的薄包装，TS 有类型提示后直接 new 更清晰，无保留价值。
 */

import fs from "fs";
import path from "path";

const logger = {
  debug: (msg: string) => console.debug(msg),
  info: (msg: string) => console.info(msg),
  error: (msg: string) => console.error(msg),
};

/**
 * 验证 JSON 文件是否有效且完整
 *
 * 依次检查：文件是否存在、大小是否达标、能否解析、内容是否非空。
 *
 * @param filepath 文件路径
 * @param minSize  最小文件大小（字节），默认 10
 */
export function isValidJsonFile(filepath: string, minSize = 10): boolean {
  if (!fs.existsSync(filepath)) return false;

  const stat = fs.statSync(filepath);
  if (stat.size < minSize) {
    logger.debug(`文件过小，可能无效: ${filepath} (${stat.size}字节)`);
    return false;
  }

  try {
    const content = fs.readFileSync(filepath, "utf-8");
    const data: unknown = JSON.parse(content);

    if (data === null || data === undefined) {
      logger.debug(`文件内容为null/undefined: ${filepath}`);
      return false;
    }

    if (
      typeof data === "object" &&
      !Array.isArray(data) &&
      Object.keys(data as object).length === 0
    ) {
      logger.debug(`文件内容为空字典: ${filepath}`);
      return false;
    }

    if (Array.isArray(data) && data.length === 0) {
      logger.debug(`文件内容为空列表: ${filepath}`);
      return false;
    }

    if (typeof data === "string" && !data.trim()) {
      logger.debug(`文件内容为空字符串: ${filepath}`);
      return false;
    }

    return true;
  } catch (e) {
    if (e instanceof SyntaxError) {
      logger.debug(`JSON格式错误: ${filepath} - ${e}`);
    } else {
      logger.error(`读取文件失败: ${filepath} - ${e}`);
    }
    return false;
  }
}

/**
 * 确保目录结构存在，创建必要的子目录
 *
 * @param baseDir 基础目录
 * @param subdirs 子目录列表，默认 ["outputs"]
 * @returns 包含所有路径的字典，key 为目录名，value 为绝对路径
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

  logger.debug(`目录结构已确保: ${baseDir} (子目录: ${subdirs})`);
  return paths;
}

/**
 * 创建全零的成本信息字典
 *
 * 用作默认值，避免调用方处理 undefined。
 */
export function createZeroCostInfo(): Record<string, unknown> {
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    input_cost: 0.0,
    output_cost: 0.0,
    total_cost: 0.0,
    pricing_available: false,
  };
}

/**
 * 安全获取成本信息，处理各种可能的数据结构
 *
 * - 兼容 output_tokens / completion_tokens 两种字段命名
 * - 缺失字段自动补零
 * - metadata 无效时返回零成本
 *
 * @param metadata 元数据字典（来自 StepResult.metadata 或 context.history 条目）
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

  // 兼容 output_tokens / completion_tokens 两种命名
  if (!("output_tokens" in costObj)) {
    costObj["output_tokens"] =
      "completion_tokens" in costObj ? costObj["completion_tokens"] : 0;
  }

  // 补全缺失字段
  const defaults: Record<string, unknown> = {
    total_cost: 0.0,
    input_cost: 0.0,
    output_cost: 0.0,
    input_tokens: 0,
    total_tokens: 0,
  };
  for (const [field, def] of Object.entries(defaults)) {
    if (!(field in costObj)) {
      costObj[field] = def;
    }
  }

  return costObj;
}

/**
 * 格式化错误上下文信息
 *
 * 将异常、项目索引、item、步骤配置拼成一行可读字符串，供日志输出。
 *
 * @param error      异常对象
 * @param item       正在处理的数据项（可选）
 * @param stepConfig 步骤配置（可选，用于提取 type / model）
 * @param index      项目索引（可选）
 */
export function formatErrorContext(
  error: unknown,
  item?: unknown,
  stepConfig?: Record<string, unknown>,
  index?: number
): string {
  const errName = error instanceof Error ? error.constructor.name : "Error";
  const parts = [`错误: ${errName}: ${String(error)}`];

  if (index !== undefined) {
    parts.push(`项目索引: ${index}`);
  }

  if (item !== undefined) {
    let itemStr = String(item);
    if (itemStr.length > 100) {
      itemStr = itemStr.slice(0, 100) + "...";
    }
    parts.push(`项目: ${itemStr}`);
  }

  if (stepConfig) {
    const stepType = stepConfig["type"] ?? "unknown";
    parts.push(`步骤类型: ${stepType}`);
    if ("model" in stepConfig) {
      parts.push(`模型: ${stepConfig["model"]}`);
    }
  }

  return parts.join(" | ");
}

/**
 * 从嵌套对象中按点路径取值
 *
 * 支持形如 "result.translated_text" 的路径。
 * 不含点号时等同于 obj[key]。
 * 路径中任意层级不存在时返回 defaultValue。
 *
 * @param data         源数据对象
 * @param keyPath      点分隔路径，如 "a.b.c"
 * @param defaultValue 路径不存在时的默认值，默认 undefined
 */
/**
 * 格式化路径模板，将模板中的占位符替换为实际值。
 *
 * 支持两种占位符格式：
 *   {key}      — 直接替换为变量值的字符串形式，例如 {name} → "test"
 *   {key:04d}  — 零补全数字格式，例如 {index:04d}（index=3）→ "0003"
 *
 * 使用示例：
 *   formatPathTemplate("output/{name}.json", { name: "test" })
 *   → "output/test.json"
 *
 *   formatPathTemplate("page_{index:04d}.json", { index: 3 })
 *   → "page_0003.json"
 *
 * @param template 包含占位符的路径字符串
 * @param vars     替换变量的字典，键名对应占位符中的变量名
 * @throws Error   模板中引用了 vars 中不存在的变量时抛出
 */
export function formatPathTemplate(
  template: string,
  vars: Record<string, unknown>
): string {
  // 正则表达式拆解：
  //   \{(\w+)        — 匹配 { 开头，捕获变量名（字母/数字/下划线）
  //   (?::0(\d+)d)?  — 可选：匹配 :04d 这种格式，捕获宽度数字（如 "4"）
  //   \}             — 匹配 } 结尾
  // 回调函数参数：_ 是完整匹配，key 是变量名，width 是宽度数字（可能是 undefined）
  return template.replace(/\{(\w+)(?::0(\d+)d)?\}/g, (_, key: string, width?: string) => {
    // 变量名不在字典里，直接报错，避免生成错误路径
    if (!(key in vars)) throw new Error(`路径模板缺少变量: ${key}`);
    const val = vars[key];
    // 有宽度且值是数字 → 用 padStart 在左侧补零到指定长度
    // 例如 val=3, width="4" → String(3).padStart(4, "0") → "0003"
    if (width !== undefined && typeof val === "number") {
      return String(val).padStart(parseInt(width), "0");
    }
    // 无宽度要求 → 直接转字符串
    return String(val);
  });
}

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
