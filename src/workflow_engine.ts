/**
 * 工作流引擎核心模块
 * 提供基于状态转移的工作流编排功能
 * 支持动态流程控制和多模型协作
 */

import { StructuredLogger } from "./core/logging.js";
import type { WorkflowGraph } from "./workflow_parser.js";

// ============================================================
// 数据结构
// ============================================================

/**
 * 步骤执行结果
 *
 * 每个 action 必须返回此对象，引擎依据 `nextStep` 决定下一步。
 */
export class StepResult {
  /** 下一步的 ID；`"END"` 表示流程结束 */
  nextStep: string;
  /** 步骤产生的数据，将合并进 {@link WorkflowContext.data} */
  data: Record<string, unknown>;
  /** 元数据（执行时间、模型、成本等），不合并进 data */
  metadata: Record<string, unknown>;

  constructor(
    nextStep: string,
    data: Record<string, unknown> = {},
    metadata: Record<string, unknown> = {},
  ) {
    if (!nextStep) throw new Error("nextStep 不能为空");
    this.nextStep = nextStep;
    this.data = data;
    this.metadata = metadata;
  }
}

/**
 * 工作流执行上下文
 *
 * 贯穿整个工作流的共享状态容器：
 * - `data`：各步骤写入的数据（扁平 key-value）
 * - `history`：已执行步骤的历史记录
 * - `metadata`：整体运行元数据（开始时间、总耗时等）
 */
export class WorkflowContext {
  /** 工作流实例唯一 ID */
  workflowId: string;
  /** 各步骤共享的数据字典 */
  data: Record<string, unknown>;
  /** 执行历史（每步一条） */
  history: Array<Record<string, unknown>>;
  /** 整体元数据（start_time、total_duration 等） */
  metadata: Record<string, unknown>;
  /** 结构化日志记录器（可选） */
  workflowLogger: StructuredLogger | null;
  /** 工件管理器（可选，扩展用） */
  artifactManager: unknown;

  constructor(params: {
    workflowId: string;
    data?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    workflowLogger?: StructuredLogger | null;
  }) {
    this.workflowId = params.workflowId;
    this.data = params.data ?? {};
    this.history = [];
    this.metadata = params.metadata ?? {};
    this.workflowLogger = params.workflowLogger ?? null;
    this.artifactManager = null;
  }

  /** 将步骤结果合并进上下文，并追加历史记录 */
  update(stepId: string, result: StepResult): void {
    Object.assign(this.data, result.data);
    this.history.push({
      stepId,
      timestamp: Date.now() / 1000,
      data: { ...result.data },
      metadata: { ...result.metadata },
      nextStep: result.nextStep,
    });
  }

  /** 获取指定步骤最近一次的历史记录（不存在时返回 null） */
  getStepResult(stepId: string): Record<string, unknown> | null {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i]!["stepId"] === stepId) return this.history[i]!;
    }
    return null;
  }
}

/** Action 函数类型：接收上下文，返回步骤结果（支持异步） */
export type ActionFn = (context: WorkflowContext) => StepResult | Promise<StepResult>;

// ============================================================
// WorkflowEngine
// ============================================================

/**
 * 工作流执行引擎
 *
 * 核心功能：
 * 1. 注册和管理工作流步骤（action）
 * 2. 执行工作流，支持动态流程控制
 * 3. 维护执行上下文和历史记录
 */
export class WorkflowEngine {
  private _actionRegistry: Map<string, ActionFn> = new Map();
  /** v2.0 工作流图（可选，用于验证和路由辅助） */
  workflowGraph: WorkflowGraph | null;

  constructor(workflowGraph?: WorkflowGraph) {
    this.workflowGraph = workflowGraph ?? null;
    console.info(
      `工作流引擎初始化完成 ${workflowGraph ? "(v2.0 模式)" : "(v1.0 模式)"}`,
    );
  }

  /**
   * 注册工作流步骤
   *
   * @param stepId 步骤 ID（如 `"1"`、`"1.2"`、`"2"` 等）
   * @param action 步骤执行函数，接收 {@link WorkflowContext}，返回 {@link StepResult}
   */
  registerAction(stepId: string, action: ActionFn): void {
    if (this._actionRegistry.has(stepId)) {
      console.warn(`步骤 ${stepId} 已存在，将被覆盖`);
    }
    this._actionRegistry.set(stepId, action);
  }

  /** 批量注册工作流步骤 */
  registerActions(actions: Record<string, ActionFn>): void {
    for (const [stepId, action] of Object.entries(actions)) {
      this.registerAction(stepId, action);
    }
  }

