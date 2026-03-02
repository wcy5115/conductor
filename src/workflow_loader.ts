/**
 * 工作流 YAML 加载器（Workflow Loader）
 *
 * 本模块是工作流框架的"组装工厂"：
 *   1. 从 YAML 文件读取工作流配置
 *   2. 解析工作流图（workflow_graph），确定步骤间的连接关系
 *   3. 根据步骤类型（type）创建对应的 Action 实例
 *   4. 将所有 Action 注册到 WorkflowEngine，使其可执行
 *
 * 典型使用流程：
 *   const { engine, workflowLogger, config } = new WorkflowLoader().loadFromYaml("config.yaml");
 *   await engine.runWorkflow({ startStep: "1", initialData: { input: "hello" } });
 *
 * 对应 Python 版：LLM_agent/src/workflow_loader.py
 */

// ============================================================
// 导入依赖
// ============================================================

// js-yaml：YAML 解析库，将 .yaml 文件内容解析为 JavaScript 对象
// 用法：yaml.load(yamlString) → JavaScript 对象
import yaml from "js-yaml";

// fs：Node.js 内置文件系统模块，用于读写文件、创建目录、检查文件是否存在
import fs from "fs";

// path：Node.js 内置路径处理模块，用于拼接路径（path.join）、获取目录名（path.dirname）等
import path from "path";

// WorkflowEngine：工作流执行引擎，负责按照图结构依次执行注册的 Action
import { WorkflowEngine } from "./workflow_engine.js";

// FractalParser：工作流图解析器，将 YAML 中的 workflow_graph 字符串/对象解析为 WorkflowGraph 实例
// WorkflowGraph：工作流图数据结构，记录步骤间的有向边（如 1→2→3）
// autoOutputKey：自动生成步骤输出键名的工具函数
//   例如：autoOutputKey("1") → "1_response"，autoOutputKey("2.1") → "2_1_response"
import { FractalParser, WorkflowGraph, autoOutputKey } from "./workflow_parser.js";

// StructuredLogger：结构化日志记录器，支持文件日志 + 控制台日志
import { StructuredLogger } from "./core/logging.js";

// BaseAction：所有动作的抽象基类，提供 run() 方法框架
// _createActionV2() 返回 BaseAction 类型，由引擎通过 action.run.bind(action) 注册
import { BaseAction } from "./workflow_actions/base.js";

// LLMCallAction：调用大语言模型的动作（支持 JSON 验证、重试等）
// 本文件中 _createLLMActionV2() 会创建此类的实例
import { LLMCallAction } from "./workflow_actions/llm_actions.js";

// SaveDataAction：保存数据到文件的动作，接收一个 saveFunc 回调
// LogAction：记录日志的动作，支持模板字符串（如 "步骤 {step_id}: {data}"）
// MergeJsonFilesAction：合并多个 JSON 文件为一个数组/对象的动作
import {
  SaveDataAction,
  LogAction,
  MergeJsonFilesAction,
} from "./workflow_actions/io_actions.js";

// DataProcessAction：数据处理动作，调用自定义函数对 context.data 进行转换
// ConditionalBranchAction：条件分支动作，根据条件函数返回值决定跳转到哪个步骤
import {
  DataProcessAction,
  ConditionalBranchAction,
} from "./workflow_actions/data_actions.js";

// ConcurrentAction：并发处理动作，并行处理数据列表中的每个元素
// ActionConfig：并发子步骤的配置接口，描述每个子步骤的类型和参数
// SaveToFileConfig：并发处理时每个结果保存到文件的配置接口
import { ConcurrentAction, ActionConfig, SaveToFileConfig } from "./workflow_actions/concurrent_actions.js";

// saveToFile：将字符串内容写入文件（自动创建父目录）
import { saveToFile } from "./utils.js";

// deepGet：通过点分路径访问嵌套对象的值
//   例如：deepGet({ a: { b: 42 } }, "a.b") → 42
import { deepGet } from "./workflow_actions/utils.js";

// ============================================================
// 类型定义
// ============================================================

/**
 * 条件函数类型
 *
 * 用于 ConditionalBranchAction：根据当前上下文数据决定跳转到哪个步骤
 * 参数：context.data（整个共享数据对象）
 * 返回值：下一步的步骤 ID（如 "2" 或 "3"）
 */
type ConditionFunc = (data: Record<string, unknown>) => string;

/**
 * 处理器函数类型
 *
 * 用于 DataProcessAction：对上下文数据进行加工处理
 * 参数：context.data（整个共享数据对象）
 * 返回值：处理结果（会被合并到 context.data 中）
 */
type ProcessorFunc = (data: Record<string, unknown>) => Record<string, unknown>;

/**
 * loadFromYaml 的返回类型
 *
 * engine：配置好的工作流引擎实例，可直接调用 engine.runWorkflow() 执行
 * workflowLogger：项目专属的结构化日志记录器，日志文件存放在 data/{project_name}/logs/
 * config：YAML 文件解析后的原始配置对象（供调用方读取额外的自定义字段）
 */
interface LoadResult {
  engine: WorkflowEngine;
  workflowLogger: StructuredLogger;
  config: Record<string, unknown>;
}

