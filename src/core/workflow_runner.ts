/**
 * 工作流一键启动器（Workflow Runner）
 *
 * 本模块封装了工作流的完整执行流程：
 *   1. 从 YAML 文件加载工作流配置
 *   2. 创建工作流引擎并注册所有步骤
 *   3. 执行工作流并收集结果
 *   4. 打印执行报告（耗时、步骤数、输出目录等）
 *   5.（可选）清理中间文件
 *
 * 典型使用方式：
 *   // 方式一：使用便捷函数（最简单）
 *   const result = await runWorkflowFromYaml("workflows/my_project/config.yaml");
 *
 *   // 方式二：使用类（更灵活）
 *   const runner = await WorkflowRunner.fromYaml("workflows/my_project/config.yaml");
 *   const result = await runner.run({ inputData: { text: "hello" } });
 *
 * 对应 Python 版：LLM_agent/src/core/workflow_runner.py
 */

// ============================================================
// 导入依赖
// ============================================================

// path：Node.js 内置路径处理模块
// 用于拼接工作流输出目录路径（path.join）和获取文件名（path.basename）
import path from "path";

// fs：Node.js 内置文件系统模块
// 用于检查输出目录是否存在（fs.existsSync）、列出文件树（fs.readdirSync）
import fs from "fs";

// WorkflowEngine：工作流执行引擎，负责按步骤图依次执行已注册的 Action
// WorkflowContext：工作流执行上下文，贯穿整个工作流的共享状态容器（data、history、metadata）
import { WorkflowEngine, WorkflowContext } from "../workflow_engine.js";

// loadWorkflowFromYaml：从 YAML 文件加载工作流的便捷函数
// 返回 { engine, workflowLogger, config } 三元组
import { loadWorkflowFromYaml } from "../workflow_loader.js";

// StructuredLogger：结构化日志记录器，支持 JSONL 文件日志 + 人类可读日志 + 控制台输出
import { StructuredLogger } from "./logging.js";

// cleanDirectory：清理工作流输出目录的工具函数
// 支持删除中间产物（artifacts）、结果文件、日志文件，支持 dry-run 模式
import { cleanDirectory } from "../cli/clean.js";

// ============================================================
// 接口定义
// ============================================================

/**
 * 工作流运行选项
 *
 * 控制工作流的输入数据和执行后的清理行为。
 *
 * 示例：
 *   const options: RunOptions = {
 *     inputData: { text: "需要翻译的文本", targetLang: "en" },
 *     cleanupOnSuccess: false,
 *   };
 */
interface RunOptions {
  /**
   * 传入工作流的初始数据
   *
   * 这些数据会被合并到 context.data 中，供各步骤读取。
   * 类型 Record<string, unknown> 等价于 Python 的 dict[str, Any]。
   *
   * 示例：{ text: "你好世界", model: "gpt-4o" }
   */
  inputData: Record<string, unknown>;

  /**
   * 执行成功后是否自动清理中间文件
   *
   * 默认 false（不清理）。设为 true 时会清理 cleanupTargets 指定的目录。
   */
  cleanupOnSuccess?: boolean;

  /**
   * 需要清理的目标目录名列表
   *
   * 默认 ["artifacts"]。这些目录相对于 workflowDir。
   * 例如 workflowDir 是 "data/my_project"，则清理 "data/my_project/artifacts"。
   */
  cleanupTargets?: string[];

  /**
   * 是否启用交互式清理（执行完成后询问用户是否清理）
   *
   * 默认 false。当前版本暂不实现交互式清理功能。
   */
  interactiveCleanup?: boolean;
}

/**
 * 工作流运行结果
 *
 * 包含执行状态、输出目录、上下文数据等信息。
 *
 * 示例（成功）：
 *   {
 *     status: "success",
 *     workflowDir: "data/my_project",
 *     context: WorkflowContext { ... },
 *     cleaned: false,
 *   }
 *
 * 示例（失败）：
 *   {
 *     status: "failed",
 *     workflowDir: "data/my_project",
 *     error: "步骤 2 未注册。可用步骤: 1, 3",
 *   }
 */
interface RunResult {
  /** 执行状态："success" 表示成功，"failed" 表示失败 */
  status: "success" | "failed";

