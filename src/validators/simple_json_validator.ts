/**
 * Simple JSON validator
 *
 * Validates only the most basic field presence, not the exact content shape.
 *
 * Suitable for:
 * - Simple JSON extraction workflows
 * - Cases that only need to ensure basic fields exist
 * - Content that may have any shape, such as a string or object
 * - Cases that do not need paragraph-number validation or similar details
 *
 * Validation rules:
 * 1. Data must be an object
 * 2. Data must contain the "页码" field
 * 3. Data must contain the "内容" field
 * 4. Field types and content shape are not validated
 */

import { BaseValidator } from "./base.js";

function formatValuePreview(value: unknown, maxLength = 200): string {
  let repr: string;

  try {
    const json = JSON.stringify(value);
    repr = json === undefined ? String(value) : json;
  } catch {
    repr = String(value);
  }

  return repr.length > maxLength ? repr.slice(0, maxLength) + "..." : repr;
}

/**
 * Simple JSON validator
 *
 * Validates only the basic structure, not detailed content.
 *
 * Valid examples. All of these pass validation:
 *   {"页码": "1", "内容": "Complete text content"}
 *   {"页码": "1", "内容": {"paragraph1": "...", "paragraph2": "..."}}
 *   {"页码": "kong", "内容": "kong"}
 *   {"页码": "1", "内容": {}}
 *
 * Invalid examples:
 *   {"页码": "1"}          // Missing "内容"
 *   {"内容": "..."}        // Missing "页码"
 *   ["页码", "内容"]       // Array instead of object
 */
export class SimpleJSONValidator extends BaseValidator {
  get name(): string {
    return "simple_json";
  }

  validate(data: unknown): boolean {
    // Check 1: data must be an object.
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      const truncated = formatValuePreview(data);
      throw new Error(
        `❌ Data must be an object\n` +
          `\n` +
          `[Actual type]\n` +
          `  ${Array.isArray(data) ? "array" : data === null ? "null" : typeof data}\n` +
          `\n` +
          `[Actual data]\n` +
          `  ${truncated}\n` +
          `\n` +
          `[Expected format]\n` +
          `  {"页码": "...", "内容": "..."}\n` +
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
          `${JSON.stringify(obj, null, 2)}\n` +
          `\n` +
          `[Expected format]\n` +
          `  {"页码": "recognized page number", "内容": "..."}\n` +
          `\n` +
          `[Fix suggestion]\n` +
          `  Add the "页码" field to the JSON object`
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
          `${JSON.stringify(obj, null, 2)}\n` +
          `\n` +
          `[Expected format]\n` +
          `  {"页码": "...", "内容": "text content or paragraph object"}\n` +
          `\n` +
          `[Fix suggestion]\n` +
          `  Add the "内容" field to the JSON object`
      );
    }

    // Validation passed.
    const contentType = Array.isArray(obj["内容"]) ? "array" : typeof obj["内容"];
    console.debug(
      `✓ Simple JSON validation passed (page: ${obj["页码"]}, content type: ${contentType})`
    );
    return true;
  }
}
