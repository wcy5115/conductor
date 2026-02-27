/**
 * 输入输出动作
 *
 * 包含保存数据、日志记录、文件读取和合并 JSON 文件等动作。
 * 与 data_actions.ts 的区别：这里的动作均涉及文件 I/O 或日志输出等副作用。
 */

// fs 是 Node.js 内置的文件系统模块，提供读文件、写文件、检查文件是否存在等功能
import fs from "fs";
// path 是 Node.js 内置的路径处理模块，提供路径拼接（path.join）、取目录名（path.dirname）等功能
import path from "path";
// WorkflowContext 是工作流的全局上下文，其中 context.data 是步骤间共享的数据容器
// StepResult 是每个步骤执行完毕后的返回值，包含：下一步名称、新数据、元数据
import { WorkflowContext, StepResult } from "../workflow_engine.js";
// BaseAction 是所有动作的基类，提供 run() 方法，内部会调用子类实现的 execute()
import { BaseAction } from "./base.js";
// formatPathTemplate 将路径模板中的 {key} / {key:04d} 占位符替换为实际值
// 原本定义在本文件内，因 concurrent_actions.ts 也需要使用，已提取到 utils.ts 作为公共函数
import { formatPathTemplate } from "./utils.js";

/**
 * 简单的 glob 通配符匹配函数。
 *
 * 将 glob 模式转换为正则表达式后进行匹配：
 *   *  → 匹配任意多个字符（对应正则 .*）
 *   ?  → 匹配单个任意字符（对应正则 .）
 *
 * 注意：不支持 ** 递归匹配和 {a,b} 多选模式。
 * 这是为了避免引入第三方 glob 包（Node.js 没有内置 glob）而实现的简化替代方案。
 * 当前使用场景（匹配同一目录下的 *.json 文件）不需要这些高级功能。
 *
 * 使用示例：
 *   matchGlobPattern("page_001.json", "*.json")     → true
 *   matchGlobPattern("page_001.json.bak", "*.json") → false
 *   matchGlobPattern("page_a.json", "page_?.json")  → true
 *
 * @param filename 要匹配的文件名（仅文件名，不含目录路径）
 * @param pattern  通配符模式，如 "*.json" 或 "page_*.json"
 */
function matchGlobPattern(filename: string, pattern: string): boolean {
  // 第一步：把正则特殊字符全部转义，防止它们被当作正则语法解释
  // 例如：pattern 中的 "." 是字面点号，需要转义为 "\."，否则正则里 . 匹配任意字符
  // 转义范围：. + ^ $ { } ( ) | [ ] \，但此时 * 和 ? 还没有转义（下一步处理）
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // 第二步：把 glob 通配符替换为对应的正则语法
  //   * → .* （匹配零个或多个任意字符）
  //   ? → .  （匹配恰好一个任意字符）
  const regexStr = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  // 第三步：加上 ^ 和 $ 锚定，确保是完整匹配（而不是只要包含就算匹配）
  return new RegExp(`^${regexStr}$`).test(filename);
}

// ============================================================
// SaveDataAction — 保存数据动作
// ============================================================

/**
 * 保存数据动作
 *
 * 将上下文数据通过调用方提供的 saveFunc 函数保存到指定位置。
 * 具体保存逻辑（写到哪个文件、用什么格式等）完全由调用方在 saveFunc 中实现。
 *
 * 与 DataProcessAction 的区别：
 *   - DataProcessAction 的函数返回新数据，会被合并进上下文
 *   - SaveDataAction 的函数返回 void，只执行保存副作用，不修改上下文数据
 */
export class SaveDataAction extends BaseAction {
  // saveFunc：调用方在构造时传入的保存函数，接收整个 context.data 作为参数
  private readonly saveFunc: (data: Record<string, unknown>) => void;
  // nextStep：执行完毕后跳转到哪个步骤，默认 "END" 表示结束工作流
  private readonly nextStep: string;