  /** 工作流输出目录的路径（如 "data/my_project"） */
  workflowDir: string;

  /** 执行完成的工作流上下文（仅成功时存在），包含所有步骤的执行结果和历史 */
  context?: WorkflowContext;

  /** 错误信息（仅失败时存在） */
  error?: string;

  /** 是否已执行清理操作 */
  cleaned?: boolean;
}

// ============================================================
// WorkflowRunner 类
// ============================================================

/**
 * 工作流一键启动器
 *
 * 将"加载 YAML → 创建引擎 → 执行 → 打印报告 → 清理"的完整流程封装为一个类。
 * 对外暴露两个主要入口：
 *   - `WorkflowRunner.fromYaml(yamlPath)` — 静态工厂方法，从 YAML 创建实例
 *   - `runner.run(options)` — 执行工作流
 *
 * 使用示例：
 *   const runner = await WorkflowRunner.fromYaml("config.yaml");
 *   const result = await runner.run({ inputData: { text: "hello" } });
 *   if (result.status === "success") {
 *     console.log("输出目录:", result.workflowDir);
 *   }
 */
export class WorkflowRunner {
  /**
   * 工作流执行引擎实例
   *
   * 由 loadWorkflowFromYaml 创建并配置好（所有步骤已注册），
   * 调用 engine.runWorkflow() 即可开始执行。
   */
  private readonly engine: WorkflowEngine;

  /**
   * 结构化日志记录器
   *
   * 日志文件存放在 workflowDir/logs/ 目录下，
   * 同时输出到控制台和 JSONL/TXT 文件。
   */
  private readonly logger: StructuredLogger;

  /**
   * YAML 解析后的原始配置对象
   *
   * 包含 project_name、workflow_graph、steps、paths 等字段。
   * 运行时从中读取项目名称等信息。
   */
  private readonly config: Record<string, unknown>;

  /**
   * 工作流输出目录路径
   *
   * 由 project_name 决定，格式为 "data/{project_name}"。
   * 例如 project_name 为 "ocr_pipeline"，则 workflowDir 为 "data/ocr_pipeline"。
   */
  private readonly workflowDir: string;

  /**
   * 私有构造函数
   *
   * 不直接调用 new WorkflowRunner(...)，而是通过 WorkflowRunner.fromYaml() 工厂方法创建。
   * 这样做的原因：fromYaml 内部需要调用 loadWorkflowFromYaml（同步 I/O），
   * 使用工厂方法可以更好地控制初始化流程。
   *
   * @param engine      已配置好的工作流引擎
   * @param logger      结构化日志记录器
   * @param config      YAML 原始配置
   * @param workflowDir 工作流输出目录路径
   */
  private constructor(
    engine: WorkflowEngine,
    logger: StructuredLogger,
    config: Record<string, unknown>,
    workflowDir: string,
  ) {
    this.engine = engine;
    this.logger = logger;
    this.config = config;
    this.workflowDir = workflowDir;
  }

  // ============================================================
  // 工厂方法
  // ============================================================

  /**
   * 从 YAML 文件创建 WorkflowRunner 实例（静态工厂方法）
   *
   * 替代 Python 版的 @classmethod from_yaml。
   * 内部调用 loadWorkflowFromYaml 完成 YAML 解析、目录创建、引擎配置等工作。
   *
   * @param yamlPath YAML 配置文件的路径（如 "workflows/my_project/config.yaml"）
   * @param baseDir  项目基目录（可选，默认为 "data"）。输出目录 = baseDir / projectName
   * @returns WorkflowRunner 实例
   * @throws Error YAML 文件不存在或格式错误时抛出
   *
   * 示例：
   *   const runner = await WorkflowRunner.fromYaml("config.yaml");
   *   // 等价于：
   *   const runner = await WorkflowRunner.fromYaml("config.yaml", "data");
   */
  static async fromYaml(
    yamlPath: string,
    baseDir?: string,
  ): Promise<WorkflowRunner> {
    // 第一步：加载 YAML 配置，创建引擎和日志器
    // loadWorkflowFromYaml 内部会：
    //   - 读取并解析 YAML 文件
    //   - 创建 data/{project_name}/ 目录结构
    //   - 解析工作流图，创建 Action 并注册到引擎
    const { engine, workflowLogger, config } = loadWorkflowFromYaml(yamlPath);

    // 第二步：确定工作流输出目录
    // 从配置中获取 project_name（如 "ocr_pipeline"）
    const projectName = config["project_name"] as string;
    // 拼接基目录和项目名称得到输出目录
    // 例如 baseDir="data", projectName="ocr_pipeline" → "data/ocr_pipeline"
    const effectiveBaseDir = baseDir ?? "data";
    const workflowDir = path.join(effectiveBaseDir, projectName);

    // 第三步：创建 WorkflowRunner 实例
    return new WorkflowRunner(engine, workflowLogger, config, workflowDir);
  }

