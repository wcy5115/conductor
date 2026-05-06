/**
 * PDF page JSON validator
 *
 * Validates whether JSON data extracted from a PDF page matches the expected structure.
 *
 * Suitable for:
 * - Workflows that extract text by natural paragraph
 * - Cases that need paragraph-number continuity checks
 * - Strict data-quality requirements
 *
 * Validation rules:
 * 1. Data must be an object
 * 2. Data must contain the "页码" and "内容" fields
 * 3. "页码" must be a string
 * 4. "内容" must be either the string "kong" (empty page) or a paragraph object
 * 5. Paragraph-object keys must be "段落1", "段落2", "段落3"... with continuous numbering
 * 6. Numbering must start from 1
 * 7. Numbers cannot be skipped
 *
 * Design:
 * - Layered validation: check from the outer structure inward
 * - Detailed errors: every error includes context
 * - Defensive handling for edge cases
 */

// BaseValidator is the abstract base class for all validators.
import { BaseValidator } from "./base.js";
import {
  terminalInternalDebug,
  terminalInternalWarn,
} from "../core/terminal_reporter.js";

const console = {
  debug: terminalInternalDebug,
  warn: terminalInternalWarn,
};

function formatValuePreview(
  value: unknown,
  maxLength = 200,
  space?: number
): string {
  let repr: string;

  try {
    const json = JSON.stringify(value, null, space);
    repr = json === undefined ? String(value) : json;
  } catch {
    repr = String(value);
  }

  return repr.length > maxLength ? repr.slice(0, maxLength) + "..." : repr;
}

/**
 * PDF page JSON validator
 *
 * Validates structured data extracted from a PDF page and ensures paragraph numbers are continuous.
 *
 * Validation layers:
 * - Layer 1: outer structure validation (data type and required fields)
 * - Layer 2: content type validation ("kong" or object)
 * - Layer 3: paragraph-number continuity validation
 *
 * Valid examples:
 *   // Normal page with multiple paragraphs
 *   { "页码": "1", "内容": { "段落1": "First paragraph", "段落2": "Second paragraph" } }
 *
 *   // Normal page with one paragraph
 *   { "页码": "5", "内容": { "段落1": "Only paragraph" } }
 *
 *   // Roman-numeral page number
 *   { "页码": "iii", "内容": { "段落1": "Preface content" } }
 *
 *   // Empty page
 *   { "页码": "kong", "内容": "kong" }
 *
 * Invalid examples:
 *   { "页码": "1" }                                       // Missing "内容"
 *   { "页码": "1", "内容": { "段落1": "...", "段落3": "..." } }  // Skipped paragraph number
 *   { "页码": "1", "内容": { "paragraph1": "..." } }     // Wrong key format
 */
export class PDFPageValidator extends BaseValidator {
  /**
   * Validator name used in YAML configuration.
   *
   * `validator: "pdf_page"` in YAML matches this validator.
   */
  get name(): string {
    return "pdf_page";
  }

  /**
   * Validate a PDF page JSON structure.
   *
   * Flow:
   * 1. Validate the outer structure (must be an object with required fields)
   * 2. Validate the content type ("kong" or object)
   * 3. If content is an object, validate paragraph-number continuity
   *
   * @param data Parsed JSON data
   * @returns true when validation passes
   * @throws Error when validation fails, with detailed context
   */
  validate(data: unknown): boolean {
    // Layer 1: validate the outer structure, required fields, and field types.
    this._validateStructure(data);

    // After _validateStructure, data is an object with "页码" and "内容".
    const obj = data as Record<string, unknown>;
    const content = obj["内容"];

    // Layer 2: "kong" means an empty page and passes directly.
    if (content === "kong") {
      console.debug(`✓ PDF page validation passed (empty page, page: ${obj["页码"]})`);
      return true;
    }

    // Layer 3: validate paragraph key format and number continuity.
    this._validateParagraphs(content, obj);

    // Count paragraphs for the debug log.
    const paragraphCount = Object.keys(
      content as Record<string, unknown>
    ).length;
    console.debug(
      `✓ PDF page validation passed (page: ${obj["页码"]}, ${paragraphCount} paragraph(s))`
    );
    return true;
  }

