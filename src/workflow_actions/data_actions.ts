/**
 * 数据处理动作
 *
 * 包含数据处理和条件分支动作。
 * 两者均为纯数据操作，不涉及文件、网络等副作用，与 io_actions.ts 形成分工。
 */

// WorkflowContext 是工作流的全局上下文对象，里面有个 data 字段（类型是 Record<string, unknown>，
// 相当于一个键值对字典），所有步骤通过这个 data 共享数据。
// StepResult 是每个步骤执行完毕后返回的结果对象，包含三部分：
//   1. nextStep —— 下一步的步骤名称（字符串）
//   2. data     —— 要合并进 context.data 的新数据（字典）
//   3. metadata —— 元数据，仅供日志/调试用，不影响业务
import { WorkflowContext, StepResult } from "../workflow_engine.js";

// BaseAction 是所有动作的抽象基类。
// 它定义了 run(context) 方法（模板方法模式），内部流程：
//   1. 记录开始日志
//   2. 调用 this.execute(context)（由子类实现）
//   3. 记录结束日志
//   4. 返回 execute 的结果
// 完整调用链：引擎 run_workflow() → action.run(context) → action.execute(context)
import { BaseAction } from "./base.js";

// ============================================================
// DataProcessAction — 数据处理动作
// ============================================================

/**
 * 数据处理动作 —— 用自定义函数处理上下文数据
 *
 * 典型用途：在工作流步骤之间对数据做转换、过滤、格式化等操作。
 *
 * 工作原理：
 *   1. 构造时传入一个 processFunc（数据处理函数）
 *   2. 执行时把 context.data 传给 processFunc
 *   3. processFunc 返回新的数据字典
 *   4. 引擎把返回值合并进 context.data（不是替换，是合并）
 *
 * 与 SaveDataAction（io_actions.ts）的区别：
 *   - DataProcessAction：函数有返回值 → 返回值会合并进上下文，影响后续步骤
 *   - SaveDataAction：函数返回 void → 只做保存操作（写文件等），不修改上下文
 */
export class DataProcessAction extends BaseAction {

  // processFunc —— 用户传入的数据处理函数
  //
  // 类型解读：(data: Record<string, unknown>) => Record<string, unknown>
  //   Record<string, unknown> 是 TypeScript 内置类型，表示"键是字符串、值是任意类型的字典"，
  //   等价于 Python 的 dict[str, Any]。
  //
  // 为什么要通过构造函数提前传入，而不是在 execute() 里直接接收？
  //   因为 execute() 的方法签名被基类 BaseAction 固定为 execute(context)，
  //   无法添加额外参数。所以必须在创建对象时就把函数存到字段里，
  //   execute() 执行时再从字段中取出来调用。
  private readonly processFunc: (
    data: Record<string, unknown>
  ) => Record<string, unknown>;

  // nextStep —— 执行完毕后跳转到哪个步骤
  // 默认值 "END" 是特殊标记，表示工作流到此结束
  private readonly nextStep: string;

  // 构造函数的参数说明：
  //   processFunc —— 必填，数据处理函数
  //   nextStep    —— 可选，下一步步骤名，默认 "END"
  //   name        —— 可选，动作的显示名称（用于日志输出）
  //   config      —— 可选，额外配置字典（预留扩展用，目前未使用）
  constructor(
    processFunc: (data: Record<string, unknown>) => Record<string, unknown>,
    nextStep: string = "END",
    name?: string,
    config: Record<string, unknown> = {}
  ) {
    super(name, config);
    this.processFunc = processFunc;
    this.nextStep = nextStep;
  }

  // execute() 是 BaseAction 要求子类实现的抽象方法
  // 引擎不会直接调用 execute()，而是调用 run()，run() 内部再调用 execute()
  async execute(context: WorkflowContext): Promise<StepResult> {

    // 核心逻辑就这一行：
    // this.processFunc 是构造时存入的用户函数
    // context.data 是当前工作流的共享数据字典
    // 把 context.data 作为参数传给 processFunc，拿到处理后的新数据
    //
    // 注意：processFunc 返回的是"增量数据"而不是"完整数据"，
    // 比如 context.data = { a: 1, b: 2 }，processFunc 返回 { c: 3 }，
    // 引擎会把 { c: 3 } 合并进去，最终 context.data = { a: 1, b: 2, c: 3 }
    const resultData = this.processFunc(context.data);

    // 构造返回值 StepResult(nextStep, data, metadata)
    //   nextStep       —— 告诉引擎下一步执行哪个步骤
    //   resultData     —— 要合并进 context.data 的新数据
    //   metadata       —— processed_keys 记录了这次处理涉及的所有键名，
    //                     例如 resultData = { c: 3, d: 4 } 则 processed_keys = ["c", "d"]
    //                     纯粹用于日志追踪，不影响业务逻辑
    return new StepResult(this.nextStep, resultData, {
      processed_keys: Object.keys(resultData),
    });
  }
}

// ============================================================
// ConditionalBranchAction — 条件分支动作
// ============================================================

/**
 * 条件分支动作 —— 工作流中的 if/else
 *
 * 根据当前上下文数据动态决定下一步跳转到哪个步骤。
 *
 * 与其他动作的关键区别：
 *   - 普通动作（如 DataProcessAction）的 nextStep 在构造时就固定了，每次执行都跳同一步
 *   - 这个动作没有 nextStep 字段，"下一步"由 conditionFunc 在运行时动态计算
 *
 * 使用示例：
 *   new ConditionalBranchAction(
 *     (data) => data.score > 60 ? "step_pass" : "step_fail"
 *   )
 *   → 如果 data.score > 60，跳转到 "step_pass"
 *   → 否则跳转到 "step_fail"
 */
export class ConditionalBranchAction extends BaseAction {

  // conditionFunc —— 条件判断函数
  // 接收 context.data，返回下一步骤的名称（字符串）
  // 返回值必须是工作流 YAML 中已定义的步骤 ID，否则引擎找不到对应步骤会报错
  private readonly conditionFunc: (data: Record<string, unknown>) => string;

  constructor(
    conditionFunc: (data: Record<string, unknown>) => string,
    name?: string,
    config: Record<string, unknown> = {}
  ) {
    super(name, config);
    this.conditionFunc = conditionFunc;
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    // 调用条件函数，根据当前数据决定跳转方向
    // 例如 conditionFunc 可能是 (data) => data.retry_count > 3 ? "step_abort" : "step_retry"
    const nextStep = this.conditionFunc(context.data);

    // StepResult 的三个参数：
    //   nextStep         —— 动态计算出的下一步（这就是条件分支的核心价值）
    //   {}               —— 空对象，条件分支只做"判断"，不产生任何新数据
    //   { branch_result } —— 元数据，记录实际走了哪个分支，方便在日志中追踪流程走向
    return new StepResult(nextStep, {}, { branch_result: nextStep });
  }
}
