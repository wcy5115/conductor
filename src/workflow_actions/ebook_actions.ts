/**
 * Ebook translation actions.
 *
 * This module contains three helper functions and three action classes for
 * ebook translation workflows:
 *   Helpers:
 *     - calculateTokens - lightweight token estimation
 *     - forceTruncateAtTarget - hard-split text by estimated token count
 *     - splitBySentences - sentence-aware splitting with token accumulation
 *
 *   Actions:
 *     - EpubExtractAction - read ePub/TXT files, extract text, and split it
 *     - MergeToEpubAction - merge translated aligned text into ePub + TXT
 *     - ParseTranslationAction - parse ###SEGMENT### blocks from LLM responses
 *
 * Ported from the Python version at LLM_agent/src/workflow_actions/ebook_actions.py.
 */

import fs from "fs";
import path from "path";
import { EPub } from "epub";
import * as cheerio from "cheerio";
import { WorkflowContext, StepResult } from "../workflow_engine.js";
import { BaseAction } from "./base.js";

// nodepub is a CommonJS package without bundled TypeScript definitions.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodepub = require("nodepub");

/**
 * Minimal interface for the nodepub document object.
 *
 * nodepub.document(metadata) returns an object with these methods.
 */
interface NodepubDocument {
  /** Add one section to the ePub. */
  addSection: (
    title: string,
    content: string,
    excludeFromContents?: boolean,
    isFrontMatter?: boolean,
    overrideFilename?: string
  ) => void;
  /** Write the ePub into a folder. The filename should omit the .epub suffix. */
  writeEPUB: (folder: string, filename: string) => Promise<void>;
}

/**
 * Minimal logger.
 *
 * Keeps this action consistent with base.ts without introducing a logging dependency.
 */
const logger = {
  info: (msg: string) => console.info(msg),
  error: (msg: string) => console.error(msg),
  warn: (msg: string) => console.warn(msg),
};

const DEFAULT_CHUNK_FILENAME_TEMPLATE = "chunk_{index:04d}.txt";

const DEFAULT_COVER_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