  constructor(
    saveFunc: (data: Record<string, unknown>) => void,
    nextStep: string = "END",
    name?: string,
    config: Record<string, unknown> = {}
  ) {
    // 调用父类 BaseAction 的构造函数，初始化 name 和 config
    super(name, config);
    this.saveFunc = saveFunc;
    this.nextStep = nextStep;
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    // 把整个 context.data 传给用户提供的保存函数，由它决定如何存储
    this.saveFunc(context.data);
    // 第二个参数是空对象 {}，表示这个动作不向上下文中写入任何新数据
    // 第三个参数 { saved: true } 是元数据，仅用于日志/调试，不影响业务逻辑
    return new StepResult(this.nextStep, {}, { saved: true });
  }
}

// ============================================================
// LogAction — 日志记录动作
// ============================================================

/**
 * 日志级别 → console 输出方法的映射表。
 *
 * 将字符串形式的日志级别（如 "info"）映射到对应的 console 方法。
 * warning 和 warn 都映射到 console.warn，兼容两种常见写法。
 *
 * 注意：类型是 Record<string, (msg: string) => void>，
 * 这意味着 TS 认为用任意字符串索引时结果可能是 undefined，
 * 所以使用时需要用 ?? 提供兜底值。
 */
const LOG_LEVEL_MAP: Record<string, (msg: string) => void> = {
  debug: (msg) => console.debug(msg),
  info: (msg) => console.info(msg),
  warning: (msg) => console.warn(msg),  // Python 中常用 "warning"，这里兼容
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg),
};

/**
 * 日志记录动作
 *
 * 将当前上下文数据按指定级别输出到控制台。
 * messageTemplate 中可使用 {data} 占位符，执行时会被替换为 context.data 的 JSON 字符串。
 *
 * 例如 messageTemplate = "处理完成，数据: {data}"，
 * 执行时会输出：处理完成，数据: {"name": "test", "count": 3}
 */
export class LogAction extends BaseAction {
  // messageTemplate：日志消息模板，支持 {data} 占位符
  private readonly messageTemplate: string;
  // logLevel：日志级别字符串，构造时会统一转为小写
  private readonly logLevel: string;
  private readonly nextStep: string;

  constructor(
    messageTemplate: string = "当前数据: {data}",
    logLevel: string = "INFO",
    nextStep: string = "END",
    name?: string,
    config: Record<string, unknown> = {}
  ) {
    super(name, config);
    this.messageTemplate = messageTemplate;
    // 统一转小写，使 "INFO"、"Info"、"info" 都能正确匹配 LOG_LEVEL_MAP 的键名
    this.logLevel = logLevel.toLowerCase();
    this.nextStep = nextStep;
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    // 把模板中的 {data} 替换为当前上下文数据的 JSON 字符串
    const message = this.messageTemplate.replace(
      "{data}",
      JSON.stringify(context.data)
    );

    // 从映射表中取对应的 console 方法
    // ?? 右侧用内联函数而不是 LOG_LEVEL_MAP["info"]，
    // 原因：TS 认为 Record 的索引访问结果类型包含 undefined，
    //       所以 LOG_LEVEL_MAP["info"] 也被认为可能是 undefined，无法直接调用。
    //       内联函数 (msg) => console.info(msg) 类型明确，不存在此问题。
    const logFn = LOG_LEVEL_MAP[this.logLevel] ?? ((msg: string) => console.info(msg));
    logFn(message);

    // 这个动作不修改上下文数据，第二个参数传空对象
    return new StepResult(this.nextStep, {}, { logged: true });
  }
}

// ============================================================
// ReadFileAction — 读取文件动作
// ============================================================

/**
 * 读取文件动作
 *
 * 从磁盘读取一个文件的内容，存入上下文中指定的键名。
 *
 * pathTemplate 支持占位符（调用 formatPathTemplate 处理）：
 *   {index}      — 1-based 序号（由 item_index 自动计算得出，与 save_to_file 文件名对齐）
 *   {item_index} — 0-based 序号（来自 context.data）
 *   {item}       — 当前处理项的值（来自 context.data）
 *   {key:04d}    — 零补全数字格式
 *   以及所有其他 context.data 中存在的键
 */
