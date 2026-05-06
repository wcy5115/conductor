import fs from "fs";
import path from "path";

export interface BatchProgressEvent {
  stepId: string;
  stepName: string;
  total: number;
  success: number;
  failed: number;
  skipped: number;
  status?: string;
  itemLabel?: string;
}

interface ActiveBatch {
  stepId: string;
  stepName: string;
  total: number;
  concurrency: number;
  startedAt: number;
  lastLineLength: number;
  lastPrintedDone: number;
  lastRenderAt: number;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0s";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const remainingSeconds = whole % 60;
  return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`;
}

export class TerminalReporter {
  private activeBatch: ActiveBatch | null = null;

  workflowStart(params: {
    projectName: string;
    workflowName?: string;
    workflowDir: string;
    inputData: Record<string, unknown>;
  }): void {
    const title = params.workflowName ?? params.projectName;
    this.line("");
    this.line(`Running ${title}`);
    this.line(`Project: ${params.projectName}`);
    this.line(`Output: ${params.workflowDir}`);

    const inputPath = this.findInputPath(params.inputData);
    if (inputPath) this.line(`Input: ${inputPath}`);
    this.line("");
  }

  stepStart(params: {
    stepId: string;
    stepName: string;
    iteration: number;
    totalSteps: number;
  }): void {
    this.line(`Step ${params.iteration}/${params.totalSteps}: ${params.stepName}`);
  }

  stepEnd(params: {
    stepId: string;
    stepName: string;
    durationSeconds: number;
    metadata: Record<string, unknown>;
  }): void {
    if (this.activeBatch?.stepId === params.stepId) return;
    if (params.metadata["concurrent_stats"]) return;

    const details = this.formatStepDetails(params.metadata);
    const suffix = details ? ` - ${details}` : "";
    this.line(`  Done in ${formatDuration(params.durationSeconds)}${suffix}`);
  }

  batchStart(params: {
    stepId: string;
    stepName: string;
    total: number;
    concurrency: number;
  }): void {
    this.activeBatch = {
      stepId: params.stepId,
      stepName: params.stepName,
      total: params.total,
      concurrency: params.concurrency,
      startedAt: Date.now(),
      lastLineLength: 0,
      lastPrintedDone: -1,
      lastRenderAt: 0,
    };
    this.renderBatch({
      stepId: params.stepId,
      stepName: params.stepName,
      total: params.total,
      success: 0,
      failed: 0,
      skipped: 0,
      status: "starting",
    });
  }

  batchItemDone(event: BatchProgressEvent): void {
    const done = event.success + event.failed + event.skipped;
    if (!process.stdout.isTTY) {
      this.printNonTtyProgress(event, done);
      return;
    }
    const batch = this.activeBatch;
    if (batch && done !== event.total && Date.now() - batch.lastRenderAt < 120) {
      return;
    }
    this.renderBatch(event);
  }

  batchFinish(params: {
    stepId: string;
    stepName: string;
    total: number;
    success: number;
    failed: number;
    skipped: number;
    durationSeconds: number;
    circuitBreakerTriggered?: boolean;
  }): void {
    this.clearActiveLine();
    const completed = params.success + params.skipped;
    const resumed = params.skipped > 0 ? ` (resumed ${params.skipped})` : "";
    const failed = params.failed > 0 ? `, failed ${params.failed}` : "";
    const circuit = params.circuitBreakerTriggered ? ", stopped by circuit breaker" : "";
    this.line(
      `  Completed ${completed}/${params.total}${resumed}${failed}${circuit} ` +
      `in ${formatDuration(params.durationSeconds)}`
    );
    this.activeBatch = null;
  }

  workflowSuccess(params: {
    durationSeconds: number;
    totalIterations: number;
    workflowDir: string;
  }): void {
    this.clearActiveLine();
    this.line("");
    this.line(`Workflow completed in ${formatDuration(params.durationSeconds)}`);
    this.line(`Steps: ${params.totalIterations}`);
    this.printResultFiles(params.workflowDir);
    this.line(`Logs: ${path.join(params.workflowDir, "logs")}`);
  }

  workflowFailure(errorMessage: string, workflowDir: string): void {
    this.clearActiveLine();
    this.line("");
    this.error(`Workflow failed: ${errorMessage}`);
    this.line(`Logs: ${path.join(workflowDir, "logs")}`);
  }

  warn(message: string): void {
    this.clearActiveLine();
    console.warn(`Warning: ${message}`);
  }

  error(message: string): void {
    this.clearActiveLine();
    console.error(`Error: ${message}`);
  }

  line(message: string): void {
    this.clearActiveLine();
    console.log(message);
  }

  finish(): void {
    this.clearActiveLine();
  }

  private renderBatch(event: BatchProgressEvent): void {
    const batch = this.activeBatch;
    if (!batch) return;

    const done = event.success + event.failed + event.skipped;
    const completed = event.success + event.skipped;
    const pct = event.total > 0 ? ((done / event.total) * 100).toFixed(1) : "100.0";
    const elapsed = formatDuration((Date.now() - batch.startedAt) / 1000);
    const skipped = event.skipped > 0 ? ` skip ${event.skipped}` : "";
    const failed = event.failed > 0 ? ` fail ${event.failed}` : "";
    const bar = this.formatProgressBar(done, event.total);
    const line =
      `  ${bar} ${done}/${event.total} ${pct}% ok ${completed}` +
      `${skipped}${failed} ${elapsed}`;

    batch.lastLineLength = Math.max(batch.lastLineLength, line.length);
    batch.lastPrintedDone = done;
    batch.lastRenderAt = Date.now();
    this.writeActiveLine(line);
  }

  private printNonTtyProgress(event: BatchProgressEvent, done: number): void {
    const batch = this.activeBatch;
    if (!batch) return;
    const interval = Math.max(1, Math.ceil(event.total / 20));
    if (done !== event.total && done - batch.lastPrintedDone < interval) return;
    batch.lastPrintedDone = done;
    const completed = event.success + event.skipped;
    const pct = event.total > 0 ? ((done / event.total) * 100).toFixed(1) : "100.0";
    const resumed = event.skipped > 0 ? ` skip ${event.skipped}` : "";
    const failed = event.failed > 0 ? ` fail ${event.failed}` : "";
    this.line(
      `  ${this.formatProgressBar(done, event.total)} ${done}/${event.total} ${pct}% ` +
      `ok ${completed}${resumed}${failed}`
    );
  }

  private clearActiveLine(): void {
    if (!this.activeBatch || this.activeBatch.lastLineLength === 0 || !process.stdout.isTTY) {
      return;
    }
    if (typeof process.stdout.clearLine === "function" && typeof process.stdout.cursorTo === "function") {
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
    } else {
      process.stdout.write(`\r${" ".repeat(this.activeBatch.lastLineLength)}\r`);
    }
    this.activeBatch.lastLineLength = 0;
  }

  private writeActiveLine(line: string): void {
    if (typeof process.stdout.clearLine === "function" && typeof process.stdout.cursorTo === "function") {
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
      process.stdout.write(line);
      return;
    }
    process.stdout.write(`\r${line}${" ".repeat(Math.max(0, (this.activeBatch?.lastLineLength ?? 0) - line.length))}`);
  }

  private formatProgressBar(done: number, total: number): string {
    const width = 16;
    const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 1;
    const filled = Math.round(ratio * width);
    return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
  }

  private findInputPath(inputData: Record<string, unknown>): string | null {
    for (const key of ["input_epub", "input_file", "input_file_path", "input_pdf"]) {
      const value = inputData[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return null;
  }

  private formatStepDetails(metadata: Record<string, unknown>): string {
    const chunks = metadata["chunk_count"];
    if (typeof chunks === "number") {
      const source = metadata["source"] === "cache" ? " restored from cache" : "";
      return `${chunks} chunks${source}`;
    }

    const stats = metadata["concurrent_stats"];
    if (stats && typeof stats === "object") {
      const s = stats as Record<string, unknown>;
      const total = typeof s["total"] === "number" ? s["total"] : 0;
      const success = typeof s["success"] === "number" ? s["success"] : 0;
      const skipped = typeof s["skipped"] === "number" ? s["skipped"] : 0;
      const failed = typeof s["failed"] === "number" ? s["failed"] : 0;
      const resumed = skipped > 0 ? `, resumed ${skipped}` : "";
      const failedText = failed > 0 ? `, failed ${failed}` : "";
      return `${success + skipped}/${total} completed${resumed}${failedText}`;
    }

    const txtPath = metadata["txt_path"];
    if (typeof txtPath === "string") return `TXT output: ${txtPath}`;

    return "";
  }

  private printResultFiles(workflowDir: string): void {
    const resultsDir = path.join(workflowDir, "results");
    if (!fs.existsSync(resultsDir)) {
      this.line(`Output: ${workflowDir}`);
      return;
    }

    const files = fs
      .readdirSync(resultsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(resultsDir, entry.name));

    if (files.length === 0) {
      this.line(`Output: ${workflowDir}`);
      return;
    }

    this.line("Result files:");
    for (const file of files) this.line(`  ${file}`);
  }
}

let activeReporter: TerminalReporter | null = null;

export function setActiveTerminalReporter(reporter: TerminalReporter): void {
  activeReporter = reporter;
}

export function clearActiveTerminalReporter(reporter?: TerminalReporter): void {
  if (!reporter || activeReporter === reporter) activeReporter = null;
}

export function getActiveTerminalReporter(): TerminalReporter | null {
  return activeReporter;
}

export function isVerboseTerminal(): boolean {
  return false;
}

export function isSilentTerminal(): boolean {
  return false;
}

export function terminalInternalInfo(message: string): void {
  if (isVerboseTerminal()) console.info(message);
}

export function terminalInternalDebug(message: string): void {
  if (isVerboseTerminal()) console.debug(message);
}

export function terminalInternalWarn(message: string): void {
  if (isVerboseTerminal()) console.warn(message);
}

export function terminalInternalError(message: string): void {
  if (isVerboseTerminal()) console.error(message);
}

export function terminalWarn(message: string): void {
  const reporter = activeReporter;
  if (reporter) reporter.warn(message);
  else console.warn(`Warning: ${message}`);
}

export function terminalError(message: string): void {
  const reporter = activeReporter;
  if (reporter) reporter.error(message);
  else console.error(`Error: ${message}`);
}