interface MergeCountSummary {
  successCount: number;
  skippedCount: number;
  availableCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function getMergeCountSummary(
  data: Record<string, unknown>,
  alignedKey: string
): MergeCountSummary | null {
  const alignedResult = data[alignedKey];
  const statsResult = data[`${alignedKey}_stats`];
  const statsSource = isRecord(statsResult)
    ? statsResult
    : isRecord(alignedResult)
      ? alignedResult
      : null;

  if (statsSource) {
    const successCount = asCount(statsSource["success"]);
    const skippedCount = asCount(statsSource["skipped"]);
    return {
      successCount,
      skippedCount,
      availableCount: successCount + skippedCount,
    };
  }

  if (Array.isArray(alignedResult)) {
    return {
      successCount: alignedResult.length,
      skippedCount: 0,
      availableCount: alignedResult.length,
    };
  }

  return null;
}

function formatChunkFilename(template: string, index: number): string {
  return template.replace(/\{index(?::(\d+)d)?\}/, (_, width) => {
    const w = width ? parseInt(width, 10) : 0;
    return String(index).padStart(w, "0");
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function chunkFilenamePattern(template: string): RegExp {
  const match = /\{index(?::(\d+)d)?\}/.exec(template);
  if (!match) {
    return new RegExp(`^${escapeRegExp(template)}$`);
  }

  const before = escapeRegExp(template.slice(0, match.index));
  const after = escapeRegExp(template.slice(match.index + match[0].length));
  const digits = match[1] ? `\\d{${parseInt(match[1], 10)}}` : "\\d+";
  return new RegExp(`^${before}(${digits})${after}$`);
}

function listSavedChunkFiles(
  outputDir: string,
  template: string
): Array<{ filename: string; index: number }> {
  const pattern = chunkFilenamePattern(template);
  return fs
    .readdirSync(outputDir)
    .map((filename) => {
      const match = pattern.exec(filename);
      if (!match) return null;
      const index = match[1] ? parseInt(match[1], 10) : 1;
      return { filename, index };
    })
    .filter((entry): entry is { filename: string; index: number } => entry !== null)
    .sort((a, b) => a.index - b.index);
}

// ============================================================
// Internal helper functions
// ============================================================

/**
 * Lightweight token estimation.
 *
 * This intentionally avoids a model-specific tokenizer such as tiktoken.
 * It uses a simple heuristic that is fast enough for chunk sizing:
 *   - CJK characters in \u4e00-\u9fff count as 1 token each
 *   - English words matched by \b[a-zA-Z]+\b count as 2 tokens each
 *   - Other characters count as 1 token each
 *
 * Real token counts depend on the target model tokenizer, but this is enough
 * for rough text splitting.
 *
 * Examples:
 *   calculateTokens("\u4f60\u597d") -> 2
 *   calculateTokens("hello world") -> 5
 *   calculateTokens("") -> 0
 *
 * @param text Text to estimate.
 * @returns Estimated token count.
 */
function calculateTokens(text: string): number {
  if (!text) return 0;

  // Match the basic CJK unified ideograph range.
  const chineseChars = (text.match(/[\u4e00-\u9fff]/gu) || []).length;

  // Match complete alphabetic English words.
  const englishWords = text.match(/\b[a-zA-Z]+\b/gu) || [];
  // Total characters consumed by English words.
  const englishWordChars = englishWords.reduce((sum, w) => sum + w.length, 0);
  // English words are estimated as 2 tokens each.
  const englishWordTokens = englishWords.length * 2;
  // Punctuation, spaces, digits, and symbols are estimated as 1 token each.
  const otherChars = text.length - chineseChars - englishWordChars;

  return chineseChars + englishWordTokens + otherChars;
}

/**
 * Hard-truncate text by estimated token count.
 *
 * Walks through the text character by character and returns [head, tail].
 * head stays within the target token budget, and tail contains the remainder.
 *
 * If the whole text fits, tail is an empty string.
 *
 * Examples:
 *   forceTruncateAtTarget("hello", 2) -> ["h", "ello"]
 *   forceTruncateAtTarget("hi", 100) -> ["hi", ""]
 *
 * @param text Text to split.
 * @param targetTokens Target token ceiling.
 * @returns [head, tail].
 */
function forceTruncateAtTarget(
  text: string,
  targetTokens: number
): [string, string] {
  // Fast path: the whole text already fits.
  if (calculateTokens(text) <= targetTokens) {
    return [text, ""];
  }

  // Accumulate token estimates until adding the next character would exceed the target.
  let currentTokens = 0;
  for (let i = 0; i < text.length; i++) {
    const charTokens = calculateTokens(text[i]!);
    if (currentTokens + charTokens > targetTokens) {
      return [text.slice(0, i), text.slice(i)];
    }
    currentTokens += charTokens;
  }

  // Defensive fallback.
  return [text, ""];
}

/**
 * Sentence-aware splitting with token accumulation.
 *
 * Flow:
 *   1. Split text by common Chinese and English sentence-ending punctuation.
 *   2. Accumulate estimated tokens sentence by sentence.
 *   3. If the accumulated size reaches the emergency threshold, hard-split
 *      with forceTruncateAtTarget so a single chunk cannot grow too large.
 *
 * targetTokens is the preferred chunk size. emergencyThreshold is the safety
 * ceiling where preserving sentence boundaries becomes less important than
 * keeping chunks bounded.
 *
 * Example:
 *   splitBySentences("First. Second. Third.", 5, 10)
 *   may return ["First.", "Second.", "Third."] depending on token estimates.
 *
 * @param fullText Full text to split.
 * @param targetTokens Preferred token count per chunk.
 * @param emergencyThreshold Hard-split threshold.
 * @returns Split text chunks.
 */
function splitBySentences(
  fullText: string,
  targetTokens: number,
  emergencyThreshold: number
): string[] {
  // Use a capture group so split keeps the sentence-ending punctuation.
  const SENTENCE_ENDINGS = /([。！？.?!؟।॥])/;
  const sentences = fullText.split(SENTENCE_ENDINGS);

  // Reattach each delimiter to the preceding sentence.
  let parts: string[];
  if (sentences.length <= 1) {
    // No sentence delimiter was found, so the whole text is one part.
    parts = [fullText];
  } else {
    parts = [];
    // Pair content with delimiter: sentences[0]+sentences[1], etc.
    for (let i = 0; i < sentences.length - 1; i += 2) {
      parts.push((sentences[i] ?? "") + (sentences[i + 1] ?? ""));
    }
    // Preserve any trailing text that has no matching delimiter.
    if (sentences.length % 2 !== 0) {
      parts.push(sentences[sentences.length - 1] ?? "");
    }
  }

  // Accumulate sentence-sized parts into chunks.
  const finalChunks: string[] = [];
  let currentChunkParts: string[] = [];
  let currentTokens = 0;

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const partTokens = calculateTokens(trimmed);

    // Emergency mode: stop waiting for sentence boundaries and hard-split.
    if (
      currentTokens >= emergencyThreshold ||
      currentTokens + partTokens >= emergencyThreshold
    ) {
      currentChunkParts.push(trimmed);
      const superChunk = currentChunkParts.join("");

      // Repeatedly split an oversized chunk back down to the preferred size.
      let processingChunk = superChunk;
      while (calculateTokens(processingChunk) > 0) {
        const [head, tail] = forceTruncateAtTarget(
          processingChunk,
          targetTokens
        );
        if (head) {
          finalChunks.push(head);
        }
        processingChunk = tail;
      }

      // Reset accumulation after the emergency split.
      currentChunkParts = [];
      currentTokens = 0;
      continue;
    }

    // Normal mode: if this part exceeds the target, close the current chunk first.
    if (currentTokens + partTokens > targetTokens && currentChunkParts.length > 0) {
      finalChunks.push(currentChunkParts.join(""));
      currentChunkParts = [trimmed];
      currentTokens = partTokens;
    } else {
      // Still within the preferred target.
      currentChunkParts.push(trimmed);
      currentTokens += partTokens;
    }
  }

  // Flush the final accumulated chunk.
  if (currentChunkParts.length > 0) {
    finalChunks.push(currentChunkParts.join(""));
  }

  return finalChunks;
}

// ============================================================
// EpubExtractAction - extract and split text from ePub/TXT files
// ============================================================

/**
 * Extract text from an ePub or TXT file and split it into chunks.
 *
 * Supported formats: .epub, .txt
 *
 * Flow:
 *   1. Choose extraction mode by file extension.
 *   2. For ePub, walk all flow items and extract text from chapter HTML.
 *      For TXT, detect common encodings and read the full file.
 *   3. Merge all text.
 *   4. Split with splitBySentences.
 *   5. Return numbered text chunks.
 *
 * Input: context.data[inputKey] is the ebook file path.
 * Output: context.data[outputKey] is an array of { index, text } chunks.
 *
 * Example output:
 *   [
 *     { index: 1, text: "Chapter one..." },
 *     { index: 2, text: "Chapter two..." }
 *   ]
 */
export class EpubExtractAction extends BaseAction {
  static readonly SUPPORTED_EXTENSIONS = new Set([".epub", ".txt"]);

  // Key used to read the ebook path from context.data.
  private readonly inputKey: string;
  // Key used to store split chunks in context.data.
  private readonly outputKey: string;
  // Preferred token count per text chunk.
  private readonly targetTokens: number;
  // Hard-split threshold passed to splitBySentences.
  private readonly emergencyThreshold: number;
  // Next step after extraction completes.
  private readonly nextStep: string;
  // Optional resume configuration for saving and restoring extracted chunks.
  // Example: { output_dir: "data/{project}/original", filename_template: "chunk_{index:04d}.txt" }
  private readonly saveToFile?: { output_dir: string; filename_template?: string };

  constructor(
    inputKey: string = "input_epub",
    outputKey: string = "chunks",
    targetTokens: number = 1000,
    emergencyThreshold: number = 1500,
    nextStep: string = "2",
    name: string = "Extract and Split Text",
    saveToFile?: { output_dir: string; filename_template?: string },
    config: Record<string, unknown> = {}
  ) {
    super(name, config);
    this.inputKey = inputKey;
    this.outputKey = outputKey;
    this.targetTokens = targetTokens;
    this.emergencyThreshold = emergencyThreshold;
    this.nextStep = nextStep;
    this.saveToFile = saveToFile;
  }

  /**
   * Extract full text from an ePub file.
   */
  private async extractEpub(filePath: string): Promise<string> {
    const epub = new EPub(filePath);
    await epub.parse();

    const allText: string[] = [];
    for (const item of epub.flow) {
      try {
        const html = await epub.getChapter(item.id);
        if (html) {
          const $ = cheerio.load(html);
          const text = $.text();
          if (text.trim()) {
            allText.push(text.trim());
          }
        }
      } catch {
        logger.warn(`Skipping chapter that could not be parsed: ${item.id}`);
      }
    }
    return allText.join("\n\n");
  }

  /**
   * Read full text from a TXT file.
   *
   * Tries common encodings: utf-8, utf-8-sig (BOM), gbk, gb18030.
   * Node.js native buffer decoding handles utf-8; TextDecoder handles the rest.
   */
  private extractTxt(filePath: string): string {
    const buffer = fs.readFileSync(filePath);

    // Detect and strip a UTF-8 BOM.
    if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
      logger.info("TXT file encoding: utf-8-sig");
      return buffer.subarray(3).toString("utf-8");
    }

    // Try UTF-8.
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      logger.info("TXT file encoding: utf-8");
      return text;
    } catch { /* Not valid UTF-8. */ }

    // Try GBK / GB18030.
    for (const encoding of ["gbk", "gb18030"] as const) {
      try {
        const text = new TextDecoder(encoding, { fatal: true }).decode(buffer);
        logger.info(`TXT file encoding: ${encoding}`);
        return text;
      } catch { /* Try the next encoding. */ }
    }

    throw new Error("Could not decode TXT file; tried encodings: utf-8, utf-8-sig, gbk, gb18030");
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    // Read the ebook path from context.
    const filePath = context.data[this.inputKey] as string | undefined;
    if (!filePath) {
      throw new Error(`Missing input path: ${this.inputKey}`);
    }

    // Validate the file extension.
    const ext = path.extname(filePath).toLowerCase();
    if (!EpubExtractAction.SUPPORTED_EXTENSIONS.has(ext)) {
      throw new Error(
        `Unsupported file format: ${ext}; supported formats: ${[...EpubExtractAction.SUPPORTED_EXTENSIONS].join(", ")}`
      );
    }

    // Resume: restore from saved chunk files when they already exist.
    if (this.saveToFile) {
      const template =
        this.saveToFile.filename_template ?? DEFAULT_CHUNK_FILENAME_TEMPLATE;
      let resolvedDir = this.saveToFile.output_dir;
      for (const [key, value] of Object.entries(context.data)) {
        resolvedDir = resolvedDir.replaceAll(`{${key}}`, String(value));
      }
      const outputDir = path.resolve(resolvedDir);

      if (fs.existsSync(outputDir)) {
        const existingFiles = listSavedChunkFiles(outputDir, template);

        if (existingFiles.length > 0) {
          const chunkList = existingFiles.map((entry, i) => ({
            index: i + 1,
            text: fs.readFileSync(path.join(outputDir, entry.filename), "utf-8"),
          }));
          logger.info(`Restored ${chunkList.length} chunk(s) from existing chunk files; skipping extraction`);
          return new StepResult(
            this.nextStep,
            { [this.outputKey]: chunkList },
            { chunk_count: chunkList.length, source: "cache" }
          );
        }
      }
    }

    logger.info(`Starting text extraction (${ext}): ${filePath}`);

    // Extract full text by file type.
    let fullText: string;
    if (ext === ".epub") {
      fullText = await this.extractEpub(filePath);
    } else {
      fullText = this.extractTxt(filePath);
    }

    // Split text with sentence boundaries and token estimates.
    const chunks = splitBySentences(
      fullText,
      this.targetTokens,
      this.emergencyThreshold
    );

    // Convert chunks into 1-based numbered records, matching the Python version.
    const chunkList = chunks.map((chunk, i) => ({
      index: i + 1,
      text: chunk,
    }));

    logger.info(`Extraction finished; split into ${chunkList.length} text chunk(s)`);

    // Save chunks to files for resume support.
    if (this.saveToFile) {
      let resolvedDir = this.saveToFile.output_dir;
      for (const [key, value] of Object.entries(context.data)) {
        resolvedDir = resolvedDir.replaceAll(`{${key}}`, String(value));
      }
      const outputDir = path.resolve(resolvedDir);
      fs.mkdirSync(outputDir, { recursive: true });

      // Filename template. Default: "chunk_{index:04d}.txt".
      const template =
        this.saveToFile.filename_template ?? DEFAULT_CHUNK_FILENAME_TEMPLATE;
      for (const chunk of chunkList) {
        // Replace {index:04d}-style placeholders with zero-padded numbers.
        const filename = formatChunkFilename(template, chunk.index);
        fs.writeFileSync(path.join(outputDir, filename), chunk.text, "utf-8");
      }
      logger.info(`Saved ${chunkList.length} text chunk(s) to ${outputDir}`);
    }

    return new StepResult(
      this.nextStep,
      { [this.outputKey]: chunkList },
      { chunk_count: chunkList.length }
    );
  }
}

// ============================================================
// MergeToEpubAction - merge aligned text into ePub and TXT outputs
// ============================================================

/**
 * Merge aligned translated text and generate output files.
 *
 * Flow:
 *   1. Validate that the upstream concurrent step produced usable results.
 *   2. Read all aligned text files from disk.
 *   3. Merge the text and ask nodepub to create a new ePub file.
 *   4. Also generate a TXT file for plain-text inspection.
 *
 * Path templates in outputDir, outputFilename, and bookTitle support {key}
 * placeholders that are replaced with matching values from context.data.
 *
 * Input: context.data[alignedKey] and/or context.data[`${alignedKey}_stats`].
 * Output: context.data[outputKey] is { output_epub, output_txt }.
 */
export class MergeToEpubAction extends BaseAction {
  // Context key for upstream aligned result data.
  private readonly alignedKey: string;
  // Directory containing aligned text files. Supports context placeholders.
  private readonly alignedDir: string;
  // Output directory. Supports context placeholders.
  private readonly outputDir: string;
  // Output filename, including the .epub suffix. Supports context placeholders.
  private readonly outputFilename: string;
  // ePub title metadata.
  private readonly bookTitle: string;
  // Context key for output file paths.
  private readonly outputKey: string;
  private readonly nextStep: string;

