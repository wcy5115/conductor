import yaml from "js-yaml";
import fs from "fs";
import path from "path";

import { WorkflowEngine } from "./workflow_engine.js";
import { FractalParser, WorkflowGraph, autoOutputKey } from "./workflow_parser.js";
import { LogLevel, StructuredLogger } from "./core/logging.js";
import {
  isSilentTerminal,
  isVerboseTerminal,
  terminalError,
  terminalInternalDebug,
  terminalInternalInfo,
} from "./core/terminal_reporter.js";
import { BaseAction } from "./workflow_actions/base.js";
import { LLMCallAction } from "./workflow_actions/llm_actions.js";
import {
  SaveDataAction,
  LogAction,
  MergeJsonFilesAction,
} from "./workflow_actions/io_actions.js";
import {
  DataProcessAction,
  ConditionalBranchAction,
} from "./workflow_actions/data_actions.js";
import {
  ConcurrentAction,
  ActionConfig,
  SaveToFileConfig,
} from "./workflow_actions/concurrent_actions.js";
import {
  EpubExtractAction,
  MergeToEpubAction,
} from "./workflow_actions/ebook_actions.js";
import { PDFToImagesAction } from "./workflow_actions/pdf_actions.js";
import { saveToFile } from "./utils.js";
import { deepGet } from "./workflow_actions/utils.js";

type ConditionFunc = (data: Record<string, unknown>) => string;
type ProcessorFunc = (data: Record<string, unknown>) => Record<string, unknown>;

interface LoadResult {
  engine: WorkflowEngine;
  workflowLogger: StructuredLogger;
  config: Record<string, unknown>;
}

const logger = {
  info: (msg: string) => terminalInternalInfo(`[WorkflowLoader] ${msg}`),
  debug: (msg: string) => terminalInternalDebug(`[WorkflowLoader] ${msg}`),
  error: (msg: string) => terminalError(`[WorkflowLoader] ${msg}`),
};

export function resolvePathPlaceholders(
  value: unknown,
  workflowDir: string,
  paths: Record<string, string>,
): unknown {
  if (typeof value === "string") {
    let result = value;
    for (const [key, pathValue] of Object.entries(paths)) {
      const placeholder = `{paths.${key}}`;
      if (result.includes(placeholder)) {
        const fullPath = path.join(workflowDir, pathValue);
        result = result.replaceAll(placeholder, fullPath);
      }
    }
    return result;
  }

  if (typeof value === "object" && value !== null) {
    if (Array.isArray(value)) {
      return value.map((item) =>
        resolvePathPlaceholders(item, workflowDir, paths),
      );
    }

    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(obj)) {
      result[key] = resolvePathPlaceholders(item, workflowDir, paths);
    }
    return result;
  }

  return value;
}

const SUPPORTED_ACTION_TYPES = [
  "llm",
  "save_file",
  "conditional",
  "data_process",
  "log",
  "concurrent",
  "merge_json_files",
  "epub_extract",
  "merge_to_epub",
  "pdf_to_images",
] as const;

export class WorkflowLoader {
  private _customConditions: Map<string, ConditionFunc> = new Map();
  private _customProcessors: Map<string, ProcessorFunc> = new Map();

  registerCondition(name: string, conditionFunc: ConditionFunc): void {
    this._customConditions.set(name, conditionFunc);
    logger.debug(`Registered custom condition: ${name}`);
  }

  registerProcessor(name: string, processFunc: ProcessorFunc): void {
    this._customProcessors.set(name, processFunc);
    logger.debug(`Registered custom processor: ${name}`);
  }

  loadFromYaml(yamlPath: string): LoadResult {
    if (!fs.existsSync(yamlPath)) {
      throw new Error(`Workflow config file does not exist: ${yamlPath}`);
    }

    logger.info(`Loading workflow config: ${yamlPath}`);
    const fileContent = fs.readFileSync(yamlPath, "utf-8");
    const config = yaml.load(fileContent) as Record<string, unknown>;

    if (!config) {
      throw new Error(`Workflow config file is empty: ${yamlPath}`);
    }

    if (!("workflow_graph" in config)) {
      throw new Error(
        `Workflow config is missing the 'workflow_graph' field: ${yamlPath}`,
      );
    }

    const { workflowDir, workflowLogger } = this._createWorkflowWorkspace(
      yamlPath,
      config,
    );

    logger.info("Loading workflow");
    let engine: WorkflowEngine;
    try {
      engine = this._loadV2(config, yamlPath, workflowDir);
    } catch (error) {
      workflowLogger.close();
      throw error;
    }

    return { engine, workflowLogger, config };
  }