export class ReadFileAction extends BaseAction {
  // pathTemplate：文件路径模板，支持占位符，例如 "output/{index:04d}.json"
  private readonly pathTemplate: string;
  // outputKey：读取到的文件内容存入 context.data 的哪个键，默认 "file_content"
  private readonly outputKey: string;
  // encoding：文件编码，默认 utf-8（读取 JSON/文本文件时的常用编码）
  private readonly encoding: BufferEncoding;
  // missingOk：文件不存在时的处理策略
  //   true  → 打印警告并返回空字符串，不中断工作流
  //   false → 直接抛出错误，中断工作流
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
    // 构建格式化变量：先复制 context.data 的所有字段，再追加计算出的 index
    const formatVars: Record<string, unknown> = { ...context.data };
    // item_index 是 0-based（如循环中的第 0、1、2 项），
    // 但保存文件时通常用 1-based 编号（如 page_0001.json）。
    // 这里自动计算出 index = item_index + 1，供路径模板使用，无需调用方手动换算。
    if (typeof formatVars["item_index"] === "number") {
      formatVars["index"] = (formatVars["item_index"] as number) + 1;
    }

    // 将路径模板展开为实际文件路径
    let filepath: string;
    try {
      filepath = formatPathTemplate(this.pathTemplate, formatVars);
    } catch (e) {
      throw new Error(`read_file path_template 缺少变量: ${e}`);
    }

    let content: string;
    if (!fs.existsSync(filepath)) {
      if (this.missingOk) {
        // missingOk=true：容忍文件不存在，返回空字符串继续流程
        console.warn(`read_file: 文件不存在，返回空内容: ${filepath}`);
        content = "";
      } else {
        // missingOk=false（默认）：文件不存在视为错误，抛出异常中断流程
        throw new Error(`read_file: 文件不存在: ${filepath}`);
      }
    } else {
      content = fs.readFileSync(filepath, this.encoding);
      console.debug(
        `read_file: 读取成功: ${filepath} (${content.length} 字符)`
      );
    }

    // { [this.outputKey]: content } 是计算属性名语法。
    // 如果 outputKey = "file_content"，则返回的数据是 { file_content: "..." }，
    // 引擎会将这个对象合并进 context.data，后续步骤就能通过 context.data.file_content 访问。
    return new StepResult(
      this.nextStep,
      { [this.outputKey]: content },
      { file_path: filepath, chars_read: content.length }
    );
  }
}

// ============================================================
// MergeJsonFilesAction — 合并 JSON 文件动作
// ============================================================

/**
 * 合并 JSON 文件动作
 *
 * 从指定目录读取多个符合 glob 模式的 JSON 文件，
 * 将它们的内容合并成一个 JSON 数组，并保存到输出文件。
 *
 * 典型使用场景：
 *   并发步骤将每个结果分别存为独立 JSON 文件，
 *   最后用这个动作把所有结果合并成一个文件供后续步骤使用。
 */
export class MergeJsonFilesAction extends BaseAction {
  // inputDir：输入目录路径，支持路径模板占位符
  private readonly inputDir: string;
  // outputFile：合并后的输出文件路径，支持路径模板占位符
  private readonly outputFile: string;
  // pattern：glob 通配符模式，用于筛选目录中的文件，默认 "*.json"
  private readonly pattern: string;
  // sortBy：文件合并顺序
  //   "filename"      → 按文件名字母序排列（默认）
  //   "modified_time" → 按文件修改时间从早到晚排列
  //   "none"          → 不排序，使用文件系统返回的原始顺序
  private readonly sortBy: string;
  // outputKey：合并后的数组存入 context.data 的键名
  private readonly outputKey: string;
  private readonly nextStep: string;
  // stepId：仅用于日志输出中的步骤标识，不影响业务逻辑
  private readonly stepId: string;

