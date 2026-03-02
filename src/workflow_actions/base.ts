/**
 * 工作流动作基类（Base Action）
 *
 * 本模块定义了所有工作流动作的抽象基类 BaseAction。
 * 项目中每个"动作"（如读取文件、调用 LLM、保存数据）都是 BaseAction 的子类。
 *
 * 设计模式——模板方法（Template Method）：
 *   基类的 run() 方法定义了执行的"骨架流程"（计时 → 执行 → 记录日志 → 注入元数据），
 *   子类只需实现 execute() 填充具体业务逻辑，无需关心计时和错误处理等横切关注点。
 *
 *   调用链路：
 *     外部代码调用 action.run(context)
 *       → run() 记录开始时间
 *       → run() 调用 this.execute(context)   ← 子类实现的业务逻辑
 *       → run() 计算耗时，注入 action_name / action_duration 到 result.metadata
 *       → 返回 result
 *
 * 为什么不用 Python 的 __call__ 模式？
 *   Python 版通过 __call__ 让动作实例可以像函数一样直接调用：action(context)
 *   TypeScript 没有等价的魔法方法，所以统一改为 action.run(context)
 *
 * 子类列表（定义在同级目录下）：
 *   - LLMCallAction（llm_actions.ts）—— 调用大语言模型
 *   - ConditionalLLMAction（llm_actions.ts）—— 带条件判断的 LLM 调用
 *   - SaveDataAction（io_actions.ts）—— 保存数据到文件
 *   - LogAction（io_actions.ts）—— 记录日志
 *   - ReadFileAction（io_actions.ts）—— 读取文件内容
 *   - MergeJsonFilesAction（io_actions.ts）—— 合并多个 JSON 文件
 *   - SetDataAction（data_actions.ts）—— 设置上下文数据
 *   - IncrementAction（data_actions.ts）—— 计数器自增
 *   - ConcurrentAction（concurrent_actions.ts）—— 并发执行多个子动作
 */

// WorkflowContext 是工作流的全局上下文对象，包含：
//   - data: Record<string, unknown> —— 步骤间共享的数据字典（等价于 Python 的 dict[str, Any]）
//   - history: Array<Record<string, unknown>> —— 执行历史记录（每步一条）
//   - metadata: Record<string, unknown> —— 整体元数据（启动时间、总耗时等）
//   - workflowLogger —— 可选的结构化日志记录器
//
// StepResult 是每个步骤执行完毕后的返回值，包含三个字段：
//   - nextStep: string —— 下一步的 ID，值为 "END" 时表示流程结束
//   - data: Record<string, unknown> —— 步骤产生的数据，会合并进 context.data
//   - metadata: Record<string, unknown> —— 元数据（执行时间、模型名、成本等），不合并进 data
import { WorkflowContext, StepResult } from "../workflow_engine.js";

/**
 * 简易日志器
 *
 * 没有使用 src/core/logging.ts 中的完整结构化日志系统，原因是：
 * base.ts 作为最底层的基类，需要保持依赖最小化，避免循环依赖。
 * 这里只需要简单的控制台输出即可。
 */
const logger = {
  // info: 记录一般运行信息（如"执行动作: ReadFile"）
  info: (msg: string) => console.info(msg),
  // error: 记录错误信息（如"动作 ReadFile 执行失败: ..."）
  error: (msg: string) => console.error(msg),
};

/**
 * 工作流动作基类（抽象类）
 *
 * abstract 关键字表示这是一个抽象类：
 *   - 不能直接 new BaseAction()，只能被子类继承
 *   - 内部可以定义抽象方法（execute），强制子类必须实现
 *
 * 生命周期：
 *   1. 构造阶段：通过 constructor 接收动作名称和配置参数
 *   2. 执行阶段：外部调用 run(context)，内部调用子类的 execute(context)
 *   3. 结果注入：run() 自动在 result.metadata 中写入 action_name 和 action_duration
 *   4. 错误处理：execute() 抛出异常时，run() 捕获并将错误信息追加到 context.history
 *
 * 成本信息保留机制：
 *   LLM 调用类动作可能在 execute() 中已经成功调用了 API（产生了费用），
 *   但后续的响应解析失败导致 execute() 抛出异常。
 *   此时子类可以在抛出异常前将成本信息写入 _lastCostInfo，
 *   run() 的 catch 块会自动将其保存到错误元数据中，确保已花费的钱不会"丢账"。
 */
export abstract class BaseAction {
  /**
   * 动作名称
   *
   * 用于日志输出和元数据标识。
   * readonly 表示构造后不可修改（等价于 Python 中不提供 setter 的属性）。
   *
   * 默认值为类名（如 "LLMCallAction"），也可以在构造时传入自定义名称。
   * 自定义名称通常来自 YAML 配置中的 step.name 字段。
   */
  readonly name: string;

  /**
   * 动作配置参数
   *
   * 来自 YAML 工作流定义文件中的 step 配置。
   * Record<string, unknown> 等价于 Python 的 dict[str, Any]，表示键为字符串、值为任意类型的字典。
   *
   * 示例（YAML 中的步骤配置解析后的对象）：
   *   { model: "gpt4", prompt_template: "请翻译以下文本：{text}", temperature: 0.7 }
   */
  readonly config: Record<string, unknown>;