// ============================================================
// 简易日志器（模块级别）
// ============================================================

/**
 * 模块内部使用的简易日志器
 *
 * 不使用 StructuredLogger 的原因：
 *   StructuredLogger 需要指定日志目录，而加载器在创建工作空间之前就需要输出日志。
 *   使用简单的 console 输出避免循环依赖。
 */
const logger = {
  info: (msg: string) => console.info(`[WorkflowLoader] ${msg}`),
  debug: (msg: string) => console.debug(`[WorkflowLoader] ${msg}`),
  error: (msg: string) => console.error(`[WorkflowLoader] ${msg}`),
};

// ============================================================
// 工具函数
// ============================================================

/**
 * 递归替换路径占位符
 *
 * YAML 配置中常用 {paths.xxx} 占位符引用 paths 配置段中定义的路径，
 * 本函数将其替换为拼接了 workflowDir 的完整路径。
 *
 * 示例：
 *   YAML 配置：
 *     paths:
 *       output: "results"
 *     steps:
 *       1:
 *         filepath: "{paths.output}/result.json"
 *
 *   调用 resolvePathPlaceholders("{paths.output}/result.json", "data/myproject", { output: "results" })
 *   返回 "data/myproject/results/result.json"
 *
 * 递归处理逻辑：
 *   - 字符串：直接替换其中的 {paths.xxx} 占位符
 *   - 对象：递归处理每个值（键名不替换）
 *   - 数组：递归处理每个元素
 *   - 其他类型（数字、布尔等）：原样返回
 *
 * @param value       要处理的值（可能是 string / object / array / number 等任意类型）
 * @param workflowDir 工作流项目目录（如 "data/myproject"）
 * @param paths       YAML 中 paths 配置段的内容（如 { output: "results", images: "images" }）
 * @returns 替换占位符后的值，类型与输入相同
 */
export function resolvePathPlaceholders(
  value: unknown,
  workflowDir: string,
  paths: Record<string, string>
): unknown {
  // ---- 情况 1：字符串 → 替换其中的 {paths.xxx} ----
  if (typeof value === "string") {
    let result = value;
    // 遍历 paths 配置中的每个键值对
    // 例如 paths = { output: "results", images: "images" }
    for (const [key, pathValue] of Object.entries(paths)) {
      // 构造占位符字符串，如 "{paths.output}"
      const placeholder = `{paths.${key}}`;
      // 如果字符串中包含这个占位符，替换为完整路径
      if (result.includes(placeholder)) {
        // path.join 拼接路径，自动处理分隔符
        // 例如 path.join("data/myproject", "results") → "data/myproject/results"
        const fullPath = path.join(workflowDir, pathValue);
        // replaceAll 替换所有出现的占位符（一个字符串中可能多次出现）
        result = result.replaceAll(placeholder, fullPath);
      }
    }
    return result;
  }

  // ---- 情况 2：对象（但不是 null）→ 递归处理每个值 ----
  if (typeof value === "object" && value !== null) {
    // 数组和普通对象都是 object，需要分别处理
    if (Array.isArray(value)) {
      // ---- 情况 2a：数组 → 递归处理每个元素 ----
      return value.map((item) =>
        resolvePathPlaceholders(item, workflowDir, paths)
      );
    }
    // ---- 情况 2b：普通对象 → 递归处理每个值 ----
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = resolvePathPlaceholders(v, workflowDir, paths);
    }
    return result;
  }

  // ---- 情况 3：其他类型（number / boolean / null / undefined）→ 原样返回 ----
  return value;
}

// ============================================================
// 支持的 action 类型列表（用于错误信息展示）
// ============================================================

/**
 * 当前支持的所有 action 类型
 *
 * 在 _createActionV2 中如果遇到不认识的类型，会在报错信息中列出这些类型，
 * 帮助用户排查 YAML 中的拼写错误。
 */
const SUPPORTED_ACTION_TYPES = [
  "llm",
  "save_file",
  "conditional",
  "data_process",
  "log",
  "concurrent",
  "merge_json_files",
] as const;

// ============================================================
// WorkflowLoader 类
// ============================================================

/**
 * 工作流加载器
 *
 * 负责从 YAML 配置文件加载工作流定义，并创建可执行的 WorkflowEngine。
 *
 * 工作流程：
 *   1. loadFromYaml(yamlPath)
 *      ├─ 读取并解析 YAML 文件
 *      ├─ _createWorkflowWorkspace() → 创建目录结构 + 日志记录器
 *      └─ _loadV2() → 解析工作流图 + 创建 Action + 注册到引擎
 *           └─ _createActionV2() → 根据 type 分派到具体的 _create*ActionV2()
 *
 * 自定义函数机制：
 *   YAML 中 conditional 类型的步骤需要引用条件函数，data_process 类型需要引用处理函数。
 *   这些函数在 YAML 中只写名称（如 condition: "check_quality"），实际的函数实现
 *   需要在加载前通过 registerCondition / registerProcessor 注册到加载器中。
 *
 * 示例：
 *   const loader = new WorkflowLoader();
 *   loader.registerCondition("check_quality", (data) => data.score > 0.8 ? "2" : "3");
 *   loader.registerProcessor("format_output", (data) => ({ formatted: data.raw.trim() }));
 *   const { engine } = loader.loadFromYaml("workflow.yaml");
 */
