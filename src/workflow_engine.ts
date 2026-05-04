import { StructuredLogger } from "./core/logging.js";
import {
  getActiveTerminalReporter,
  terminalInternalDebug,
  terminalInternalError,
  terminalInternalInfo,
  terminalWarn,
} from "./core/terminal_reporter.js";
import type { WorkflowGraph } from "./workflow_parser.js";

export class StepResult {
  nextStep: string;
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;

  constructor(
    nextStep: string,
    data: Record<string, unknown> = {},
    metadata: Record<string, unknown> = {},
  ) {
    if (!nextStep) throw new Error("nextStep cannot be empty");
    this.nextStep = nextStep;
    this.data = data;
    this.metadata = metadata;
  }
}

export class WorkflowContext {
  workflowId: string;
  data: Record<string, unknown>;
  history: Array<Record<string, unknown>>;
  metadata: Record<string, unknown>;
  workflowLogger: StructuredLogger | null;
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

  getStepResult(stepId: string): Record<string, unknown> | null {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i]!["stepId"] === stepId) return this.history[i]!;
    }
    return null;
  }
}

export type ActionFn =
  | ((context: WorkflowContext) => StepResult)
  | ((context: WorkflowContext) => Promise<StepResult>);

interface RegisteredAction {
  action: ActionFn;
  name: string;
}

export class WorkflowEngine {
  private _actionRegistry: Map<string, RegisteredAction> = new Map();
  workflowGraph: WorkflowGraph | null;

  constructor(workflowGraph?: WorkflowGraph) {
    this.workflowGraph = workflowGraph ?? null;
    terminalInternalInfo(
      `Workflow engine initialized ${workflowGraph ? "(v2.0 mode)" : "(v1.0 mode)"}`,
    );
  }

  registerAction(stepId: string, action: ActionFn, actionName?: string): void {
    if (this._actionRegistry.has(stepId)) {
      terminalWarn(`Step ${stepId} already exists and will be overwritten`);
    }

    this._actionRegistry.set(stepId, {
      action,
      name: (actionName ?? action.name) || `step_${stepId}`,
    });
  }

  registerActions(actions: Record<string, ActionFn>): void {
    for (const [stepId, action] of Object.entries(actions)) {
      this.registerAction(stepId, action);
    }
  }

  async runWorkflow(params: {
    startStep?: string;
    initialData?: Record<string, unknown>;
    maxIterations?: number;
    workflowLogger?: StructuredLogger;
    artifactManager?: unknown;
  } = {}): Promise<WorkflowContext> {
    const {
      startStep,
      initialData,
      maxIterations = 100,
      workflowLogger,
      artifactManager,
    } = params;

    const effectiveStartStep = startStep ?? this.workflowGraph?.startNode ?? "1";
    const context = new WorkflowContext({
      workflowId: `workflow_${Date.now()}`,
      data: initialData ? { ...initialData } : {},
      metadata: { startTime: Date.now() / 1000, startStep: effectiveStartStep },
      workflowLogger: workflowLogger ?? null,
    });

    if (artifactManager) {
      context.artifactManager = artifactManager;
      context.data["artifactManager"] = artifactManager;
    }

    let currentStep = effectiveStartStep;
    let iterationCount = 0;

    terminalInternalInfo(
      `Starting workflow: ${context.workflowId}, start step: ${effectiveStartStep}`,
    );
    if (workflowLogger) {
      workflowLogger.workflowStart(context.workflowId, initialData ?? {});
    }

    try {
      while (currentStep !== "END") {
        iterationCount++;
        if (iterationCount > maxIterations) {
          throw new Error(
            `Workflow exceeded the maximum iteration count (${maxIterations}); a cycle may exist`,
          );
        }

        terminalInternalInfo(`Running step: ${currentStep} (iteration ${iterationCount})`);
        const registeredAction = this._actionRegistry.get(currentStep);
        if (!registeredAction) {
          const available = [...this._actionRegistry.keys()].join(", ");
          throw new Error(
            `Step ${currentStep} is not registered. Available steps: ${available}`,
          );
        }

        const { action, name: stepName } = registeredAction;
        getActiveTerminalReporter()?.stepStart({
          stepId: currentStep,
          stepName,
          iteration: iterationCount,
          totalSteps: this._actionRegistry.size,
        });
        if (workflowLogger) {
          workflowLogger.stepStart(currentStep, stepName, {});
        }

        const stepStartTime = Date.now() / 1000;
        const result = await action(context);
        const stepDuration = Date.now() / 1000 - stepStartTime;

        if (!(result instanceof StepResult)) {
          throw new TypeError(
            `Step ${currentStep} must return a StepResult object, got: ${typeof result}`,
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
        getActiveTerminalReporter()?.stepEnd({
          stepId: currentStep,
          stepName,
          durationSeconds: stepDuration,
          metadata: result.metadata,
        });

        terminalInternalDebug(
          `Step ${currentStep} completed in ${stepDuration.toFixed(2)}s; next step: ${result.nextStep}`,
        );
        if (!result.nextStep) {
          throw new Error(`Step ${currentStep} did not return a valid nextStep`);
        }

        currentStep = result.nextStep;
      }

      const totalDuration =
        Date.now() / 1000 - (context.metadata["startTime"] as number);
      context.metadata["endTime"] = Date.now() / 1000;
      context.metadata["totalDuration"] = totalDuration;
      context.metadata["totalIterations"] = iterationCount;

      terminalInternalInfo(
        `Workflow completed: ${context.workflowId}, total duration ${totalDuration.toFixed(2)}s, ${iterationCount} steps`,
      );
      if (workflowLogger) {
        workflowLogger.workflowEnd("completed");
        workflowLogger.info("Workflow completed");
      }

      return context;
    } catch (e) {
      terminalInternalError(`Workflow execution failed: ${e}`);
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

  getRegisteredSteps(): string[] {
    return [...this._actionRegistry.keys()];
  }

  clearRegistry(): void {
    this._actionRegistry.clear();
    terminalInternalInfo("Step registry cleared");
  }
}

let _defaultEngine: WorkflowEngine | null = null;

export function getDefaultEngine(): WorkflowEngine {
  if (!_defaultEngine) _defaultEngine = new WorkflowEngine();
  return _defaultEngine;
}

export function registerAction(stepId: string, action: ActionFn): void {
  getDefaultEngine().registerAction(stepId, action);
}

export async function runWorkflow(
  startStep = "1",
  initialData?: Record<string, unknown>,
  maxIterations = 100,
): Promise<WorkflowContext> {
  return getDefaultEngine().runWorkflow({ startStep, initialData, maxIterations });
}
