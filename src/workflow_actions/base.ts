/**
 * 工作流动作基类
 *
 * 所有动作必须继承此类并实现 execute 方法。
 * 外部代码通过 run() 调用动作——run() 会自动完成计时、日志记录和错误元数据写入，
 * 子类只需专注于 execute() 的业务逻辑。
 *
 * Python 版使用 __call__ 使实例可直接调用（action(context)），
 * TypeScript 无此魔法方法，统一改为 action.run(context)。
 */

import { WorkflowContext, StepResult } from "../workflow_engine.js";

const logger = {
  info: (msg: string) => console.info(msg),
  error: (msg: string) => console.error(msg),
};

/**
 * 工作流动作基类（抽象类）
 *
 * 子类必须实现 execute 方法，run 方法由基类提供：
 * - 执行前后记录日志
 * - 自动计时，写入 result.metadata.action_duration
 * - 失败时将错误元数据追加到 context.history
 * - 若子类设置了 _lastCostInfo，失败时仍保留成本数据
 */
export abstract class BaseAction {
  /** 动作名称，默认为类名 */
  readonly name: string;
  /** 动作配置参数（来自 YAML 的 step 配置） */
  readonly config: Record<string, unknown>;

  /**
   * 已消耗的成本信息（可选钩子）
   *
   * 子类（如 LLMCallAction）在 execute 过程中若已拿到 token 用量，
   * 可将成本信息写入此属性。基类在捕获到异常时会自动将其写入错误元数据，
   * 确保即使后续步骤失败，已花费的成本数据也不会丢失。
   */
  protected _lastCostInfo?: unknown;

  constructor(name?: string, config: Record<string, unknown> = {}) {
    // Python: self.name = name or self.__class__.__name__
    this.name = name ?? this.constructor.name;
    this.config = config;
  }

  /**
   * 执行动作（抽象方法，子类必须实现）
   *
   * @param context 工作流上下文
   * @returns 步骤结果，包含 nextStep 和 data
   * @throws Error 执行失败时抛出，由 run() 统一捕获并记录
   */
  abstract execute(context: WorkflowContext): Promise<StepResult>;

  /**
   * 运行动作（对外统一入口，替代 Python 的 __call__）
   *
   * 封装了计时、日志、元数据注入和错误处理，子类无需关心这些细节。
   *
   * @param context 工作流上下文
   * @returns 注入了 action_name 和 action_duration 的步骤结果
   * @throws 将 execute 的异常原样重新抛出
   */
  async run(context: WorkflowContext): Promise<StepResult> {
    logger.info(`执行动作: ${this.name}`);
    const startTime = Date.now();

    try {
      const result = await this.execute(context);
      const duration = (Date.now() - startTime) / 1000;

      // 自动注入动作信息到元数据
      result.metadata["action_name"] = this.name;
      result.metadata["action_duration"] = duration;

      return result;
    } catch (e) {
      const duration = (Date.now() - startTime) / 1000;
      logger.error(`动作 ${this.name} 执行失败: ${e}`);

      const errorMetadata: Record<string, unknown> = {
        action_name: this.name,
        action_duration: duration,
        error: String(e),
        failed: true,
      };

      // 若子类已记录成本信息（如 API 调用成功但后续解析失败），保留成本数据
      if (this._lastCostInfo !== undefined) {
        errorMetadata["cost"] = this._lastCostInfo;
        logger.info(`API调用失败，但已记录成本: ${JSON.stringify(this._lastCostInfo)}`);
      }

      // 将错误信息追加到 context.history，供 ConcurrentAction 等上层汇总
      context.history.push({
        step_id: "error",
        data: {},
        metadata: errorMetadata,
      });

      throw e;
    }
  }

  toString(): string {
    return `<${this.constructor.name}(name='${this.name}')>`;
  }
}
