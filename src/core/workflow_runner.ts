import path from "path";

import { WorkflowEngine, WorkflowContext } from "../workflow_engine.js";
import { loadWorkflowFromYaml } from "../workflow_loader.js";
import { StructuredLogger } from "./logging.js";
import { cleanDirectory } from "../cli/clean.js";
import {
  TerminalReporter,
  clearActiveTerminalReporter,
  setActiveTerminalReporter,
} from "./terminal_reporter.js";

interface RunOptions {
  inputData: Record<string, unknown>;
  cleanupOnSuccess?: boolean;
  cleanupTargets?: string[];
  interactiveCleanup?: boolean;
}

interface RunResult {
  status: "success" | "failed";
  workflowDir: string;
  context?: WorkflowContext;
  error?: string;
  cleaned?: boolean;
}

export class WorkflowRunner {
  private readonly engine: WorkflowEngine;
  private readonly logger: StructuredLogger;
  private readonly config: Record<string, unknown>;
  private readonly workflowDir: string;

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

  static async fromYaml(
    yamlPath: string,
    baseDir?: string,
  ): Promise<WorkflowRunner> {
    const { engine, workflowLogger, config } = loadWorkflowFromYaml(yamlPath);
    const projectName = config["project_name"] as string;
    const effectiveBaseDir = baseDir ?? "data";
    const workflowDir = path.join(effectiveBaseDir, projectName);
    return new WorkflowRunner(engine, workflowLogger, config, workflowDir);
  }

  async run(options?: RunOptions): Promise<RunResult> {
    const {
      inputData = {},
      cleanupOnSuccess = false,
      cleanupTargets = ["artifacts"],
      interactiveCleanup = false,
    } = options ?? {};

    const reporter = new TerminalReporter();
    setActiveTerminalReporter(reporter);
    reporter.workflowStart({
      projectName: (this.config["project_name"] as string) ?? "Unknown",
      workflowName: this.config["name"] as string | undefined,
      workflowDir: this.workflowDir,
      inputData,
    });

    try {
      const context = await this.engine.runWorkflow({
        initialData: inputData,
        workflowLogger: this.logger,
      });

      reporter.workflowSuccess({
        durationSeconds: (context.metadata["totalDuration"] as number) ?? 0,
        totalIterations: (context.metadata["totalIterations"] as number) ?? 0,
        workflowDir: this.workflowDir,
      });

      let cleaned = false;
      if (cleanupOnSuccess) {
        cleanDirectory(this.workflowDir, { targets: cleanupTargets });
        cleaned = true;
      }

      if (interactiveCleanup) {
        reporter.line("[Note] Interactive cleanup is not implemented yet");
      }

      return {
        status: "success",
        workflowDir: this.workflowDir,
        context,
        cleaned,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      reporter.workflowFailure(errorMessage, this.workflowDir);
      this.logger.error(
        "Workflow execution failed",
        error instanceof Error ? error : undefined,
      );
      return {
        status: "failed",
        workflowDir: this.workflowDir,
        error: errorMessage,
      };
    } finally {
      reporter.finish();
      clearActiveTerminalReporter(reporter);
    }
  }

  getOutputFile(filename: string): string {
    return path.join(this.workflowDir, filename);
  }

  toString(): string {
    return `WorkflowRunner(workflowDir='${this.workflowDir}')`;
  }
}

export async function runWorkflowFromYaml(
  yamlPath: string,
  inputData: Record<string, unknown> = {},
  baseDir?: string,
): Promise<RunResult> {
  const runner = await WorkflowRunner.fromYaml(yamlPath, baseDir);
  return runner.run({ inputData });
}