  // ============================================================
  // 主执行方法
  // ============================================================

  /**
   * 执行工作流（主入口方法）
   *
   * 完整流程：
   *   1. 打印启动信息（项目名称、YAML 配置概要）
   *   2. 调用引擎执行工作流
   *   3. 成功时打印结果报告（耗时、步骤数、文件树）
   *   4. 失败时记录错误信息
   *   5. （可选）执行清理操作
   *
   * @param options 运行选项（输入数据、清理配置等），默认为空输入
   * @returns RunResult 对象，包含执行状态和结果
   *
   * 示例：
   *   const result = await runner.run({
   *     inputData: { text: "翻译这段文字", targetLang: "en" },
   *     cleanupOnSuccess: false,
   *   });
   *   console.log(result.status);      // "success" 或 "failed"
   *   console.log(result.workflowDir); // "data/my_project"
   */
  async run(options?: RunOptions): Promise<RunResult> {
    // 第一步：解构选项，设置默认值
    const {
      inputData = {},
      cleanupOnSuccess = false,
      cleanupTargets = ["artifacts"],
      interactiveCleanup = false,
    } = options ?? {};

    // 第二步：打印启动信息
    this._printStart();

    try {
      // 第三步：调用引擎执行工作流
      // engine.runWorkflow 会按照工作流图依次执行每个步骤
      // 返回 WorkflowContext，包含所有步骤的执行数据和历史记录
      const context = await this.engine.runWorkflow({
        startStep: "1",
        initialData: inputData,
        workflowLogger: this.logger,
      });

      // 第四步：打印成功报告
      this._printSuccess(context);
      this._printFileTree();

      // 第五步：处理清理逻辑
      let cleaned = false;
      if (cleanupOnSuccess) {
        // 调用清理工具删除指定的中间产物目录
        cleanDirectory(this.workflowDir, { targets: cleanupTargets });
        cleaned = true;
      }

      if (interactiveCleanup) {
        // TODO: 交互式清理暂不实现
        // 原 Python 版使用 input("清理中间文件？(y/N): ") 交互式询问用户
        // Node.js 中实现交互式输入需要 readline 模块，暂时跳过
        console.log("[提示] 交互式清理功能尚未实现");
      }

      return {
        status: "success",
        workflowDir: this.workflowDir,
        context,
        cleaned,
      };
    } catch (error) {
      // 第六步：处理执行失败
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`\n工作流执行失败: ${errorMessage}`);
      this.logger.error("工作流执行失败", error instanceof Error ? error : undefined);

      return {
        status: "failed",
        workflowDir: this.workflowDir,
        error: errorMessage,
      };
    }
  }

  // ============================================================
  // 打印辅助方法
  // ============================================================

  /**
   * 打印工作流启动信息
   *
   * 在执行开始前输出项目名称和分隔线，方便在控制台中定位。
   *
   * 输出示例：
   *   ============================================================
   *   开始执行工作流: ocr_pipeline
   *   ============================================================
   */
  private _printStart(): void {
    // 从配置中获取项目名称，如果没有则显示 "Unknown"
    const projectName = (this.config["project_name"] as string) ?? "Unknown";
    const separator = "=".repeat(60);
    console.log(`\n${separator}`);
    console.log(`开始执行工作流: ${projectName}`);
    console.log(separator);
  }

  /**
   * 打印工作流成功完成的报告
   *
   * 从 context.metadata 中提取总耗时和步骤数，格式化输出。
   *
   * @param context 执行完成的工作流上下文
   *
   * 输出示例：
   *   ============================================================
   *   工作流执行完成!
   *   总耗时: 45.23 秒
   *   执行步骤数: 7
   *   输出目录: data/ocr_pipeline
   *   ============================================================
   */
  private _printSuccess(context: WorkflowContext): void {
    // 从 metadata 中获取总耗时（秒）和总步骤数
    // ?? 0 是空值合并运算符：如果值为 null 或 undefined 则使用默认值 0
    const totalDuration =
      (context.metadata["totalDuration"] as number) ?? 0;
    const totalIterations =
      (context.metadata["totalIterations"] as number) ?? 0;

    const separator = "=".repeat(60);
    console.log(`\n${separator}`);
    console.log("工作流执行完成!");
    // toFixed(2) 保留两位小数
    console.log(`总耗时: ${totalDuration.toFixed(2)} 秒`);
    console.log(`执行步骤数: ${totalIterations}`);
    console.log(`输出目录: ${this.workflowDir}`);
    console.log(separator);
  }

  /**
   * 打印工作流输出目录的文件树
   *
   * 列出 workflowDir 下的所有文件和子目录，帮助用户快速了解产出物。
   * 如果目录不存在则跳过输出。
   *
   * 输出示例：
   *   输出文件:
   *     logs/
   *     results/
   *     workflow_config.yaml
   */
  private _printFileTree(): void {
    // 第一步：检查目录是否存在
    if (!fs.existsSync(this.workflowDir)) {
      return;
    }

    // 第二步：列出目录内容并排序
    // readdirSync 返回目录下的文件名数组（不包含子目录的内容）
    // withFileTypes: true 返回 Dirent 对象，可以判断是文件还是目录
    const entries = fs.readdirSync(this.workflowDir, { withFileTypes: true });

    if (entries.length === 0) {
      return;
    }

    console.log("\n输出文件:");
    for (const entry of entries) {
      // isDirectory() 判断是否为目录，目录名后面加 "/" 后缀以示区分
      const suffix = entry.isDirectory() ? "/" : "";
      console.log(`  ${entry.name}${suffix}`);
    }
  }

  // ============================================================
  // 工具方法
  // ============================================================

  /**
   * 获取输出目录中指定文件的完整路径
   *
   * 便捷方法，省去手动拼接路径的步骤。
   *
   * @param filename 文件名（如 "result.json"）
   * @returns 完整路径（如 "data/ocr_pipeline/result.json"）
   *
   * 示例：
   *   runner.getOutputFile("results/final.json")
   *   // → "data/ocr_pipeline/results/final.json"
   */
  getOutputFile(filename: string): string {
    return path.join(this.workflowDir, filename);
  }

  /**
   * 返回 WorkflowRunner 的字符串表示（替代 Python 的 __repr__）
   *
   * 示例：
   *   WorkflowRunner(workflowDir='data/ocr_pipeline')
   */
  toString(): string {
    return `WorkflowRunner(workflowDir='${this.workflowDir}')`;
  }
}