  /**
   * Validate the outer structure.
   *
   * Checks:
   * 1. Data must be an object (not an array, null, or primitive)
   * 2. The "页码" field is required
   * 3. The "内容" field is required
   * 4. The "页码" field must be a string
   *
   * @param data Data to validate
   * @throws Error when the structure is invalid
   */
  private _validateStructure(data: unknown): void {
    // Check 1: data must be an object.
    // typeof null === "object", so null must be excluded explicitly.
    // Arrays also have typeof "object", so exclude them with Array.isArray.
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      // Get a clearer actual type name for null and arrays.
      const actualType = Array.isArray(data)
        ? "array"
        : data === null
          ? "null"
          : typeof data;
      // Truncate long data so error messages stay readable.
      const truncated = formatValuePreview(data);
      throw new Error(
        `❌ Data must be an object\n` +
          `\n` +
          `[Actual type]\n` +
          `  ${actualType}\n` +
          `\n` +
          `[Actual data]\n` +
          `  ${truncated}\n` +
          `\n` +
          `[Expected format]\n` +
          `  {"页码": "1", "内容": {"段落1": "..."}}\n` +
          `\n` +
          `[Fix suggestion]\n` +
          `  Make sure the LLM returns a JSON object with braces {}`
      );
    }

    const obj = data as Record<string, unknown>;

    // Check 2: the "页码" field is required.
    if (!("页码" in obj)) {
      throw new Error(
        `❌ Missing required field: 页码\n` +
          `\n` +
          `[Actual fields]\n` +
          `  ${JSON.stringify(Object.keys(obj))}\n` +
          `\n` +
          `[Actual data]\n` +
          `${formatValuePreview(obj, Number.POSITIVE_INFINITY, 2)}\n` +
          `\n` +
          `[Expected format]\n` +
          `  {"页码": "1", "内容": {...}}\n` +
          `\n` +
          `[Fix suggestion]\n` +
          `  Add the "页码" field`
      );
    }

    // Check 3: the "内容" field is required.
    if (!("内容" in obj)) {
      throw new Error(
        `❌ Missing required field: 内容\n` +
          `\n` +
          `[Actual fields]\n` +
          `  ${JSON.stringify(Object.keys(obj))}\n` +
          `\n` +
          `[Actual data]\n` +
          `${formatValuePreview(obj, Number.POSITIVE_INFINITY, 2)}\n` +
          `\n` +
          `[Expected format]\n` +
          `  {"页码": "1", "内容": {"段落1": "..."}}\n` +
          `  Or, for an empty page: {"页码": "kong", "内容": "kong"}\n` +
          `\n` +
          `[Fix suggestion]\n` +
          `  Add the "内容" field`
      );
    }