export class WorkflowLoader {
  /**
   * 自定义条件函数注册表
   *
   * Map<条件名称, 条件函数>
   * 条件函数签名：(data: Record<string, unknown>) => string
   *   - 参数：context.data（整个共享数据对象）
   *   - 返回：下一步的步骤 ID（如 "2" 或 "3"）
   *
   * 在 YAML 中通过 condition 字段引用：
   *   steps:
   *     2:
   *       type: conditional
   *       condition: "check_quality"   ← 引用此注册表中的函数名
   */
  private _customConditions: Map<string, ConditionFunc> = new Map();

  /**
   * 自定义处理器函数注册表
   *
   * Map<处理器名称, 处理器函数>
   * 处理器函数签名：(data: Record<string, unknown>) => Record<string, unknown>
   *   - 参数：context.data（整个共享数据对象）
   *   - 返回：处理结果（会被合并到 context.data 中）
   *
   * 在 YAML 中通过 processor 字段引用：
   *   steps:
   *     3:
   *       type: data_process
   *       processor: "format_output"   ← 引用此注册表中的函数名
   */
  private _customProcessors: Map<string, ProcessorFunc> = new Map();

  /**
   * 注册自定义条件函数
   *
   * @param name 条件函数名称（对应 YAML 中 condition 字段的值）
   * @param conditionFunc 条件函数，接收 context.data，返回下一步的步骤 ID
   */
  registerCondition(name: string, conditionFunc: ConditionFunc): void {
    this._customConditions.set(name, conditionFunc);
    logger.debug(`注册自定义条件: ${name}`);
  }

  /**
   * 注册自定义处理器函数
   *
   * @param name 处理器函数名称（对应 YAML 中 processor 字段的值）
   * @param processFunc 处理器函数，接收 context.data，返回处理结果 dict
   */
  registerProcessor(name: string, processFunc: ProcessorFunc): void {
    this._customProcessors.set(name, processFunc);
    logger.debug(`注册自定义处理器: ${name}`);
  }

  /**
   * 从 YAML 文件加载工作流
   *
   * 这是加载器的主入口方法，完成以下工作：
   *   1. 读取 YAML 文件并解析为 JavaScript 对象
   *   2. 校验必需字段（project_name、workflow_graph）
   *   3. 创建工作流工作空间（目录结构 + 日志记录器）
   *   4. 解析工作流图并创建所有 Action
   *
   * @param yamlPath YAML 配置文件的路径（如 "workflows/my_workflow/config.yaml"）
   * @returns { engine, workflowLogger, config } 三元组
   * @throws FileNotFoundError 文件不存在时抛出
   * @throws Error 配置格式错误时抛出
   */
  loadFromYaml(yamlPath: string): LoadResult {
    // 第一步：检查文件是否存在
    if (!fs.existsSync(yamlPath)) {
      throw new Error(`工作流配置文件不存在: ${yamlPath}`);
    }

    // 第二步：读取 YAML 文件内容并解析
    logger.info(`加载工作流配置: ${yamlPath}`);
    const fileContent = fs.readFileSync(yamlPath, "utf-8");
    // yaml.load 将 YAML 字符串解析为 JavaScript 对象
    // 返回类型是 unknown，需要断言为 Record<string, unknown>
    const config = yaml.load(fileContent) as Record<string, unknown>;

    // 第三步：校验配置不为空
    if (!config) {
      throw new Error(`工作流配置文件为空: ${yamlPath}`);
    }

    // 第四步：校验必需字段 workflow_graph
    if (!("workflow_graph" in config)) {
      throw new Error(
        `工作流配置缺少 'workflow_graph' 字段: ${yamlPath}`
      );
    }

    // 第五步：创建工作流专属目录和日志记录器
    const { workflowDir, workflowLogger } = this._createWorkflowWorkspace(
      yamlPath,
      config
    );

    // 第六步：解析工作流图，创建 Action 并注册到引擎
    logger.info("加载工作流");
    const engine = this._loadV2(config, yamlPath, workflowDir);

    return { engine, workflowLogger, config };
  }