// ============================================================
// 便捷函数
// ============================================================

/**
 * 从 YAML 文件一键执行工作流（便捷函数）
 *
 * 封装了 WorkflowRunner 的创建和执行流程，适用于最简单的使用场景。
 * 内部做的事情：
 *   1. 调用 WorkflowRunner.fromYaml() 创建 runner
 *   2. 调用 runner.run() 执行工作流
 *   3. 返回执行结果
 *
 * @param yamlPath  YAML 配置文件路径
 * @param inputData 传入工作流的初始数据（可选，默认空对象）
 * @param baseDir   项目基目录（可选，默认 "data"）
 * @returns RunResult 对象
 *
 * 示例：
 *   // 最简用法
 *   const result = await runWorkflowFromYaml("config.yaml");
 *
 *   // 带初始数据
 *   const result = await runWorkflowFromYaml("config.yaml", { text: "hello" });
 *
 *   // 自定义输出目录
 *   const result = await runWorkflowFromYaml("config.yaml", {}, "output");
 */
export async function runWorkflowFromYaml(
  yamlPath: string,
  inputData: Record<string, unknown> = {},
  baseDir?: string,
): Promise<RunResult> {
  // 第一步：从 YAML 创建 runner 实例
  const runner = await WorkflowRunner.fromYaml(yamlPath, baseDir);

  // 第二步：执行工作流并返回结果
  return runner.run({ inputData });
}
