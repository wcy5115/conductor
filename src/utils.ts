/**
 * Shared utility module.
 * Provides basic helpers for file operations, image handling, and JSON cleanup.
 */

import * as fs from "fs";
import * as path from "path";

// Temporary console logger until this module is migrated to core/logging.ts.
const logger = {
  info: (msg: string) => console.info(msg),
  error: (msg: string) => console.error(msg),
  debug: (msg: string) => console.debug(msg),
};

// ============================================================
// File Operations
// ============================================================

/**
 * Save content to a file.
 *
 * @param filepath File path.
 * @param content Content to save.
 */
export function saveToFile(filepath: string, content: string): void {
  try {
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(filepath, content, "utf-8");
    logger.info(`Content saved successfully to: ${filepath}`);
    console.log(`[OK] Content saved to: ${filepath}`);
  } catch (e) {
    logger.error(`Failed to save file: ${filepath}, error: ${e}`);
    throw e;
  }
}

// ============================================================
// Image Helpers
// ============================================================

/**
 * Convert an image file to a Base64-encoded string.
 *
 * @param imagePath Image file path.
 * @returns Base64-encoded string.
 * @throws Error when the image file is missing or cannot be encoded.
 */
export function imageToBase64(imagePath: string): string {
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image file does not exist: ${imagePath}`);
  }

  try {
    const encoded = fs.readFileSync(imagePath).toString("base64");

    if (!encoded) {
      throw new Error("Base64 encoded result is empty");
    }

    logger.debug(
      `Image converted to Base64: ${path.basename(imagePath)} (${encoded.length} characters)`,
    );
    return encoded;
  } catch (e) {
    logger.error(`Image Base64 encoding failed: ${imagePath}, error: ${e}`);
    throw e;
  }
}

/**
 * Get an image MIME type from its file extension.
 *
 * @param imagePath Image file path.
 * @returns MIME type string, for example "image/jpeg".
 */
export function getImageMimeType(imagePath: string): string {
  const suffix = path.extname(imagePath).toLowerCase();

  const mimeTypes: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".gif": "image/gif",
  };

  return mimeTypes[suffix] ?? "image/jpeg";
}

// ============================================================
// Multimodal Message Preprocessing
// ============================================================

/**
 * Message content block type used with llm_client.ts.
 *
 * In multimodal messages, content is an array where each item is a
 * MessageContent block.
 *
 * Text block example:  { type: "text", text: "Describe this image" }
 * Image block example: { type: "image_url", image_url: { url: "data:image/png;base64,..." } }
 *
 * The index signature allows provider-specific extra fields.
 */
interface MessageContent {
  type: string;
  [key: string]: unknown;
}

/**
 * Single chat message type used with llm_client.ts.
 *
 * role is the speaker role. Common values are:
 *   - "system":    system instructions
 *   - "user":      user input
 *   - "assistant": assistant response
 *
 * content has two forms:
 *   - string: plain text message
 *   - MessageContent[]: multimodal message with text, images, or other blocks
 */
interface MessageForImageProcessing {
  role: string;
  content: string | MessageContent[];
}

/**
 * Preprocess messages by converting local image paths to Base64 Data URLs.
 *
 * Workflow YAML can reference local images like this:
 *   { type: "image", path: "./screenshots/page1.jpg" }
 *
 * OpenAI-compatible APIs expect images to be sent as Base64 Data URLs:
 *   { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQ..." } }
 *
 * This function scans all messages, finds content blocks with type="image",
 * reads those local files, and converts them into API-compatible image blocks.
 * Plain text messages are returned unchanged.
 *
 * @param messages Original messages.
 * @returns Processed messages as a new array without mutating the input.
 */
export function processMessagesWithImages(
  messages: MessageForImageProcessing[],
): MessageForImageProcessing[] {
  // Keep the input immutable by writing processed messages into a new array.
  const processedMessages: MessageForImageProcessing[] = [];

  for (const msg of messages) {
    // Shallow-copy the message because content may be replaced below.
    const processedMsg = { ...msg };

    // Only array content can contain local image blocks.
    if (Array.isArray(msg.content)) {
      const processedContent: MessageContent[] = [];

      for (const item of msg.content) {
        // Defensive check: content blocks should be objects, but preserve
        // unexpected values so callers can handle provider-specific shapes.
        if (typeof item === "object" && item !== null) {
          // Project-specific local image marker, not the API wire format.
          if (item.type === "image" && "path" in item) {
            const imagePath = item.path as string;

            if (!fs.existsSync(imagePath)) {
              throw new Error(`Image file does not exist: ${imagePath}`);
            }

            try {
              const base64Data = imageToBase64(imagePath);
              const mimeType = getImageMimeType(imagePath);

              // Build the OpenAI-compatible image block.
              const processedItem: MessageContent = {
                type: "image_url",
                image_url: {
                  url: `data:${mimeType};base64,${base64Data}`,
                  detail: "high",
                },
              };
              processedContent.push(processedItem);
              logger.debug(`Image converted: ${imagePath}`);
            } catch (e) {
              const message = e instanceof Error ? e.message : String(e);
              throw new Error(`Failed to convert image: ${imagePath}, error: ${message}`);
            }
          } else {
            // Preserve non-image content blocks, such as text blocks.
            processedContent.push(item as MessageContent);
          }
        } else {
          // Preserve unexpected non-object values for compatibility.
          processedContent.push(item as MessageContent);
        }
      }

      // Replace the original content array with the processed content blocks.
      processedMsg.content = processedContent;
    }

    processedMessages.push(processedMsg);
  }

  return processedMessages;
}

// ============================================================
// JSON Validation Helpers
// ============================================================

/**
 * Validate and clean JSON content with basic preprocessing only.
 *
 * Behavior:
 * - Remove Markdown code fences.
 * - Extract the JSON portion.
 * - Escape control characters, such as real newlines and tabs.
 * - Fix invalid escape sequences, such as LaTeX commands.
 * - Parse JSON.
 *
 * Note: this function only handles basic JSON format cleanup. Use the
 * validators module for business validation such as fields, types, and shape.
 *
 * @param text Raw text returned by an LLM.
 * @returns Parsed JSON data as an object or array.
 * @throws Error when the JSON format is invalid.
 */
export function validateAndCleanJson(
  text: string,
): Record<string, unknown> | unknown[] {
  // 1. Type check.
  if (typeof text !== "string") {
    throw new Error(`Input must be a string, actual type: ${typeof text}`);
  }

  // 2. Trim input text.
  text = text.trim();
  if (!text) {
    throw new Error("Input text is empty");
  }

  // 3. Remove Markdown code fences.
  if (text.includes("```")) {
    const mdMatch = /```(?:json)?\s*\n(.*?)\n```/is.exec(text);
    if (mdMatch) {
      text = mdMatch[1]!;
    } else {
      text = text.replace(/```/g, "");
    }
  }

  // 4. Extract the JSON portion.
  const jsonMatch = /[{[].*[}\]]/s.exec(text);
  if (jsonMatch) {
    text = jsonMatch[0];
  }

  // 5. Escape control characters.
  text = escapeControlChars(text);

  // 6. Fix invalid escape sequences.
  text = fixInvalidEscapes(text);

  // 7. Parse JSON.
  try {
    const data = JSON.parse(text) as Record<string, unknown> | unknown[];
    logger.debug(
      `JSON format validation passed, type: ${Array.isArray(data) ? "array" : "object"}`,
    );
    return data;
  } catch (e) {
    const errorMsg = `Unable to parse JSON: ${e}\nFirst 200 characters of raw content: ${text.slice(0, 200)}...`;
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }
}

// ============================================================
// JSON Preprocessing Helpers
// ============================================================

/**
 * Escape control characters inside JSON strings.
 *
 * Escapes only inside double-quoted strings so the JSON structure is preserved.
 */
function escapeControlChars(jsonText: string): string {
  const result: string[] = [];
  let inString = false;
  let prevBackslash = false;

  for (const char of jsonText) {
    if (char === '"' && !prevBackslash) {
      inString = !inString;
      result.push(char);
      prevBackslash = false;
      continue;
    }

    if (char === "\\" && !prevBackslash) {
      prevBackslash = true;
      result.push(char);
      continue;
    }

    if (inString && char.codePointAt(0)! < 0x20) {
      if (char === "\n") result.push("\\n");
      else if (char === "\r") result.push("\\r");
      else if (char === "\t") result.push("\\t");
      else if (char === "\b") result.push("\\b");
      else if (char === "\f") result.push("\\f");
      else
        result.push(`\\u${char.codePointAt(0)!.toString(16).padStart(4, "0")}`);
    } else {
      result.push(char);
    }

    prevBackslash = false;
  }

  return result.join("");
}

/**
 * Fix invalid escape sequences, such as \alpha.
 *
 * Strategy: escape single backslashes as double backslashes while preserving
 * the original text.
 */
function fixInvalidEscapes(jsonText: string): string {
  return jsonText.replace(/(?<!\\)\\(?!["\\/bfnrtu])/g, "\\\\");
}