  constructor(
    alignedKey: string = "3_response",
    alignedDir: string = "artifacts/aligned",
    outputDir: string = "results",
    outputFilename: string = "translated.epub",
    bookTitle: string = "Translated Book",
    outputKey: string = "output",
    nextStep: string = "END",
    name: string = "Generate ePub",
    config: Record<string, unknown> = {}
  ) {
    super(name, config);
    this.alignedKey = alignedKey;
    this.alignedDir = alignedDir;
    this.outputDir = outputDir;
    this.outputFilename = outputFilename;
    this.bookTitle = bookTitle;
    this.outputKey = outputKey;
    this.nextStep = nextStep;
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    // Replace {key} placeholders in path templates with context.data values.
    const replaceContextVars = (text: string): string => {
      let result = text;
      for (const [key, value] of Object.entries(context.data)) {
        const placeholder = `{${key}}`;
        if (result.includes(placeholder)) {
          result = result.replace(placeholder, String(value));
        }
      }
      return result;
    };

    const outputDir = replaceContextVars(this.outputDir);
    const outputFilename = replaceContextVars(this.outputFilename);
    const bookTitle = replaceContextVars(this.bookTitle);

    // Validate that the upstream concurrent result has usable output.
    const countSummary = getMergeCountSummary(context.data, this.alignedKey);
    if (!countSummary) {
      throw new Error(`Missing aligned data: ${this.alignedKey}`);
    }

    // Read aligned files from disk.
    const alignedDirResolved = replaceContextVars(this.alignedDir);
    if (!fs.existsSync(alignedDirResolved)) {
      throw new Error(`Aligned file directory does not exist: ${alignedDirResolved}`);
    }

    // Read *.txt files in filename order.
    const alignedFiles = fs
      .readdirSync(alignedDirResolved)
      .filter((f) => f.endsWith(".txt"))
      .sort()
      .map((f) => path.join(alignedDirResolved, f));

    if (alignedFiles.length === 0) {
      throw new Error(
        `No text files found: ${alignedDirResolved}/*.txt`
      );
    }

    const availableCount =
      countSummary.availableCount > 0 ? countSummary.availableCount : alignedFiles.length;
    logger.info(
      `Starting ePub generation... (aligned results ${availableCount} chunk(s): success ${countSummary.successCount}, resumed ${countSummary.skippedCount})`
    );

    // Read each aligned text file.
    const alignedTexts: string[] = [];
    for (const filepath of alignedFiles) {
      const content = fs.readFileSync(filepath, "utf-8").trim();
      if (content) {
        alignedTexts.push(content);
      }
    }

    logger.info(`Read ${alignedTexts.length} aligned file(s)`);

    // Create ePub metadata and output paths.
    const outputPath = path.join(outputDir, outputFilename);
    const outputDirResolved = path.dirname(outputPath);
    fs.mkdirSync(outputDirResolved, { recursive: true });

    // nodepub requires id, title, author, and a non-empty cover path.
    const metadata = {
      id: "translated_book_001",
      title: bookTitle,
      author: "Translated",
      language: "zh",
      cover: path.join(outputDirResolved, ".conductor-epub-cover.png"),
    };

    // Merge all aligned text.
    const mergedContent = alignedTexts.join("\n\n");

    // Convert aligned text into HTML while preserving paragraph boundaries.
    let htmlContent = "<h1>Translated Content</h1>";
    for (const para of mergedContent.split("\n\n")) {
      if (para.trim()) {
        // Escape HTML-sensitive characters before wrapping text in <p> tags.
        const escaped = para
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
        htmlContent += `<p>${escaped}</p>`;
      }
    }

    // nodepub.writeEPUB automatically appends .epub, so pass a basename without it.
    const filenameWithoutExt = path.basename(outputFilename).replace(/\.epub$/i, "");

    let epubPath: string | null = null;
    let epubError: string | undefined;
    try {
      // Create a tiny default cover so nodepub can generate an ePub.
      fs.writeFileSync(
        metadata.cover,
        Buffer.from(DEFAULT_COVER_PNG_BASE64, "base64")
      );
      const doc: NodepubDocument = nodepub.document(metadata);
      doc.addSection("Content", htmlContent);
      await doc.writeEPUB(outputDirResolved, filenameWithoutExt);
      if (fs.existsSync(outputPath)) {
        epubPath = outputPath;
        logger.info(`ePub generated: ${outputPath}`);
      } else {
        epubError = `ePub generation finished without creating ${outputPath}`;
        logger.warn(epubError);
      }
    } catch (e) {
      epubError = e instanceof Error ? e.message : String(e);
      logger.warn(`ePub generation failed (${epubError}); generating TXT only`);
    }

    // Always generate a TXT file for plain-text inspection.
    const txtPath = outputPath.replace(/\.epub$/i, ".txt");
    fs.writeFileSync(txtPath, mergedContent, "utf-8");
    logger.info(`TXT file generated: ${txtPath}`);

    return new StepResult(
      this.nextStep,
      {
        [this.outputKey]: {
          output_epub: epubPath,
          output_txt: txtPath,
        },
      },
      {
        epub_path: epubPath,
        txt_path: txtPath,
        chapter_count: alignedTexts.length,
        epub_created: epubPath !== null,
        ...(epubError ? { epub_error: epubError } : {}),
      }
    );
  }
}

// ============================================================
// ParseTranslationAction - parse translation results
// ============================================================

/**
 * Parse translation results.
 *
 * Extracts translation content from an LLM response that uses ###SEGMENT###
 * markers. This is used as a ConcurrentAction post-processing step.
 *
 * Example LLM response format:
 *   ###SEGMENT1###
 *   First translated segment...
 *   ###SEGMENT2###
 *   Second translated segment...
 *
 * Regex behavior:
 *   Match ###SEGMENT<number>### and capture text up to the next marker or EOF.
 *
 * If the parsed segment count does not match the expectation, the action
 * returns the original response instead of interrupting the workflow.
 */
export class ParseTranslationAction extends BaseAction {
  // Context key for the LLM response text.
  private readonly responseKey: string;
  // Context key for parsed translation text.
  private readonly outputKey: string;
  // Expected number of segments. Usually 1 when translating one chunk at a time.
  private readonly expectedSegments: number;

