/**
 * Workflow action base class.
 *
 * This module defines the abstract BaseAction class used by all workflow
 * actions. Each action, such as file reads, LLM calls, or data saves, extends
 * BaseAction.
 *
 * Template Method pattern:
 *   run() defines the shared execution skeleton: timing, execution, logging,
 *   and metadata injection. Subclasses only implement execute() with their
 *   own business logic.
 *
 *   Call flow:
 *     external code calls action.run(context)
 *       -> run() records start time
 *       -> run() calls this.execute(context)
 *       -> run() injects action_name and action_duration into result.metadata
 *       -> run() returns result
 *
 * TypeScript does not have Python's __call__ hook, so callers use
 * action.run(context) explicitly.
 *
 * Subclasses live in the sibling action modules.
 */

// WorkflowContext stores shared workflow state. StepResult carries the next
// step, produced data, and metadata for a completed action.
import { WorkflowContext, StepResult } from "../workflow_engine.js";

/**
 * Lightweight logger.
 *
 * This file avoids the full structured logger to keep the base class dependency
 * surface small and avoid circular imports.
 */
const logger = {
  info: (msg: string) => console.info(msg),
  error: (msg: string) => console.error(msg),
};

/**
 * Abstract workflow action base class.
 *
 * BaseAction cannot be instantiated directly. Subclasses must implement the
 * abstract execute() method.
 *
 * Lifecycle:
 *   1. Construction receives the action name and config.
 *   2. Execution enters through run(context), which calls execute(context).
 *   3. run() injects action_name and action_duration into result.metadata.
 *   4. If execute() throws, run() appends error details to context.history.
 *
 * Cost preservation:
 *   An LLM action may successfully call an API, incur cost, and then fail while
 *   parsing or validating the response. Subclasses can set _lastCostInfo before
 *   throwing; run() preserves that data in the failure metadata.
 */
export abstract class BaseAction {
  /**
   * Action name.
   *
   * Used for logs and metadata. Defaults to the class name, or to the explicit
   * name passed from workflow configuration.
   */
  readonly name: string;

  /**
   * Action configuration from a workflow step.
   *
   * Example parsed from YAML:
   *   { model: "gpt4", prompt_template: "Translate this text: {text}", temperature: 0.7 }
   */
  readonly config: Record<string, unknown>;

  /**
   * Optional hook for already-incurred cost data.
   *
   * Subclasses such as LLMCallAction can set this after a successful API call.
   * If a later parsing or validation step fails, run() copies it to the error
   * metadata before rethrowing.
   *
   * Example:
   *   { model: "gpt-4o", input_tokens: 1500, output_tokens: 300, total_cost: 0.025 }
   */
  protected _lastCostInfo?: unknown;

  /**
   * Constructor.
   *
   * @param name Action name. Defaults to this.constructor.name.
   * @param config Action config. Defaults to an empty object.
   */
  constructor(name?: string, config: Record<string, unknown> = {}) {
    this.name = name ?? this.constructor.name;
    this.config = config;
  }

  /**
   * Executes the action. Subclasses must implement this method.
   *
   * @param context Workflow context with shared data and execution history.
   * @returns StepResult with nextStep, produced data, and metadata.
   * @throws Error when execution fails. run() records and rethrows it.
   */
  abstract execute(context: WorkflowContext): Promise<StepResult>;

  /**
   * Runs the action through the shared wrapper.
   *
   * This is the external entry point for actions. It centralizes logging,
   * timing, metadata injection, cost preservation, and error recording.
   *
   * @param context Workflow context.
   * @returns StepResult with action_name and action_duration metadata.
   * @throws The original execute() error, preserving its stack trace.
   */
  async run(context: WorkflowContext): Promise<StepResult> {
    logger.info(`Running action: ${this.name}`);
    const startTime = Date.now();

    try {
      const result = await this.execute(context);
      const duration = (Date.now() - startTime) / 1000;

      // WorkflowEngine stores this metadata in history for performance analysis.
      result.metadata["action_name"] = this.name;
      result.metadata["action_duration"] = duration;

      return result;
    } catch (e) {
      // Preserve duration even on failure for timeout and performance diagnosis.
      const duration = (Date.now() - startTime) / 1000;
      logger.error(`Action ${this.name} failed: ${e}`);

      const errorMetadata: Record<string, unknown> = {
        action_name: this.name,
        action_duration: duration,
        error: String(e),
        failed: true,
      };

      // Preserve cost if a subclass recorded API cost before failing.
      if (this._lastCostInfo !== undefined) {
        errorMetadata["cost"] = this._lastCostInfo;
        logger.info(`API call failed, but cost was recorded: ${JSON.stringify(this._lastCostInfo)}`);
      }

      // Append a consistent history entry so callers can inspect failed actions.
      context.history.push({
        stepId: "error",
        timestamp: Date.now() / 1000,
        data: {},
        metadata: errorMetadata,
      });

      // Rethrow the original error so upper layers decide how to handle it.
      throw e;
    }
  }

  /**
   * String representation for debug output.
   *
   * Example: <LLMCallAction(name='TranslateWithGPT4')>
   */
  toString(): string {
    return `<${this.constructor.name}(name='${this.name}')>`;
  }
}
