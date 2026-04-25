/**
 * PDF workflow action wrapper.
 *
 * This action exposes PDF-to-image conversion as a workflow step so YAML
 * workflows can use the `pdf_to_images` action type directly.
 *
 * It delegates the actual conversion to `convertPdfToImages()` in
 * `src/pdf_to_images.ts` and is responsible for:
 * 1. Reading step configuration from YAML.
 * 2. Resolving path templates with values from `context.data`.
 * 3. Calling the converter.
 * 4. Writing the result directory, file list, and image count back to
 *    `context.data` for downstream steps.
 */

import fs from "fs";
import path from "path";

import { WorkflowContext, StepResult } from "../workflow_engine.js";
import { convertPdfToImages } from "../pdf_to_images.js";

import { BaseAction } from "./base.js";
import { formatPathTemplate } from "./utils.js";

// ============================================================
// PDFToImagesAction
// ============================================================

/**
 * Convert a PDF into a sequence of JPEG images.
 *
 * This is the workflow-layer wrapper around `convertPdfToImages()`. It
 * resolves path templates from workflow data, runs the conversion, scans the
 * output directory, and stores the resulting paths in workflow state.
 *
 * Keys written to `context.data`:
 * - `{outputKey}`: output directory path
 * - `{outputKey}_files`: array of generated image file paths
 * - `{outputKey}_count`: number of generated image files
 */
export class PDFToImagesAction extends BaseAction {
  // PDF file path template. Supports placeholders such as `{input_pdf}`.
  private readonly pdfPath: string;

  // Output directory path template. Also supports placeholders.
  private readonly outputDir: string;

  // Rendering DPI. Defaults to 150.
  private readonly dpi: number;

  // Optional page range such as "1-10" or "1-5,10,15-20".
  // When undefined, all pages are converted.
  private readonly pageRange: string | undefined;

  // Prefix used for keys written into `context.data`.
  private readonly outputKey: string;

  // Next workflow step after conversion completes.
  private readonly nextStep: string;

  // Step identifier used in log messages.
  private readonly stepId: string;

  constructor(
    pdfPath: string,
    outputDir: string,
    dpi: number = 150,
    pageRange: string | undefined = undefined,
    outputKey: string = "pdf_images_dir",
    nextStep: string = "END",
    name: string = "PDF to images",
    stepId: string = "unknown",
    config: Record<string, unknown> = {}
  ) {
    super(name, config);
    this.pdfPath = pdfPath;
    this.outputDir = outputDir;
    this.dpi = dpi;
    this.pageRange = pageRange;
    this.outputKey = outputKey;
    this.nextStep = nextStep;
    this.stepId = stepId;
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    // Resolve path templates such as `{input_pdf}` from workflow state.
    let pdfPath: string;
    let outputDir: string;
    try {
      pdfPath = formatPathTemplate(this.pdfPath, context.data);
      outputDir = formatPathTemplate(this.outputDir, context.data);
    } catch (e) {
      throw new Error(`PDF path template is missing required context data: ${e}`);
    }

    console.info(
      `[Step ${this.stepId}] Starting PDF conversion: ${pdfPath} -> ${outputDir}`
    );
    const resultDir = convertPdfToImages(
      pdfPath,
      outputDir,
      this.dpi,
      this.pageRange
    );

    // Collect generated image files from the output directory. We intentionally
    // use a strict filename pattern to avoid unrelated JPG files.
    const resultPath = path.resolve(resultDir);
    const imageFiles = fs
      .readdirSync(resultPath)
      .filter((f) => /^page_\d{4}\.jpg$/.test(f))
      .sort()
      .map((f) => path.join(resultPath, f));

    console.info(
      `[Step ${this.stepId}] PDF conversion finished and produced ${imageFiles.length} image(s)`
    );

    return new StepResult(
      this.nextStep,
      {
        [this.outputKey]: resultDir,
        [`${this.outputKey}_files`]: imageFiles,
        [`${this.outputKey}_count`]: imageFiles.length,
      },
      {
        pdf_path: pdfPath,
        output_dir: resultDir,
        dpi: this.dpi,
        page_range: this.pageRange,
        image_count: imageFiles.length,
      }
    );
  }
}