  /**
   * 创建工作流专属工作空间
   *
   * 根据 YAML 中的 project_name 和 paths 配置，创建项目目录结构：
   *   data/{project_name}/
   *   ├── logs/                    ← 日志文件存放目录
   *   ├── {paths.images}/         ← 自定义子目录（由 paths 配置决定）
   *   ├── {paths.results}/
   *   └── workflow_config.yaml     ← YAML 配置文件的备份
   *
   * @param yamlPath YAML 文件路径（用于复制配置文件备份）
   * @param config   YAML 解析后的配置对象
   * @returns { workflowDir, workflowLogger } 工作目录路径和日志记录器
   */
  private _createWorkflowWorkspace(
    yamlPath: string,
    config: Record<string, unknown>
  ): { workflowDir: string; workflowLogger: StructuredLogger } {
    // 第一步：获取项目名称（必填字段）
    const projectName = config["project_name"] as string | undefined;
    if (!projectName) {
      throw new Error("YAML配置缺少 'project_name' 字段");
    }

    // 第二步：创建项目主目录 data/{project_name}/
    const workflowDir = path.join("data", projectName);
    fs.mkdirSync(workflowDir, { recursive: true });

    // 第三步：根据 paths 配置创建子目录
    // paths 示例：{ images: "images", results: "results", output: "results/final.json" }
    const paths = (config["paths"] as Record<string, string>) ?? {};
    for (const [pathKey, pathValue] of Object.entries(paths)) {
      // 跳过 output 路径——它通常是文件路径而非目录
      // 例如 output: "results/final.json" 不应该创建名为 "results/final.json" 的目录
      if (pathKey !== "output") {
        const subDir = path.join(workflowDir, pathValue);
        fs.mkdirSync(subDir, { recursive: true });
      }
    }

    logger.info(`创建工作流目录: ${workflowDir}`);

    // 第四步：复制 YAML 配置文件到项目目录（留存备份，方便事后审计）
    const configCopy = path.join(workflowDir, "workflow_config.yaml");
    fs.copyFileSync(yamlPath, configCopy);

    // 第五步：创建结构化日志记录器
    // 日志文件存放在 data/{project_name}/logs/ 目录下
    const logsDir = path.join(workflowDir, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const workflowLogger = new StructuredLogger({ logDir: logsDir });

    return { workflowDir, workflowLogger };
  }

  /**
   * 加载 v2.0 版本的工作流配置
   *
   * v2.0 版本使用 workflow_graph 定义步骤间的连接关系，
   * 步骤配置中不需要手动写 next 和 output_key，由引擎自动推断。
   *
   * 流程：
   *   1. 用 FractalParser 解析 workflow_graph → WorkflowGraph 实例
   *   2. 创建 WorkflowEngine 并传入图结构
   *   3. 遍历每个步骤配置，替换路径占位符，创建 Action 并注册
   *
   * @param config      YAML 解析后的完整配置对象
   * @param yamlPath    YAML 文件路径（仅用于错误信息）
   * @param workflowDir 工作流项目目录路径
   * @returns 配置好的 WorkflowEngine 实例
   */
  private _loadV2(
    config: Record<string, unknown>,
    yamlPath: string,
    workflowDir: string
  ): WorkflowEngine {
    // 第一步：解析工作流图
    // FractalParser 支持两种输入格式：
    //   字符串格式："1 -> 2 -> 3"
    //   对象格式：{ "1": "2", "2": "3" }
    const parser = new FractalParser();
    // config["workflow_graph"] 可能是字符串（如 "1 -> 2 -> 3"）或对象格式
    // FractalParser.parse() 接受 string | Record<string, GraphValue>
    // 这里用 as any 做类型断言，因为 GraphValue 是 workflow_parser 内部类型，未导出
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const workflowGraph = parser.parse(config["workflow_graph"] as any);

    logger.info(`解析工作流图: ${Object.keys(workflowGraph.edges).length} 个节点`);

    // 第二步：创建工作流引擎，传入图结构
    // 引擎使用图结构来确定步骤的默认后继节点
    const engine = new WorkflowEngine(workflowGraph);

    // 第三步：获取步骤定义
    const steps = config["steps"] as Record<string, Record<string, unknown>> | undefined;
    if (!steps || Object.keys(steps).length === 0) {
      throw new Error(`工作流配置中没有定义步骤: ${yamlPath}`);
    }

    // 第四步：获取路径配置（用于替换 {paths.xxx} 占位符）
    const paths = (config["paths"] as Record<string, string>) ?? {};

    // 第五步：遍历每个步骤，创建 Action 并注册到引擎
    for (const [stepId, stepConfig] of Object.entries(steps)) {
      // 替换步骤配置中的路径占位符
      // 例如 filepath: "{paths.output}/result.json" → "data/myproject/results/result.json"
      const resolvedConfig = resolvePathPlaceholders(
        stepConfig,
        workflowDir,
        paths
      ) as Record<string, unknown>;

      // 根据步骤类型创建对应的 Action 实例（BaseAction 子类）
      const action = this._createActionV2(
        stepId,
        resolvedConfig,
        workflowGraph,
        workflowDir
      );

      // 将 Action 注册到引擎中
      // WorkflowEngine.registerAction 接受 ActionFn 类型（普通函数），
      // 而我们创建的是 BaseAction 实例（有 .run() 方法）。
      // 通过 action.run.bind(action) 将方法绑定为独立函数，
      // 等价于 (ctx) => action.run(ctx)，但 bind 更高效。
      engine.registerAction(stepId, action.run.bind(action));
      logger.debug(
        `注册步骤 (v2.0): ${stepId}, 类型: ${stepConfig["type"] as string}`
      );
    }

    logger.info(
      `工作流加载完成 (v2.0): ${(config["name"] as string) ?? "Unnamed"}, 共 ${Object.keys(steps).length} 个步骤`
    );

    return engine;
  }

  /**
   * 创建 v2.0 动作（类型分发工厂方法）
   *
   * 根据步骤配置中的 type 字段，分派到对应的 _create*ActionV2() 方法。
   * 每种 action 类型有不同的必填字段和构造参数。
   *
   * 支持的类型及对应的创建方法：
   *   "llm"              → _createLLMActionV2()
   *   "save_file"        → _createSaveFileActionV2()
   *   "conditional"      → _createConditionalActionV2()
   *   "data_process"     → _createDataProcessActionV2()
   *   "log"              → _createLogActionV2()
   *   "concurrent"       → _createConcurrentActionV2()
   *   "merge_json_files" → _createMergeJsonFilesActionV2()
   *
   * @param stepId       步骤 ID（如 "1"、"2.1"）
   * @param config       步骤的解析后配置（已替换路径占位符）
   * @param workflowGraph 工作流图（用于获取后继步骤）
   * @param workflowDir  工作流项目目录路径
   * @returns BaseAction 实例
   * @throws Error 类型不支持或必填字段缺失时抛出
   */
  private _createActionV2(
    stepId: string,
    config: Record<string, unknown>,
    workflowGraph: WorkflowGraph,
    workflowDir: string
  ): BaseAction {
    // 第一步：获取步骤类型（必填）
    const actionType = config["type"] as string | undefined;
    if (!actionType) {
      throw new Error(`步骤 ${stepId} 缺少 'type' 字段`);
    }

    // 第二步：获取步骤名称（可选，默认为 "step_{stepId}"）
    const stepName = (config["name"] as string) ?? `step_${stepId}`;

    // 第三步：根据类型分派到具体的创建方法
    switch (actionType) {
      case "llm":
        return this._createLLMActionV2(stepId, config, workflowGraph, workflowDir, stepName);
      case "save_file":
        return this._createSaveFileActionV2(stepId, config, workflowGraph, workflowDir, stepName);
      case "conditional":
        return this._createConditionalActionV2(stepId, config, workflowGraph, workflowDir, stepName);
      case "data_process":
        return this._createDataProcessActionV2(stepId, config, workflowGraph, workflowDir, stepName);
      case "log":
        return this._createLogActionV2(stepId, config, workflowGraph, workflowDir, stepName);
      case "concurrent":
        return this._createConcurrentActionV2(stepId, config, workflowGraph, workflowDir, stepName);
      case "merge_json_files":
        return this._createMergeJsonFilesActionV2(stepId, config, workflowGraph, workflowDir, stepName);
      default:
        // 不支持的类型：列出所有支持的类型，帮助用户排查拼写错误
        throw new Error(
          `步骤 ${stepId} 的类型 '${actionType}' 不支持。` +
          `支持的类型: ${SUPPORTED_ACTION_TYPES.join(", ")}`
        );
    }
  }

  // ============================================================
  // 各 action 类型的创建方法
  // ============================================================

  /**
   * 创建 LLM 调用动作
   *
   * 对应 YAML 配置示例：
   *   steps:
   *     1:
   *       type: llm
   *       model: gpt4                     ← 必填：模型简称
   *       prompt: "请翻译以下文本：{text}" ← 必填：提示词模板
   *       temperature: 0.7                ← 可选：温度参数
   *       max_tokens: 2000                ← 可选：最大 token 数
   *       validate_json: true             ← 可选：是否验证返回的 JSON
   *       json_rules: { ... }             ← 可选：JSON 结构验证规则
   *       validator: simple_json          ← 可选：自定义验证器名称
   *       validator_config: { ... }       ← 可选：验证器配置
   *
   * @param stepId       步骤 ID
   * @param config       步骤配置
   * @param workflowGraph 工作流图
   * @param workflowDir  工作流目录（本方法未使用，保持签名一致）
   * @param stepName     步骤名称
   * @returns LLMCallAction 实例
   */
  private _createLLMActionV2(
    stepId: string,
    config: Record<string, unknown>,
    workflowGraph: WorkflowGraph,
    _workflowDir: string,
    _stepName: string
  ): LLMCallAction {
    // ---- 必填字段前置检查 ----
    // 改进点：先检查字段是否存在，给出明确的缺失字段报错
    if (!config["model"]) {
      throw new Error(`步骤 ${stepId} 缺少必填字段 'model'`);
    }
    if (!config["prompt"]) {
      throw new Error(`步骤 ${stepId} 缺少必填字段 'prompt'`);
    }

    // 从工作流图中获取下一步
    // getNextSteps 返回后继节点数组，取第一个；如果没有后继则默认 "END"（结束流程）
    const nextSteps = workflowGraph.getNextSteps(stepId);
    const nextStep = nextSteps.length > 0 ? nextSteps[0] : "END";

    // 构建传递给 LLMCallAction 的 config 对象
    // LLMCallAction 会从 config 中提取 validator 和 validator_config
    const actionConfig: Record<string, unknown> = {};
    if (config["validator"] !== undefined) {
      actionConfig["validator"] = config["validator"];
    }
    if (config["validator_config"] !== undefined) {
      actionConfig["validator_config"] = config["validator_config"];
    }

    return new LLMCallAction(
      config["model"] as string,                                  // model：模型简称
      config["prompt"] as string,                                 // promptTemplate：提示词模板
      autoOutputKey(stepId),                                      // outputKey：自动生成（如 "1_response"）
      nextStep,                                                   // nextStep：从图中推断
      config["validate_json"] as boolean | undefined,             // validateJson：是否验证 JSON
      config["temperature"] as number | undefined,                // temperature：温度参数
      config["max_tokens"] as number | undefined,                 // maxTokens：最大 token 数
      config["required_fields"] as string[] | undefined,          // requiredFields：必填字段列表
      config["json_rules"] as Record<string, unknown> | undefined, // jsonRules：JSON 验证规则
      (config["json_retry_max_attempts"] as number) ?? 3,         // jsonRetryMaxAttempts：重试次数
      (config["json_retry_enhance_prompt"] as boolean) ?? false,  // jsonRetryEnhancePrompt：增强提示词
      actionConfig                                                // config：额外配置（validator 等）
    );
  }

  /**
   * 创建文件保存动作
   *
   * 对应 YAML 配置示例：
   *   steps:
   *     2:
   *       type: save_file
   *       filepath: "{paths.output}/result.json"  ← 必填：保存路径
   *       data_key: "1_response"                  ← 必填：从 context.data 取值的键路径
   *       show_message: true                      ← 可选：是否打印保存成功消息
   *
   * 工作原理：
   *   1. 通过 deepGet(context.data, dataKey) 获取要保存的内容
   *   2. 调用 saveToFile(filepath, content) 写入文件
   *   3. 如果 showMessage 为 true，在控制台打印成功消息
   *
   * @param stepId       步骤 ID
   * @param config       步骤配置
   * @param workflowGraph 工作流图
   * @param workflowDir  工作流目录（本方法未使用）
   * @param stepName     步骤名称
   * @returns SaveDataAction 实例
   */
  private _createSaveFileActionV2(
    stepId: string,
    config: Record<string, unknown>,
    workflowGraph: WorkflowGraph,
    _workflowDir: string,
    _stepName: string
  ): SaveDataAction {
    // ---- 必填字段前置检查 ----
    if (!config["filepath"]) {
      throw new Error(`步骤 ${stepId} 缺少必填字段 'filepath'`);
    }
    if (!config["data_key"]) {
      throw new Error(`步骤 ${stepId} 缺少必填字段 'data_key'`);
    }

    const filepath = config["filepath"] as string;
    const dataKey = config["data_key"] as string;
    // showMessage 默认为 true：保存成功后在控制台打印提示
    const showMessage = (config["show_message"] as boolean) ?? true;

    // 从工作流图获取下一步
    const nextSteps = workflowGraph.getNextSteps(stepId);
    const nextStep = nextSteps.length > 0 ? nextSteps[0] : "END";

    // 创建保存函数闭包
    // SaveDataAction 在执行时会调用此函数，传入 context.data
    const saveFunc = (data: Record<string, unknown>): void => {
      // deepGet 支持点分路径访问嵌套对象
      // 例如 deepGet(data, "1_response.text") → data["1_response"]["text"]
      const content = deepGet(data, dataKey, "") as string;
      saveToFile(filepath, content);
      if (showMessage) {
        console.log(`[OK] 文件已保存: ${filepath}`);
      }
    };

    return new SaveDataAction(
      saveFunc,                                         // saveFunc：保存函数
      nextStep,                                         // nextStep：从图中推断
      (config["name"] as string) ?? `SaveFile_${stepId}` // name：步骤名称
    );
  }

  /**
   * 创建条件分支动作
   *
   * 对应 YAML 配置示例：
   *   steps:
   *     3:
   *       type: conditional
   *       condition: "check_quality"   ← 必填：已注册的条件函数名称
   *
   * 注意：条件函数需要在调用 loadFromYaml 之前通过 registerCondition() 注册。
   * 条件函数返回下一步的步骤 ID，实现动态分支跳转。
   *
   * 改进点（相比 Python 版）：
   *   Python 版先取 config.get("condition")（可能返回 None），然后检查注册表报"未注册"，
   *   导致用户看到 "条件函数 'None' 未注册" 这样的误导性错误信息。
   *   TypeScript 版改为先检查字段是否存在，再检查是否注册，分两步报错更清晰。
   *
   * @param stepId       步骤 ID
   * @param config       步骤配置
   * @param workflowGraph 工作流图（条件分支不使用，后继由条件函数动态决定）
   * @param workflowDir  工作流目录（本方法未使用）
   * @param stepName     步骤名称
   * @returns ConditionalBranchAction 实例
   */
  private _createConditionalActionV2(
    stepId: string,
    config: Record<string, unknown>,
    _workflowGraph: WorkflowGraph,
    _workflowDir: string,
    _stepName: string
  ): ConditionalBranchAction {
    // ---- 改进：先检查字段是否存在 ----
    const conditionName = config["condition"] as string | undefined;
    if (!conditionName) {
      throw new Error(`步骤 ${stepId} 缺少必填字段 'condition'`);
    }

    // ---- 再检查是否已注册 ----
    const conditionFunc = this._customConditions.get(conditionName);
    if (!conditionFunc) {
      throw new Error(
        `步骤 ${stepId} 引用的条件函数 '${conditionName}' 未注册。` +
        `请在调用 loadFromYaml 前通过 registerCondition('${conditionName}', func) 注册`
      );
    }

    return new ConditionalBranchAction(
      conditionFunc,                                          // conditionFunc：条件函数
      (config["name"] as string) ?? `Conditional_${stepId}`   // name：步骤名称
    );
  }

  /**
   * 创建数据处理动作
   *
   * 对应 YAML 配置示例：
   *   steps:
   *     4:
   *       type: data_process
   *       processor: "format_output"   ← 必填：已注册的处理器函数名称
   *
   * 处理器函数接收 context.data，返回处理结果（会被合并到 context.data 中）。
   * 需要在调用 loadFromYaml 之前通过 registerProcessor() 注册。
   *
   * 改进点（同 conditional）：先检查字段是否存在，再检查是否注册。
   *
   * @param stepId       步骤 ID
   * @param config       步骤配置
   * @param workflowGraph 工作流图
   * @param workflowDir  工作流目录（本方法未使用）
   * @param stepName     步骤名称
   * @returns DataProcessAction 实例
   */
  private _createDataProcessActionV2(
    stepId: string,
    config: Record<string, unknown>,
    workflowGraph: WorkflowGraph,
    _workflowDir: string,
    _stepName: string
  ): DataProcessAction {
    // ---- 改进：先检查字段是否存在 ----
    const processorName = config["processor"] as string | undefined;
    if (!processorName) {
      throw new Error(`步骤 ${stepId} 缺少必填字段 'processor'`);
    }

    // ---- 再检查是否已注册 ----
    const processFunc = this._customProcessors.get(processorName);
    if (!processFunc) {
      throw new Error(
        `步骤 ${stepId} 引用的处理器 '${processorName}' 未注册。` +
        `请在调用 loadFromYaml 前通过 registerProcessor('${processorName}', func) 注册`
      );
    }

    // 从工作流图获取下一步
    const nextSteps = workflowGraph.getNextSteps(stepId);
    const nextStep = nextSteps.length > 0 ? nextSteps[0] : "END";

    return new DataProcessAction(
      processFunc,                                            // processFunc：处理器函数
      nextStep,                                               // nextStep：从图中推断
      (config["name"] as string) ?? `DataProcess_${stepId}`   // name：步骤名称
    );
  }

  /**
   * 创建日志记录动作
   *
   * 对应 YAML 配置示例：
   *   steps:
   *     5:
   *       type: log
   *       message: "当前进度：{progress}%"   ← 可选：消息模板（支持 {key} 占位符）
   *       level: INFO                        ← 可选：日志级别（DEBUG/INFO/WARNING/ERROR）
   *
   * @param stepId       步骤 ID
   * @param config       步骤配置
   * @param workflowGraph 工作流图
   * @param workflowDir  工作流目录（本方法未使用）
   * @param stepName     步骤名称
   * @returns LogAction 实例
   */
  private _createLogActionV2(
    stepId: string,
    config: Record<string, unknown>,
    workflowGraph: WorkflowGraph,
    _workflowDir: string,
    _stepName: string
  ): LogAction {
    // 从工作流图获取下一步
    const nextSteps = workflowGraph.getNextSteps(stepId);
    const nextStep = nextSteps.length > 0 ? nextSteps[0] : "END";

    return new LogAction(
      (config["message"] as string) ?? `步骤 ${stepId}: {data}`, // messageTemplate：消息模板
      (config["level"] as string) ?? "INFO",                     // logLevel：日志级别
      nextStep,                                                  // nextStep：从图中推断
      (config["name"] as string) ?? `Log_${stepId}`              // name：步骤名称
    );
  }

  /**
   * 创建并发处理动作
   *
   * 对应 YAML 配置示例：
   *   steps:
   *     6:
   *       type: concurrent
   *       items_key: "pages"                    ← 必填：数据列表在 context.data 中的键名
   *       process_steps:                        ← 必填：每个元素要执行的处理步骤列表
   *         - type: llm
   *           model: gpt4
   *           prompt_template: "翻译：{text}"
   *       max_concurrent: 5                     ← 可选：最大并发数
   *       task_dispatch_delay: 0.5              ← 可选：任务派发间隔（秒）
   *       circuit_breaker_threshold: 10         ← 可选：熔断阈值（连续失败次数）
   *       save_to_file:                         ← 可选：每个结果保存到文件
   *         output_dir: "{paths.results}"
   *         filename_template: "page_{index:04d}.json"
   *         data_key: "translated"
   *       fail_on_error: false                  ← 可选：单个元素失败是否中断整体
   *
   * @param stepId       步骤 ID
   * @param config       步骤配置
   * @param workflowGraph 工作流图
   * @param workflowDir  工作流目录（传递给 ConcurrentAction 用于构建文件路径）
   * @param stepName     步骤名称
   * @returns ConcurrentAction 实例
   */
  private _createConcurrentActionV2(
    stepId: string,
    config: Record<string, unknown>,
    workflowGraph: WorkflowGraph,
    workflowDir: string,
    stepName: string
  ): ConcurrentAction {
    // ---- 必填字段前置检查 ----
    if (!config["items_key"]) {
      throw new Error(`步骤 ${stepId} 缺少必填字段 'items_key'`);
    }
    if (!config["process_steps"]) {
      throw new Error(`步骤 ${stepId} 缺少必填字段 'process_steps'`);
    }

    // 从工作流图获取下一步
    const nextSteps = workflowGraph.getNextSteps(stepId);
    const nextStep = nextSteps.length > 0 ? nextSteps[0] : "END";

    // ActionConfig 类型在 concurrent_actions.ts 中定义
    // process_steps 是一个 ActionConfig 数组，描述每个元素要执行的子步骤
    return new ConcurrentAction(
      config["items_key"] as string,                                         // itemsKey：数据列表的键名
      config["process_steps"] as ActionConfig[],                              // processSteps：子步骤配置列表
      (config["max_concurrent"] as number) ?? 5,                             // maxConcurrent：最大并发数
      config["task_dispatch_delay"] as number | undefined,                   // taskDispatchDelay：任务派发间隔
      (config["circuit_breaker_threshold"] as number) ?? 10,                 // circuitBreakerThreshold：熔断阈值
      autoOutputKey(stepId),                                                 // outputKey：自动生成
      config["save_to_file"] as SaveToFileConfig | undefined,                  // saveToFile：文件保存配置
      (config["fail_on_error"] as boolean) ?? false,                         // failOnError：失败是否中断
      nextStep,                                                              // nextStep：从图中推断
      stepName,                                                              // name：步骤名称
      stepId,                                                                // stepId：步骤 ID
      workflowDir                                                            // workflowDir：项目目录
    );
  }

  /**
   * 创建合并 JSON 文件动作
   *
   * 对应 YAML 配置示例：
   *   steps:
   *     7:
   *       type: merge_json_files
   *       input_dir: "{paths.results}"          ← 必填：JSON 文件所在目录
   *       output_file: "{paths.output}"         ← 必填：合并后的输出文件路径
   *       pattern: "*.json"                     ← 可选：文件匹配模式
   *       sort_by: "filename"                   ← 可选：排序方式
   *
   * @param stepId       步骤 ID
   * @param config       步骤配置
   * @param workflowGraph 工作流图
   * @param workflowDir  工作流目录（本方法未使用）
   * @param stepName     步骤名称
   * @returns MergeJsonFilesAction 实例
   */
  private _createMergeJsonFilesActionV2(
    stepId: string,
    config: Record<string, unknown>,
    workflowGraph: WorkflowGraph,
    _workflowDir: string,
    stepName: string
  ): MergeJsonFilesAction {
    // ---- 必填字段前置检查 ----
    if (!config["input_dir"]) {
      throw new Error(`步骤 ${stepId} 缺少必填字段 'input_dir'`);
    }
    if (!config["output_file"]) {
      throw new Error(`步骤 ${stepId} 缺少必填字段 'output_file'`);
    }

    // 从工作流图获取下一步
    const nextSteps = workflowGraph.getNextSteps(stepId);
    const nextStep = nextSteps.length > 0 ? nextSteps[0] : "END";

    return new MergeJsonFilesAction(
      config["input_dir"] as string,                           // inputDir：JSON 文件目录
      config["output_file"] as string,                         // outputFile：合并后的输出路径
      (config["pattern"] as string) ?? "*.json",               // pattern：文件匹配模式
      (config["sort_by"] as string) ?? "filename",             // sortBy：排序方式
      autoOutputKey(stepId),                                   // outputKey：自动生成
      nextStep,                                                // nextStep：从图中推断
      stepName,                                                // name：步骤名称
      stepId                                                   // stepId：步骤 ID
    );
  }
}

// ============================================================
// 便捷函数
// ============================================================

/**
 * 快速从 YAML 加载工作流（便捷函数）
 *
 * 封装了 WorkflowLoader 的创建、注册和加载流程，适用于简单场景。
 * 如果不需要注册自定义条件/处理器，可以不传后两个参数。
 *
 * 示例：
 *   // 无自定义函数的简单加载
 *   const result = loadWorkflowFromYaml("config.yaml");
 *
 *   // 带自定义条件和处理器
 *   const result = loadWorkflowFromYaml("config.yaml", {
 *     check_quality: (data) => data.score > 0.8 ? "good_path" : "retry_path"
 *   }, {
 *     format_output: (data) => ({ formatted: String(data.raw).trim() })
 *   });
 *
 * @param yamlPath          YAML 配置文件路径
 * @param customConditions  自定义条件函数字典（可选）
 * @param customProcessors  自定义处理器函数字典（可选）
 * @returns { engine, workflowLogger, config } 三元组
 */
export function loadWorkflowFromYaml(
  yamlPath: string,
  customConditions?: Record<string, ConditionFunc>,
  customProcessors?: Record<string, ProcessorFunc>
): LoadResult {
  const loader = new WorkflowLoader();

  // 注册自定义条件函数
  if (customConditions) {
    for (const [name, func] of Object.entries(customConditions)) {
      loader.registerCondition(name, func);
    }
  }

  // 注册自定义处理器函数
  if (customProcessors) {
    for (const [name, func] of Object.entries(customProcessors)) {
      loader.registerProcessor(name, func);
    }
  }

  return loader.loadFromYaml(yamlPath);
}
