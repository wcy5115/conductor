/**
 * utils.ts 单元测试
 *
 * 测试 src/utils.ts 中的纯工具函数：
 * - getImageMimeType()：根据扩展名返回 MIME 类型
 * - validateAndCleanJson()：清理并解析 LLM 返回的 JSON 文本
 * - saveToFile()：保存内容到文件
 * - imageToBase64()：将图片文件转换为 Base64 编码
 */

// vitest 提供的测试框架 API：describe 分组、it 单个用例、expect 断言
import { describe, it, expect, afterAll } from "vitest";
// Node.js 文件系统和路径模块，用于创建/清理临时测试文件
import * as fs from "fs";
import * as path from "path";
// 被测函数
import {
  getImageMimeType,
  validateAndCleanJson,
  saveToFile,
  imageToBase64,
} from "../src/utils";

// 临时测试目录，所有测试产生的文件都放在这里，测试结束后统一清理
const TEST_TMP_DIR = path.join(__dirname, "_tmp_test_utils");

// 全部测试跑完后，删除临时目录
afterAll(() => {
  if (fs.existsSync(TEST_TMP_DIR)) {
    fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true });
  }
});

// ============================================================
// getImageMimeType() 测试
// ============================================================
describe("getImageMimeType", () => {
  it("常见扩展名返回正确 MIME 类型", () => {
    expect(getImageMimeType("photo.png")).toBe("image/png");
    expect(getImageMimeType("photo.jpg")).toBe("image/jpeg");
    expect(getImageMimeType("photo.jpeg")).toBe("image/jpeg");
    expect(getImageMimeType("photo.webp")).toBe("image/webp");
    expect(getImageMimeType("photo.bmp")).toBe("image/bmp");
    expect(getImageMimeType("photo.gif")).toBe("image/gif");
  });

  it("大小写不敏感", () => {
    expect(getImageMimeType("photo.PNG")).toBe("image/png");
    expect(getImageMimeType("photo.JPG")).toBe("image/jpeg");
    expect(getImageMimeType("photo.Webp")).toBe("image/webp");
  });

  it("未知扩展名默认返回 image/jpeg", () => {
    expect(getImageMimeType("file.tiff")).toBe("image/jpeg");
    expect(getImageMimeType("file.svg")).toBe("image/jpeg");
    expect(getImageMimeType("file")).toBe("image/jpeg");
  });
});

// ============================================================
// validateAndCleanJson() 测试
// ============================================================
describe("validateAndCleanJson", () => {
  it("解析正常 JSON 字符串", () => {
    const result = validateAndCleanJson('{"name": "test", "value": 42}');
    expect(result).toEqual({ name: "test", value: 42 });
  });

  it("解析 JSON 数组", () => {
    const result = validateAndCleanJson('[1, 2, 3]');
    expect(result).toEqual([1, 2, 3]);
  });

  it("提取 markdown 代码块中的 JSON", () => {
    const input = '```json\n{"key": "value"}\n```';
    expect(validateAndCleanJson(input)).toEqual({ key: "value" });
  });

  it("提取前后有垃圾文本的 JSON", () => {
    const input = '这是一些垃圾文本 {"key": "value"} 后面也有垃圾';
    expect(validateAndCleanJson(input)).toEqual({ key: "value" });
  });

  it("处理包含控制字符的 JSON", () => {
    // 字符串值内部含有真实的换行符和制表符
    const input = '{"text": "line1\nline2\ttab"}';
    const result = validateAndCleanJson(input) as Record<string, unknown>;
    expect(result.text).toBe("line1\nline2\ttab");
  });

  it("空字符串抛异常", () => {
    expect(() => validateAndCleanJson("")).toThrow("输入文本为空");
    expect(() => validateAndCleanJson("   ")).toThrow("输入文本为空");
  });

  it("无效 JSON 抛异常", () => {
    expect(() => validateAndCleanJson("{invalid}")).toThrow();
    expect(() => validateAndCleanJson("not json at all")).toThrow();
  });
});

// ============================================================
// saveToFile() 测试
// ============================================================
describe("saveToFile", () => {
  it("写入文件并验证内容", () => {
    const filePath = path.join(TEST_TMP_DIR, "test_save.txt");
    saveToFile(filePath, "hello world");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("hello world");
  });

  it("自动创建嵌套目录", () => {
    const filePath = path.join(TEST_TMP_DIR, "nested", "deep", "file.txt");
    saveToFile(filePath, "nested content");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("nested content");
  });
});

// ============================================================
// imageToBase64() 测试
// ============================================================
describe("imageToBase64", () => {
  it("不存在的文件路径抛异常", () => {
    expect(() => imageToBase64("/nonexistent/path/image.png")).toThrow(
      "图片文件不存在",
    );
  });

  it("正常读取文件并返回 Base64 字符串", () => {
    // 创建一个临时文件，写入已知内容
    const filePath = path.join(TEST_TMP_DIR, "test_image.bin");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = Buffer.from("fake image data for testing");
    fs.writeFileSync(filePath, content);

    const result = imageToBase64(filePath);
    // 验证：Base64 解码后应与原始内容一致
    expect(Buffer.from(result, "base64").toString()).toBe(
      "fake image data for testing",
    );
  });
});
