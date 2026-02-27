/**
 * 工作流动作工具函数
 *
 * 包含文件校验、目录管理、成本数据处理、错误格式化等通用功能。
 * 均为纯函数，不依赖任何动作类。
 *
 * 注：create_simple_action / create_llm_action 两个工厂函数不迁移。
 * 理由：仅是构造函数的薄包装，TS 有类型提示后直接 new 更清晰，无保留价值。
 */

// fs 是 Node.js 内置的文件系统模块，提供文件读写、状态查询（statSync）、存在性检查（existsSync）等功能
import fs from "fs";
// path 是 Node.js 内置的路径处理模块，提供路径拼接（path.join）等功能
import path from "path";

/**
 * 简易日志对象
 *
 * 当前直接包装 console 方法，后续可替换为 winston / pino 等正式日志库。
 * 之所以不直接用 console.debug/info/error，是为了统一入口便于未来切换。
 */
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
  // 第一步：检查文件是否存在
  if (!fs.existsSync(filepath)) return false;

  // 第二步：检查文件大小是否达标
  // 为什么要检查大小？极小的文件（如只有几字节）通常是空白或损坏的，
  // 跳过它们可以避免后续无意义的 JSON 解析开销
  const stat = fs.statSync(filepath);
  if (stat.size < minSize) {
    logger.debug(`文件过小，可能无效: ${filepath} (${stat.size}字节)`);
    return false;
  }

  try {
    // 第三步：读取文件并尝试 JSON 解析
    const content = fs.readFileSync(filepath, "utf-8");
    // JSON.parse 返回值可能是 object / array / string / number / boolean / null
    // 所以用 unknown 类型接收，后续逐一判断
    const data: unknown = JSON.parse(content);

    // 第四步：逐一排除"语法正确但内容为空"的边界情况
    // JSON 中 null 是合法值，但对业务来说等于没有数据
    if (data === null || data === undefined) {
      logger.debug(`文件内容为null/undefined: ${filepath}`);
      return false;
    }

    // 空对象 {} — 语法合法但没有有效数据
    // typeof null === "object"，但前面已排除 null，这里是安全的
    if (
      typeof data === "object" &&
      !Array.isArray(data) &&
      Object.keys(data as object).length === 0
    ) {
      logger.debug(`文件内容为空字典: ${filepath}`);
      return false;
    }

    // 空数组 [] — 同理，合法但无数据
    if (Array.isArray(data) && data.length === 0) {
      logger.debug(`文件内容为空列表: ${filepath}`);
      return false;
    }

    // 空字符串 "" 或纯空白字符串 "   " — JSON 中 "\"\"" 是合法值
    if (typeof data === "string" && !data.trim()) {
      logger.debug(`文件内容为空字符串: ${filepath}`);
      return false;
    }

    // 通过所有检查，文件有效
    return true;
  } catch (e) {
    // JSON.parse 抛出 SyntaxError 说明文件内容不是合法 JSON
    if (e instanceof SyntaxError) {
      logger.debug(`JSON格式错误: ${filepath} - ${e}`);
    } else {
      // 其他错误（权限不足、磁盘 I/O 等）用 error 级别记录
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
  // 第一步：创建基础目录
  // { recursive: true } 等同于 mkdir -p，目录已存在时不报错，也会自动创建中间目录
  fs.mkdirSync(baseDir, { recursive: true });

  // 第二步：遍历子目录列表，逐一创建并记录路径
  // 返回值示例：{ base: "/project", outputs: "/project/outputs" }
  const paths: Record<string, string> = { base: baseDir };
  for (const subdir of subdirs) {
    const subdirPath = path.join(baseDir, subdir);
    fs.mkdirSync(subdirPath, { recursive: true });
    // 用子目录名作为 key，方便调用方按名称取路径：paths["outputs"]
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
  // 返回值结构对应 LLM API 的计费字段
  // pricing_available: false 表示没有实际的定价数据（只是占位默认值）
  return {
    input_tokens: 0,       // 输入 token 数
    output_tokens: 0,      // 输出 token 数
    total_tokens: 0,       // 总 token 数（= input + output）
    input_cost: 0.0,       // 输入费用（美元）
    output_cost: 0.0,      // 输出费用（美元）
    total_cost: 0.0,       // 总费用
    pricing_available: false, // 是否有可用的定价信息
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
  // 第一步：防御性检查 metadata 本身
  // 调用方可能传入 null / undefined / 非对象值
  if (!metadata || typeof metadata !== "object") {
    return createZeroCostInfo();
  }

  // 第二步：从 metadata 中取出 cost 字段
  // metadata 结构示例：{ cost: { input_tokens: 100, output_tokens: 50, ... }, model: "gpt-4" }
  const cost = metadata["cost"];
  // cost 可能不存在、是 null、是数组等，都视为无效
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) {
    return createZeroCostInfo();
  }

  const costObj = cost as Record<string, unknown>;

  // 第三步：兼容不同 API 的字段命名
  // OpenAI API 返回 completion_tokens，Anthropic API 返回 output_tokens
  // 统一使用 output_tokens 作为标准字段名
  if (!("output_tokens" in costObj)) {
    costObj["output_tokens"] =
      "completion_tokens" in costObj ? costObj["completion_tokens"] : 0;
  }

  // 第四步：补全可能缺失的字段，确保返回值结构完整
  // 这样调用方可以直接取值而无需判断字段是否存在
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
  // 第一步：提取错误类名
  // 如果是标准 Error 子类（如 TypeError, RangeError），取 constructor.name
  // 否则降级为通用的 "Error"
  const errName = error instanceof Error ? error.constructor.name : "Error";
  // 用数组收集各部分信息，最后用 " | " 连接成一行
  // 输出示例："错误: TypeError: xxx | 项目索引: 3 | 步骤类型: llm_call | 模型: gpt-4"
  const parts = [`错误: ${errName}: ${String(error)}`];

  // 第二步：可选字段——项目索引（在批量处理中标识第几个数据项出错）
  if (index !== undefined) {
    parts.push(`项目索引: ${index}`);
  }

  // 第三步：可选字段——数据项内容预览
  if (item !== undefined) {
    let itemStr = String(item);
    // 截断过长的内容，避免日志行过长导致可读性下降
    if (itemStr.length > 100) {
      itemStr = itemStr.slice(0, 100) + "...";
    }
    parts.push(`项目: ${itemStr}`);
  }

  // 第四步：可选字段——步骤配置信息（类型和模型名）
  if (stepConfig) {
    const stepType = stepConfig["type"] ?? "unknown";
    parts.push(`步骤类型: ${stepType}`);
    if ("model" in stepConfig) {
      parts.push(`模型: ${stepConfig["model"]}`);
    }
  }

  // 用管道符分隔各部分，方便在日志中快速定位
  return parts.join(" | ");
}

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

/**
 * 从嵌套对象中按点路径取值
 *
 * 支持形如 "result.translated_text" 的路径。
 * 不含点号时等同于 obj[key]。
 * 路径中任意层级不存在时返回 defaultValue。
 *
 * 使用示例：
 *   deepGet({ a: { b: { c: 42 } } }, "a.b.c")       → 42
 *   deepGet({ a: { b: 1 } }, "a.x.y", "默认值")      → "默认值"
 *   deepGet({ name: "test" }, "name")                  → "test"（无点号时等同于 obj["name"]）
 *
 * @param data         源数据对象
 * @param keyPath      点分隔路径，如 "a.b.c"
 * @param defaultValue 路径不存在时的默认值，默认 undefined
 */
export function deepGet(
  data: Record<string, unknown>,
  keyPath: string,
  defaultValue: unknown = undefined
): unknown {
  // 从顶层对象开始，逐层向下取值
  // split(".") 将 "a.b.c" 拆成 ["a", "b", "c"]，然后 for...of 逐段遍历
  // 为什么用 for...of 而不是 reduce？因为遇到中间层级不存在时需要提前 return defaultValue，
  // reduce 没有提前退出机制，而 for 循环可以随时 return 中断
  let current: unknown = data;
  for (const key of keyPath.split(".")) {
    // 当前层级不是对象（可能是 null / 基本类型 / 数组），无法继续取子属性
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return defaultValue;
    }
    const obj = current as Record<string, unknown>;
    // 当前层级没有目标 key，路径中断
    if (!(key in obj)) return defaultValue;
    // 进入下一层
    current = obj[key];
  }
  // 遍历完所有层级后，current 就是目标值
  return current;
}
