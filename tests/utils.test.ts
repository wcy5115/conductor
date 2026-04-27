/**
 * Unit tests for src/utils.ts.
 *
 * These tests cover pure utility helpers plus the image preprocessing branch
 * used before multimodal LLM requests.
 */

import { describe, it, expect, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  getImageMimeType,
  validateAndCleanJson,
  saveToFile,
  imageToBase64,
  processMessagesWithImages,
} from "../src/utils";

const TEST_TMP_DIR = path.join(__dirname, "_tmp_test_utils");

afterAll(() => {
  if (fs.existsSync(TEST_TMP_DIR)) {
    fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true });
  }
});

describe("getImageMimeType", () => {
  it("returns the correct MIME type for common extensions", () => {
    expect(getImageMimeType("photo.png")).toBe("image/png");
    expect(getImageMimeType("photo.jpg")).toBe("image/jpeg");
    expect(getImageMimeType("photo.jpeg")).toBe("image/jpeg");
    expect(getImageMimeType("photo.webp")).toBe("image/webp");
    expect(getImageMimeType("photo.bmp")).toBe("image/bmp");
    expect(getImageMimeType("photo.gif")).toBe("image/gif");
  });

  it("is case-insensitive", () => {
    expect(getImageMimeType("photo.PNG")).toBe("image/png");
    expect(getImageMimeType("photo.JPG")).toBe("image/jpeg");
    expect(getImageMimeType("photo.Webp")).toBe("image/webp");
  });

  it("defaults unknown extensions to image/jpeg", () => {
    expect(getImageMimeType("file.tiff")).toBe("image/jpeg");
    expect(getImageMimeType("file.svg")).toBe("image/jpeg");
    expect(getImageMimeType("file")).toBe("image/jpeg");
  });
});

describe("validateAndCleanJson", () => {
  it("parses a normal JSON object string", () => {
    const result = validateAndCleanJson('{"name": "test", "value": 42}');
    expect(result).toEqual({ name: "test", value: 42 });
  });

  it("parses a JSON array", () => {
    const result = validateAndCleanJson("[1, 2, 3]");
    expect(result).toEqual([1, 2, 3]);
  });

  it("extracts JSON from a markdown code block", () => {
    const input = '```json\n{"key": "value"}\n```';
    expect(validateAndCleanJson(input)).toEqual({ key: "value" });
  });

  it("extracts JSON surrounded by extra text", () => {
    const input = 'prefix text {"key": "value"} suffix text';
    expect(validateAndCleanJson(input)).toEqual({ key: "value" });
  });

  it("handles control characters inside JSON strings", () => {
    const input = '{"text": "line1\nline2\ttab"}';
    const result = validateAndCleanJson(input) as Record<string, unknown>;
    expect(result.text).toBe("line1\nline2\ttab");
  });

  it("throws on empty input", () => {
    expect(() => validateAndCleanJson("")).toThrow("Input text is empty");
    expect(() => validateAndCleanJson("   ")).toThrow("Input text is empty");
  });

  it("throws on invalid JSON", () => {
    expect(() => validateAndCleanJson("{invalid}")).toThrow();
    expect(() => validateAndCleanJson("not json at all")).toThrow();
  });
});

describe("saveToFile", () => {
  it("writes a file and preserves the content", () => {
    const filePath = path.join(TEST_TMP_DIR, "test_save.txt");
    saveToFile(filePath, "hello world");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("hello world");
  });

  it("creates nested parent directories", () => {
    const filePath = path.join(TEST_TMP_DIR, "nested", "deep", "file.txt");
    saveToFile(filePath, "nested content");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("nested content");
  });
});

describe("imageToBase64", () => {
  it("throws when the file path does not exist", () => {
    expect(() => imageToBase64("/nonexistent/path/image.png")).toThrow(
      "Image file does not exist",
    );
  });

  it("reads a file and returns a Base64 string", () => {
    const filePath = path.join(TEST_TMP_DIR, "test_image.bin");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = Buffer.from("fake image data for testing");
    fs.writeFileSync(filePath, content);

    const result = imageToBase64(filePath);
    expect(Buffer.from(result, "base64").toString()).toBe(
      "fake image data for testing",
    );
  });
});

describe("processMessagesWithImages", () => {
  it("converts local image blocks to Base64 Data URL blocks", () => {
    const imagePath = path.join(TEST_TMP_DIR, "message_image.png");
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.writeFileSync(imagePath, Buffer.from("fake png bytes"));

    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this image" },
          { type: "image", path: imagePath },
        ],
      },
    ];

    const result = processMessagesWithImages(messages);
    const content = result[0]!.content as Array<Record<string, unknown>>;
    const imageBlock = content[1] as {
      type: string;
      image_url: { url: string; detail: string };
    };

    expect(content[0]).toEqual({ type: "text", text: "Describe this image" });
    expect(imageBlock.type).toBe("image_url");
    expect(imageBlock.image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(imageBlock.image_url.detail).toBe("high");
    expect(messages[0]!.content[1]).toEqual({ type: "image", path: imagePath });
  });

  it("throws when a requested local image is missing", () => {
    const missingPath = path.join(TEST_TMP_DIR, "missing.png");

    expect(() =>
      processMessagesWithImages([
        {
          role: "user",
          content: [{ type: "image", path: missingPath }],
        },
      ]),
    ).toThrow(`Image file does not exist: ${missingPath}`);
  });

  it("throws when a requested local image cannot be converted", () => {
    const directoryPath = path.join(TEST_TMP_DIR, "image-directory.png");
    fs.mkdirSync(directoryPath, { recursive: true });

    expect(() =>
      processMessagesWithImages([
        {
          role: "user",
          content: [{ type: "image", path: directoryPath }],
        },
      ]),
    ).toThrow(`Failed to convert image: ${directoryPath}`);
  });
});