    // Check 4: "页码" must be a string.
    // Page numbers use strings because they may be Roman numerals such as "iii" or special markers such as "kong".
    if (typeof obj["页码"] !== "string") {
      throw new Error(
        `❌ Field "页码" must be a string\n` +
          `\n` +
          `[Actual type]\n` +
          `  ${typeof obj["页码"]}\n` +
          `\n` +
          `[Actual value]\n` +
          `  ${formatValuePreview(obj["页码"])}\n` +
          `\n` +
          `[Fix suggestion]\n` +
          `  Change the page number to a string, such as "1" instead of 1`
      );
    }
  }

  /**
   * Validate the paragraph structure.
   *
   * Checks:
   * 1. Content must be an object unless it is "kong"
   * 2. Paragraph keys must be "段落1", "段落2", "段落3", ...
   * 3. Numbering must start from 1
   * 4. Numbering must be continuous, with no skipped numbers
   *
   * @param content The "内容" field, usually a paragraph object
   * @param fullData Complete data, shown as context in error reports
   * @throws Error when the paragraph structure is invalid
   */
  private _validateParagraphs(
    content: unknown,
    fullData: Record<string, unknown>
  ): void {
    // When content is not "kong", it must be an object such as { "段落1": ..., "段落2": ... }.
    if (typeof content !== "object" || content === null || Array.isArray(content)) {
      const truncated = formatValuePreview(content, 100);
      throw new Error(
        `❌ Field "内容" must be the string "kong" or an object\n` +
          `\n` +
          `[Actual type]\n` +
          `  ${Array.isArray(content) ? "array" : content === null ? "null" : typeof content}\n` +
          `\n` +
          `[Actual value]\n` +
          `  ${truncated}\n` +
          `\n` +
          `[Allowed formats]\n` +
          `  1. Empty page: "kong"\n` +
          `  2. Page with content: {"段落1": "...", "段落2": "..."}\n` +
          `\n` +
          `[Full data]\n` +
          `${formatValuePreview(fullData, Number.POSITIVE_INFINITY, 2)}`
      );
    }

    const contentObj = content as Record<string, unknown>;
    const keys = Object.keys(contentObj);

    // Empty pages should use "kong" instead of {}, but this is only a warning.
    if (keys.length === 0) {
      console.warn(
        "⚠️ Content is an empty object\n" +
          "   Suggestion: empty pages should use the string 'kong' instead of {}"
      );
      return;
    }

    // Check paragraph keys one by one: expected keys are "段落1", "段落2", "段落3", ...
    // The loop index starts at 0, but paragraph numbers start at 1.
    for (let index = 0; index < keys.length; index++) {
      const expectedKey = `段落${index + 1}`;
      const actualKey = keys[index]!;

      if (actualKey !== expectedKey) {
        // Build a detailed error report for mismatched paragraph numbers.
        const errorLines: string[] = [
          "❌ Paragraph numbering is not continuous or has the wrong format.",
          "",
          "[Error location]",
          `  Paragraph ${index + 1}`,
          "",
          "[Expected]",
          `  Key: '${expectedKey}'`,
          "",
          "[Actual]",
          `  Key: '${actualKey}'`,
          "",
          "[All paragraph keys]",
          `  ${JSON.stringify(keys)}`,
          "",
          "[Numbering rules]",
          "  1. Start from '段落1'",
          "  2. Increase one by one: 段落1 -> 段落2 -> 段落3 ...",
          "  3. Do not skip numbers, such as 段落1 -> 段落3",
          "  4. Use Arabic numerals",
          "  5. Do not duplicate numbers",
          "",
          "[Fix suggestion]",
        ];

        // Give a more precise suggestion based on the key-format error.
        if (actualKey.startsWith("段落")) {
          // The key starts with "段落", so the prefix is correct but the number is wrong.
          const numStr = actualKey.slice(2);
          const num = parseInt(numStr, 10);
          if (!isNaN(num)) {
            if (num > index + 1) {
              errorLines.push(`  Missing '${expectedKey}', please add it`);
            } else if (num < index + 1) {
              errorLines.push(`  '${actualKey}' is duplicated or out of order`);
            } else {
              errorLines.push(`  Check whether the paragraph number is correct`);
            }
          } else {
            errorLines.push(
              `  The paragraph number must be numeric, not '${numStr}'`
            );
          }
        } else {
          errorLines.push(
            `  The key must use the '段落N' format, not '${actualKey}'`
          );
        }

        // Include full data for debugging.
        errorLines.push("", "[Full data]");
        errorLines.push(
          formatValuePreview(fullData, Number.POSITIVE_INFINITY, 2)
        );

        throw new Error(errorLines.join("\n"));
      }
    }
  }
}