  constructor(
    responseKey: string = "llm_response",
    outputKey: string = "translated_text",
    expectedSegments: number = 1,
    name: string = "Parse Translation Result",
    config: Record<string, unknown> = {}
  ) {
    super(name, config);
    this.responseKey = responseKey;
    this.outputKey = outputKey;
    this.expectedSegments = expectedSegments;
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    const responseText =
      (context.data[this.responseKey] as string) || "";

    // Parse the ###SEGMENT<number>### format:
    //   ###SEGMENT  - literal prefix
    //   (\d+)       - segment number
    //   ###         - literal suffix
    //   \s*\n       - optional whitespace and a newline after the marker
    //   (.*?)       - non-greedy segment content
    //   (?=...)     - stop before the next marker or at EOF
    //
    // The s flag lets . match newlines.
    const pattern = /###SEGMENT(\d+)###\s*\n(.*?)(?=###SEGMENT\d+###|$)/gs;
    const matches = [...responseText.matchAll(pattern)];

    if (matches.length !== this.expectedSegments) {
      logger.error(
        `Expected ${this.expectedSegments} segment(s), found ${matches.length}`
      );
      // Fallback: preserve the original response to avoid losing translation text.
      return new StepResult(
        "END",
        { [this.outputKey]: responseText },
        { parse_success: false }
      );
    }

    // Extract the first segment because this workflow translates one chunk at a time.
    const translatedText = matches.length > 0
      ? (matches[0]?.[2] ?? responseText).trim()
      : responseText;

    return new StepResult(
      "END",
      { [this.outputKey]: translatedText },
      { parse_success: true }
    );
  }
}