  constructor(
    inputDir: string,
    outputFile: string,
    pattern: string = "*.json",
    sortBy: string = "filename",
    outputKey: string = "merged_data",
    nextStep: string = "END",
    name: string = "合并JSON文件",
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
    // 第一步：展开路径模板，把占位符替换为实际值
    let inputDir: string;
    let outputFile: string;
    try {
      inputDir = formatPathTemplate(this.inputDir, context.data);
      outputFile = formatPathTemplate(this.outputFile, context.data);
    } catch (e) {
      throw new Error(`路径模板缺少必要的上下文数据: ${e}`);
    }

    console.info(`[步骤${this.stepId}] 开始合并JSON文件`);
    console.info(`[步骤${this.stepId}] 输入目录: ${inputDir}`);
    console.info(`[步骤${this.stepId}] 输出文件: ${outputFile}`);

    // 第二步：检查输入目录是否存在
    // 目录不存在时不抛错，返回空数组继续工作流（容错设计）
    if (!fs.existsSync(inputDir)) {
      console.error(`[步骤${this.stepId}] 输入目录不存在: ${inputDir}`);
      return new StepResult(
        this.nextStep,
        { [this.outputKey]: [] },
        { error: `输入目录不存在: ${inputDir}` }
      );
    }

    // 第三步：列出目录中所有文件，用 matchGlobPattern 筛选匹配的文件
    // Node.js 没有内置 glob，所以用 readdirSync（读取目录）+ matchGlobPattern（通配符匹配）代替
    // filter 返回匹配的文件名列表，map 把文件名拼上目录路径，得到完整路径
    const allFiles = fs.readdirSync(inputDir);
    let jsonFiles = allFiles
      .filter((f) => matchGlobPattern(f, this.pattern))
      .map((f) => path.join(inputDir, f));

    // 没有匹配文件时，同样不报错，返回空数组
    if (jsonFiles.length === 0) {
      console.warn(
        `[步骤${this.stepId}] 未找到匹配的JSON文件: ${path.join(inputDir, this.pattern)}`
      );
      return new StepResult(
        this.nextStep,
        { [this.outputKey]: [] },
        { warning: "未找到匹配的JSON文件" }
      );
    }

    // 第四步：按指定策略排序
    if (this.sortBy === "filename") {
      // sort() 默认按字符串字母序排列，对于 page_001.json、page_002.json 这类命名很有效
      jsonFiles.sort();
    } else if (this.sortBy === "modified_time") {
      // fs.statSync(path).mtimeMs 返回文件最后修改时间的毫秒时间戳
      // 两个时间戳相减得到排序比较值（负数=a在前，正数=b在前）
      jsonFiles.sort(
        (a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs
      );
    }
    // sortBy === "none" 时不排序，保持 readdirSync 返回的原始顺序

    console.info(
      `[步骤${this.stepId}] 找到 ${jsonFiles.length} 个JSON文件，准备合并`
    );

    // 第五步：逐个读取并解析 JSON 文件
    const mergedData: unknown[] = [];  // 存放成功解析的数据
    const failedFiles: string[] = [];  // 记录读取/解析失败的文件，不中断整体流程

    for (const jsonFile of jsonFiles) {
      try {
        const content = fs.readFileSync(jsonFile, "utf-8");
        // JSON.parse 将文件内容字符串解析为 JS 对象/数组
        mergedData.push(JSON.parse(content));
      } catch (e) {
        // 单个文件失败不中断，记录到 failedFiles 后继续处理其他文件
        console.error(`[步骤${this.stepId}] 读取文件失败 ${jsonFile}: ${e}`);
        failedFiles.push(jsonFile);
      }
    }

    // 第六步：将合并后的数组写入输出文件
    // recursive: true 表示如果父目录不存在则自动创建，避免因目录不存在导致写入失败
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    // JSON.stringify(data, null, 2)：第三个参数 2 表示用 2 个空格缩进，生成人类可读的格式
    fs.writeFileSync(outputFile, JSON.stringify(mergedData, null, 2), "utf-8");

    console.info(
      `[步骤${this.stepId}] 成功合并 ${mergedData.length} 个文件到: ${outputFile}`
    );

    if (failedFiles.length > 0) {
      console.warn(
        `[步骤${this.stepId}] 有 ${failedFiles.length} 个文件读取失败`
      );
    }

    // 第七步：返回结果，向 context.data 写入三个键：
    //   outputKey           → 合并后的完整数组
    //   outputKey_count     → 成功合并的文件数量
    //   outputKey_file      → 输出文件的路径
    // 元数据（第三个参数）记录详细统计，供日志/调试使用，不影响后续步骤的业务逻辑
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