  private _createWorkflowWorkspace(
    yamlPath: string,
    config: Record<string, unknown>,
  ): { workflowDir: string; workflowLogger: StructuredLogger } {
    const projectName = config["project_name"] as string | undefined;
    if (!projectName) {
      throw new Error("YAML config is missing the 'project_name' field");
    }

    const workflowDir = path.join("data", projectName);
    fs.mkdirSync(workflowDir, { recursive: true });

    const paths = (config["paths"] as Record<string, string>) ?? {};
    for (const [pathKey, pathValue] of Object.entries(paths)) {
      if (pathKey !== "output") {
        const subDir = path.join(workflowDir, pathValue);
        fs.mkdirSync(subDir, { recursive: true });
      }
    }

    logger.info(`Created workflow directory: ${workflowDir}`);

    const configCopy = path.join(workflowDir, "workflow_config.yaml");
    fs.copyFileSync(yamlPath, configCopy);

    const logsDir = path.join(workflowDir, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const workflowLogger = new StructuredLogger({
      logDir: logsDir,
      enableConsole: !isSilentTerminal(),
      consoleLevel: isVerboseTerminal() ? LogLevel.INFO : LogLevel.WARNING,
    });

    return { workflowDir, workflowLogger };
  }

  private _loadV2(
    config: Record<string, unknown>,
    yamlPath: string,
    workflowDir: string,
  ): WorkflowEngine {
    const parser = new FractalParser();
    const workflowGraph = parser.parse(config["workflow_graph"] as any);
    logger.info(
      `Parsed workflow graph with ${Object.keys(workflowGraph.edges).length} nodes`,
    );

    const engine = new WorkflowEngine(workflowGraph);
    const steps = config["steps"] as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (!steps || Object.keys(steps).length === 0) {
      throw new Error(`Workflow config does not define any steps: ${yamlPath}`);
    }

    this._validateWorkflowGraphSteps(workflowGraph, steps, yamlPath);

    const paths = (config["paths"] as Record<string, string>) ?? {};
    for (const [stepId, stepConfig] of Object.entries(steps)) {
      const resolvedConfig = resolvePathPlaceholders(
        stepConfig,
        workflowDir,
        paths,
      ) as Record<string, unknown>;

      const action = this._createActionV2(
        stepId,
        resolvedConfig,
        workflowGraph,
        workflowDir,
      );

      engine.registerAction(stepId, action.run.bind(action), action.name);
      logger.debug(
        `Registered step (v2.0): ${stepId}, type: ${stepConfig["type"] as string}`,
      );
    }

    logger.info(
      `Workflow loaded (v2.0): ${(config["name"] as string) ?? "Unnamed"}, ${Object.keys(steps).length} steps`,
    );

    return engine;
  }

  private _validateWorkflowGraphSteps(
    workflowGraph: WorkflowGraph,
    steps: Record<string, Record<string, unknown>>,
    yamlPath: string,
  ): void {
    const definedSteps = new Set(Object.keys(steps));
    const referencedNodes = new Set<string>();

    const addNode = (node: string): void => {
      if (node !== "END") referencedNodes.add(node);
    };

    addNode(workflowGraph.startNode);
    for (const [fromStep, toSteps] of Object.entries(workflowGraph.edges)) {
      addNode(fromStep);
      for (const toStep of toSteps) addNode(toStep);
    }

    const missingSteps = [...referencedNodes].filter(
      (stepId) => !definedSteps.has(stepId),
    );

    if (missingSteps.length > 0) {
      throw new Error(
        `Invalid workflow_graph in ${yamlPath}: referenced step(s) missing from steps: ${missingSteps.join(", ")}`,
      );
    }
  }

  private _createActionV2(
    stepId: string,
    config: Record<string, unknown>,
    workflowGraph: WorkflowGraph,
    workflowDir: string,
  ): BaseAction {
    const actionType = config["type"] as string | undefined;
    if (!actionType) {
      throw new Error(`Step ${stepId} is missing the 'type' field`);
    }

    const stepName = (config["name"] as string) ?? `step_${stepId}`;

    switch (actionType) {
      case "llm":
        return this._createLLMActionV2(
          stepId,
          config,
          workflowGraph,
          workflowDir,
          stepName,
        );
      case "save_file":
        return this._createSaveFileActionV2(
          stepId,
          config,
          workflowGraph,
          workflowDir,
          stepName,
        );
      case "conditional":
        return this._createConditionalActionV2(
          stepId,
          config,
          workflowGraph,
          workflowDir,
          stepName,
        );
      case "data_process":
        return this._createDataProcessActionV2(
          stepId,
          config,
          workflowGraph,
          workflowDir,
          stepName,
        );
      case "log":
        return this._createLogActionV2(
          stepId,
          config,
          workflowGraph,
          workflowDir,
          stepName,
        );
      case "concurrent":
        return this._createConcurrentActionV2(
          stepId,
          config,
          workflowGraph,
          workflowDir,
          stepName,
        );
      case "merge_json_files":
        return this._createMergeJsonFilesActionV2(
          stepId,
          config,
          workflowGraph,
          workflowDir,
          stepName,
        );
      case "epub_extract":
        return this._createEpubExtractActionV2(
          stepId,
          config,
          workflowGraph,
          workflowDir,
          stepName,
        );
      case "merge_to_epub":
        return this._createMergeToEpubActionV2(
          stepId,
          config,
          workflowGraph,
          workflowDir,
          stepName,
        );
      case "pdf_to_images":
        return this._createPdfToImagesActionV2(
          stepId,
          config,
          workflowGraph,
          workflowDir,
          stepName,
        );
      default:
        throw new Error(
          `Step ${stepId} uses unsupported action type '${actionType}'. Supported types: ${SUPPORTED_ACTION_TYPES.join(", ")}`,
        );
    }
  }

  private _createLLMActionV2(
    stepId: string,
    config: Record<string, unknown>,
    workflowGraph: WorkflowGraph,
    _workflowDir: string,
    stepName: string,
  ): LLMCallAction {
    if (!config["model"]) {
      throw new Error(`Step ${stepId} is missing required field 'model'`);
    }
    if (!config["prompt"]) {
      throw new Error(`Step ${stepId} is missing required field 'prompt'`);
    }

    const nextSteps = workflowGraph.getNextSteps(stepId);
    const nextStep = nextSteps.length > 0 ? nextSteps[0] : "END";

    const actionConfig: Record<string, unknown> = {};
    if (config["validator"] !== undefined) {
      actionConfig["validator"] = config["validator"];
    }
    if (config["validator_config"] !== undefined) {
      actionConfig["validator_config"] = config["validator_config"];
    }
    if (config["max_retries"] !== undefined) {
      actionConfig["max_retries"] = config["max_retries"];
    }
    if (config["retry_delay"] !== undefined) {
      actionConfig["retry_delay"] = config["retry_delay"];
    }
    if (config["retry_backoff"] !== undefined) {
      actionConfig["retry_backoff"] = config["retry_backoff"];
    }

    return new LLMCallAction(
      config["model"] as string,
      config["prompt"] as string,
      autoOutputKey(stepId),
      nextStep,
      config["validate_json"] as boolean | undefined,
      config["temperature"] as number | undefined,
      config["max_tokens"] as number | undefined,
      config["timeout"] as number | undefined,
      config["required_fields"] as string[] | undefined,
      config["json_rules"] as Record<string, unknown> | undefined,
      (config["json_retry_max_attempts"] as number) ?? 3,
      (config["json_retry_enhance_prompt"] as boolean) ?? false,
      actionConfig,
      stepName,
    );
  }

  private _createSaveFileActionV2(
    stepId: string,
    config: Record<string, unknown>,
    workflowGraph: WorkflowGraph,
    _workflowDir: string,
    _stepName: string,
  ): SaveDataAction {
    if (!config["filepath"]) {
      throw new Error(`Step ${stepId} is missing required field 'filepath'`);
    }
    if (!config["data_key"]) {
      throw new Error(`Step ${stepId} is missing required field 'data_key'`);
    }

    const filepath = config["filepath"] as string;
    const dataKey = config["data_key"] as string;
    const showMessage = (config["show_message"] as boolean) ?? true;
    const nextSteps = workflowGraph.getNextSteps(stepId);
    const nextStep = nextSteps.length > 0 ? nextSteps[0] : "END";

    const saveFunc = (data: Record<string, unknown>): void => {
      const content = deepGet(data, dataKey, "") as string;
      saveToFile(filepath, content);
      if (showMessage) {
        terminalInternalInfo(`[OK] Saved file: ${filepath}`);
      }
    };

    return new SaveDataAction(
      saveFunc,
      nextStep,
      (config["name"] as string) ?? `SaveFile_${stepId}`,
    );
  }

  private _createConditionalActionV2(
    stepId: string,
    config: Record<string, unknown>,
    _workflowGraph: WorkflowGraph,
    _workflowDir: string,
    _stepName: string,
  ): ConditionalBranchAction {
    const conditionName = config["condition"] as string | undefined;
    if (!conditionName) {
      throw new Error(`Step ${stepId} is missing required field 'condition'`);
    }

    const conditionFunc = this._customConditions.get(conditionName);
    if (!conditionFunc) {
      throw new Error(
        `Step ${stepId} references unregistered condition '${conditionName}'. Register it with registerCondition('${conditionName}', func) before calling loadFromYaml`,
      );
    }

    return new ConditionalBranchAction(
      conditionFunc,
      (config["name"] as string) ?? `Conditional_${stepId}`,
    );
  }

  private _createDataProcessActionV2(
    stepId: string,
    config: Record<string, unknown>,
    workflowGraph: WorkflowGraph,
    _workflowDir: string,
    _stepName: string,
  ): DataProcessAction {
    const processorName = config["processor"] as string | undefined;
    if (!processorName) {
      throw new Error(`Step ${stepId} is missing required field 'processor'`);
    }

    const processFunc = this._customProcessors.get(processorName);
    if (!processFunc) {
      throw new Error(
        `Step ${stepId} references unregistered processor '${processorName}'. Register it with registerProcessor('${processorName}', func) before calling loadFromYaml`,
      );
    }

    const nextSteps = workflowGraph.getNextSteps(stepId);
    const nextStep = nextSteps.length > 0 ? nextSteps[0] : "END";

    return new DataProcessAction(
      processFunc,
      nextStep,
      (config["name"] as string) ?? `DataProcess_${stepId}`,
    );
  }

  private _createLogActionV2(
    stepId: string,
    config: Record<string, unknown>,
    workflowGraph: WorkflowGraph,
    _workflowDir: string,
    _stepName: string,
  ): LogAction {
    const nextSteps = workflowGraph.getNextSteps(stepId);
    const nextStep = nextSteps.length > 0 ? nextSteps[0] : "END";

    return new LogAction(
      (config["message"] as string) ?? `Step ${stepId}: {data}`,
      (config["level"] as string) ?? "INFO",
      nextStep,
      (config["name"] as string) ?? `Log_${stepId}`,
    );
  }

  private _createConcurrentActionV2(
    stepId: string,
    config: Record<string, unknown>,
    workflowGraph: WorkflowGraph,
    workflowDir: string,
    stepName: string,
  ): ConcurrentAction {
    if (!config["items_key"]) {
      throw new Error(`Step ${stepId} is missing required field 'items_key'`);
    }
    if (!config["process_steps"]) {
      throw new Error(`Step ${stepId} is missing required field 'process_steps'`);
    }

    const nextSteps = workflowGraph.getNextSteps(stepId);
    const nextStep = nextSteps.length > 0 ? nextSteps[0] : "END";

    return new ConcurrentAction(
      config["items_key"] as string,
      config["process_steps"] as ActionConfig[],
      (config["max_concurrent"] as number) ?? 5,
      config["task_dispatch_delay"] as number | undefined,
      (config["circuit_breaker_threshold"] as number) ?? 10,
      autoOutputKey(stepId),
      config["save_to_file"] as SaveToFileConfig | undefined,
      (config["fail_on_error"] as boolean) ?? false,
      nextStep,
      stepName,
      stepId,
      workflowDir,
    );
  }

  private _createMergeJsonFilesActionV2(
    stepId: string,
    config: Record<string, unknown>,
    workflowGraph: WorkflowGraph,
    _workflowDir: string,
    stepName: string,
  ): MergeJsonFilesAction {
    if (!config["input_dir"]) {
      throw new Error(`Step ${stepId} is missing required field 'input_dir'`);
    }
    if (!config["output_file"]) {
      throw new Error(`Step ${stepId} is missing required field 'output_file'`);
    }

    const nextSteps = workflowGraph.getNextSteps(stepId);
    const nextStep = nextSteps.length > 0 ? nextSteps[0] : "END";

    return new MergeJsonFilesAction(
      config["input_dir"] as string,
      config["output_file"] as string,
      (config["pattern"] as string) ?? "*.json",
      (config["sort_by"] as string) ?? "filename",
      autoOutputKey(stepId),
      nextStep,
      stepName,
      stepId,
    );
  }

  private _createEpubExtractActionV2(
    stepId: string,
    config: Record<string, unknown>,
    workflowGraph: WorkflowGraph,
    _workflowDir: string,
    stepName: string,
  ): EpubExtractAction {
    const nextSteps = workflowGraph.getNextSteps(stepId);
    const nextStep = nextSteps.length > 0 ? nextSteps[0] : "END";

    return new EpubExtractAction(
      (config["input_key"] as string) ?? "input_epub",
      autoOutputKey(stepId),
      (config["target_tokens"] as number) ?? 1000,
      (config["emergency_threshold"] as number) ?? 1500,
      nextStep,
      stepName,
      config["save_to_file"] as
        | { output_dir: string; filename_template?: string }
        | undefined,
    );
  }

  private _createMergeToEpubActionV2(
    stepId: string,
    config: Record<string, unknown>,
    workflowGraph: WorkflowGraph,
    _workflowDir: string,
    stepName: string,
  ): MergeToEpubAction {
    const nextSteps = workflowGraph.getNextSteps(stepId);
    const nextStep = nextSteps.length > 0 ? nextSteps[0] : "END";

    return new MergeToEpubAction(
      (config["aligned_key"] as string) ?? "3_response",
      (config["aligned_dir"] as string) ?? "artifacts/aligned",
      (config["output_dir"] as string) ?? "results",
      (config["output_filename"] as string) ?? "translated.epub",
      (config["book_title"] as string) ?? "Translated Book",
      autoOutputKey(stepId),
      nextStep,
      stepName,
    );
  }

  private _createPdfToImagesActionV2(
    stepId: string,
    config: Record<string, unknown>,
    workflowGraph: WorkflowGraph,
    _workflowDir: string,
    stepName: string,
  ): PDFToImagesAction {
    if (!config["pdf_path"]) {
      throw new Error(`Step ${stepId} is missing required field 'pdf_path'`);
    }
    if (!config["output_dir"]) {
      throw new Error(`Step ${stepId} is missing required field 'output_dir'`);
    }

    const nextSteps = workflowGraph.getNextSteps(stepId);
    const nextStep = nextSteps.length > 0 ? nextSteps[0] : "END";

    return new PDFToImagesAction(
      config["pdf_path"] as string,
      config["output_dir"] as string,
      (config["dpi"] as number) ?? 150,
      config["page_range"] as string | undefined,
      autoOutputKey(stepId),
      nextStep,
      stepName,
      stepId,
    );
  }
}

export function loadWorkflowFromYaml(
  yamlPath: string,
  customConditions?: Record<string, ConditionFunc>,
  customProcessors?: Record<string, ProcessorFunc>,
): LoadResult {
  const loader = new WorkflowLoader();

  if (customConditions) {
    for (const [name, func] of Object.entries(customConditions)) {
      loader.registerCondition(name, func);
    }
  }

  if (customProcessors) {
    for (const [name, func] of Object.entries(customProcessors)) {
      loader.registerProcessor(name, func);
    }
  }

  return loader.loadFromYaml(yamlPath);
}
