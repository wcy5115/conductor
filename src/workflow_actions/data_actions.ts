/**
 * Data-only workflow actions.
 *
 * These actions operate on in-memory workflow data and choose the next step.
 * They do not perform file I/O or network calls.
 */

import { WorkflowContext, StepResult } from "../workflow_engine.js";
import { BaseAction } from "./base.js";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function describeValueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/**
 * Run a caller-provided processor against `context.data` and merge the
 * returned fields into the workflow state.
 */
export class DataProcessAction extends BaseAction {
  private readonly processFunc: (
    data: Record<string, unknown>
  ) => Record<string, unknown>;

  private readonly nextStep: string;

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

  async execute(context: WorkflowContext): Promise<StepResult> {
    const resultData = this.processFunc(context.data);
    if (!isPlainRecord(resultData)) {
      throw new Error(
        `Data processor '${this.name}' must return a plain object, received ${describeValueType(resultData)}`
      );
    }

    return new StepResult(this.nextStep, resultData, {
      processed_keys: Object.keys(resultData),
    });
  }
}

/**
 * Choose the next workflow step dynamically from the current workflow data.
 */
export class ConditionalBranchAction extends BaseAction {
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
    const nextStep = this.conditionFunc(context.data);
    return new StepResult(nextStep, {}, { branch_result: nextStep });
  }
}