  /**
   * 执行工作流
   *
   * @param startStep 起始步骤 ID（默认 `"1"`）
   * @param initialData 初始数据
   * @param maxIterations 最大迭代次数，防止无限循环（默认 100）
   * @param workflowLogger 结构化日志记录器（可选）
   * @param artifactManager 工件管理器（可选）
   * @returns 执行完成的工作流上下文
   */
  async runWorkflow(params: {
    startStep?: string;
    initialData?: Record<string, unknown>;
    maxIterations?: number;
    workflowLogger?: StructuredLogger;
    artifactManager?: unknown;
  } = {}): Promise<WorkflowContext> {
    const {
      startStep = "1",
      initialData,
      maxIterations = 100,
      workflowLogger,
      artifactManager,
    } = params;

    const context = new WorkflowContext({
      workflowId: `workflow_${Date.now()}`,
      data: initialData ? { ...initialData } : {},
      metadata: { startTime: Date.now() / 1000, startStep },
      workflowLogger: workflowLogger ?? null,
    });

    if (artifactManager) {
      context.artifactManager = artifactManager;
      context.data["artifactManager"] = artifactManager;
    }

    let currentStep = startStep;
    let iterationCount = 0;

    console.info(
      `开始执行工作流: ${context.workflowId}, 起始步骤: ${startStep}`,
    );

    if (workflowLogger) {
      workflowLogger.workflowStart(context.workflowId, initialData ?? {});
    }

    try {
      while (currentStep !== "END") {
        iterationCount++;
        if (iterationCount > maxIterations) {
          throw new Error(
            `工作流执行超过最大迭代次数 ${maxIterations}，可能存在循环`,
          );
        }

        console.info(`执行步骤: ${currentStep} (迭代 ${iterationCount})`);

        const action = this._actionRegistry.get(currentStep);
        if (!action) {
          const available = [...this._actionRegistry.keys()].join(", ");
          throw new Error(
            `步骤 ${currentStep} 未注册。可用步骤: ${available}`,
          );
        }

        const stepName =
          (action as unknown as { name?: string }).name ??
          `step_${currentStep}`;

        if (workflowLogger) {
          workflowLogger.stepStart(currentStep, stepName, {});
        }

        const stepStartTime = Date.now() / 1000;
        const result = await action(context);
        const stepDuration = Date.now() / 1000 - stepStartTime;

        if (!(result instanceof StepResult)) {
          throw new TypeError(
            `步骤 ${currentStep} 必须返回 StepResult 对象，实际返回: ${typeof result}`,
          );
        }

        result.metadata["duration"] = stepDuration;
        result.metadata["stepId"] = currentStep;

        context.update(currentStep, result);

        if (workflowLogger) {
          const cost = this._extractCostFromMetadata(result.metadata);
          workflowLogger.stepEnd(
            currentStep,
            result.metadata,
            cost ?? undefined,
            stepDuration,
          );
        }

        console.debug(
          `步骤 ${currentStep} 完成，耗时 ${stepDuration.toFixed(2)}s，下一步: ${result.nextStep}`,
        );

        if (!result.nextStep) {
          throw new Error(`步骤 ${currentStep} 未返回有效的 nextStep`);
        }
        currentStep = result.nextStep;
      }

      const totalDuration =
        Date.now() / 1000 - (context.metadata["startTime"] as number);
      context.metadata["endTime"] = Date.now() / 1000;
      context.metadata["totalDuration"] = totalDuration;
      context.metadata["totalIterations"] = iterationCount;

      console.info(
        `工作流执行完成: ${context.workflowId}, 总耗时 ${totalDuration.toFixed(2)}s, 共 ${iterationCount} 步`,
      );

      if (workflowLogger) {
        workflowLogger.workflowEnd("completed");
        workflowLogger.info(`工作流已完成`);
      }

      return context;
    } catch (e) {
      console.error(`工作流执行失败: ${e}`);
      context.metadata["error"] = String(e);
      context.metadata["failedStep"] = currentStep;
      throw e;
    }
  }

  private _extractCostFromMetadata(
    metadata: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const cost = metadata["cost"];
    if (cost && typeof cost === "object") {
      return cost as Record<string, unknown>;
    }
    return null;
  }

  /** 获取所有已注册的步骤 ID */
  getRegisteredSteps(): string[] {
    return [...this._actionRegistry.keys()];
  }

  /** 清空步骤注册表 */
  clearRegistry(): void {
    this._actionRegistry.clear();
    console.info("步骤注册表已清空");
  }
}

// ============================================================
// 全局默认引擎（便捷函数）
// ============================================================

let _defaultEngine: WorkflowEngine | null = null;

/** 获取全局默认工作流引擎实例（懒初始化） */
export function getDefaultEngine(): WorkflowEngine {
  if (!_defaultEngine) _defaultEngine = new WorkflowEngine();
  return _defaultEngine;
}

/** 在默认引擎中注册步骤 */
export function registerAction(stepId: string, action: ActionFn): void {
  getDefaultEngine().registerAction(stepId, action);
}

/** 使用默认引擎执行工作流 */
export async function runWorkflow(
  startStep = "1",
  initialData?: Record<string, unknown>,
  maxIterations = 100,
): Promise<WorkflowContext> {
  return getDefaultEngine().runWorkflow({ startStep, initialData, maxIterations });
}