  /**
   * 已消耗的成本信息（可选钩子）
   *
   * protected 表示仅本类和子类可以访问（外部代码无法读取）。
   * ? 后缀表示可选（可能为 undefined）。
   *
   * 使用场景：
   *   子类（如 LLMCallAction）在 execute() 过程中成功调用了 API，
   *   拿到了 token 用量和费用信息后，将其写入此属性。
   *   如果后续步骤（如 JSON 解析）失败导致 execute() 抛出异常，
   *   run() 的 catch 块会检查此属性，将成本数据保存到错误元数据中。
   *
   * 示例值：
   *   { model: "gpt-4o", input_tokens: 1500, output_tokens: 300, total_cost: 0.025 }
   */
  protected _lastCostInfo?: unknown;

  /**
   * 构造函数
   *
   * @param name   动作名称，默认使用类名（this.constructor.name）
   *               ?? 是空值合并运算符：当左侧为 null 或 undefined 时，使用右侧的值
   *               等价于 Python 的：self.name = name or self.__class__.__name__
   * @param config 配置参数字典，默认为空对象 {}
   */
  constructor(name?: string, config: Record<string, unknown> = {}) {
    this.name = name ?? this.constructor.name;
    this.config = config;
  }

  /**
   * 执行动作（抽象方法，子类必须实现）
   *
   * abstract 关键字表示这个方法没有实现体，子类必须提供具体实现，否则编译报错。
   * 这就是模板方法模式中的"可变部分"——每个子类填充自己的业务逻辑。
   *
   * @param context 工作流上下文，包含共享数据、执行历史等
   * @returns Promise<StepResult> 异步返回步骤结果
   *          - result.nextStep: 下一步的 ID（"END" 表示流程结束）
   *          - result.data: 本步骤产生的数据（会合并进 context.data）
   *          - result.metadata: 元数据（如 token 用量、模型名等）
   * @throws Error 执行失败时抛出异常，由 run() 统一捕获并记录
   */
  abstract execute(context: WorkflowContext): Promise<StepResult>;

  /**
   * 运行动作（对外统一入口）
   *
   * 这是外部代码调用动作的唯一方式（替代 Python 的 __call__）。
   * 封装了以下横切关注点（cross-cutting concerns），子类无需重复实现：
   *   1. 日志记录 —— 执行前打印动作名称
   *   2. 计时 —— 记录 execute() 的耗时（秒）
   *   3. 元数据注入 —— 自动写入 action_name 和 action_duration
   *   4. 错误处理 —— 捕获异常、记录错误信息、保留成本数据、追加到 history
   *
   * @param context 工作流上下文
   * @returns 注入了 action_name 和 action_duration 的步骤结果
   * @throws 将 execute() 的异常原样重新抛出（throw e），确保上层能感知到错误
   */
  async run(context: WorkflowContext): Promise<StepResult> {
    // 第一步：记录开始日志
    logger.info(`执行动作: ${this.name}`);
    // 第二步：记录开始时间（Date.now() 返回毫秒级时间戳）
    const startTime = Date.now();

    try {
      // 第三步：调用子类实现的 execute() 方法，获取步骤结果
      const result = await this.execute(context);
      // 第四步：计算耗时（毫秒转秒，保留小数）
      const duration = (Date.now() - startTime) / 1000;

      // 第五步：将动作名称和耗时注入到结果的元数据中
      // 这些元数据会被 workflow_engine 记录到执行历史，方便后续分析性能瓶颈
      result.metadata["action_name"] = this.name;
      result.metadata["action_duration"] = duration;

      return result;
    } catch (e) {
      // ---- 异常处理分支 ----
      // 即使 execute() 失败，也要记录耗时（用于分析超时等问题）
      const duration = (Date.now() - startTime) / 1000;
      logger.error(`动作 ${this.name} 执行失败: ${e}`);

      // 构建错误元数据对象
      const errorMetadata: Record<string, unknown> = {
        action_name: this.name,       // 哪个动作失败了
        action_duration: duration,     // 失败前运行了多久
        error: String(e),              // 错误信息（转为字符串，避免序列化问题）
        failed: true,                  // 标记为失败（方便后续过滤）
      };

      // 成本信息保留：如果子类在失败前已记录了 API 调用成本，将其保存下来
      // 典型场景：LLM API 调用成功（已扣费），但返回的 JSON 格式不合法导致解析失败
      if (this._lastCostInfo !== undefined) {
        errorMetadata["cost"] = this._lastCostInfo;
        logger.info(`API调用失败，但已记录成本: ${JSON.stringify(this._lastCostInfo)}`);
      }

      // 将错误信息追加到 context.history
      // 这样即使动作失败，上层（如 ConcurrentAction）也能从 history 中获取错误详情
      // step_id 设为 "error" 表示这不是正常步骤的记录，而是错误记录
      context.history.push({
        step_id: "error",
        data: {},                      // 失败时没有产出数据
        metadata: errorMetadata,       // 错误详情存在元数据中
      });

      // 原样重新抛出异常，让上层调用者（如 WorkflowEngine）决定如何处理
      // 注意：不是 throw new Error(...)，而是 throw e，保留原始异常的堆栈信息
      throw e;
    }
  }

  /**
   * 字符串表示（用于调试输出）
   *
   * 示例输出：<LLMCallAction(name='调用GPT4翻译')>
   * 等价于 Python 的 __repr__ 方法
   */
  toString(): string {
    return `<${this.constructor.name}(name='${this.name}')>`;
  }
}
