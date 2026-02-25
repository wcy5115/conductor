/**
 * 统一工具模块
 * 提供文件操作、图片处理、JSON 清洗等基础工具函数
 */

import * as fs from "fs";
import * as path from "path";

// 暂用 console 作为日志占位，待 core/logging.ts 迁移后替换
const logger = {
  info: (msg: string) => console.info(msg),
  error: (msg: string) => console.error(msg),
  debug: (msg: string) => console.debug(msg),
};

// ============================================================
// 文件操作
// ============================================================

/**
 * 保存内容到文件
 *
 * @param filepath 文件路径
 * @param content 要保存的内容
 */
export function saveToFile(filepath: string, content: string): void {
  try {
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(filepath, content, "utf-8");
    logger.info(`内容已成功保存到: ${filepath}`);
    console.log(`[OK] 内容已保存到: ${filepath}`);
  } catch (e) {
    logger.error(`保存文件失败: ${filepath}, 错误: ${e}`);
    throw e;
  }
}

// ============================================================
// 图片处理工具函数
// ============================================================

/**
 * 将图片文件转换为 Base64 编码字符串
 *
 * @param imagePath 图片文件路径
 * @returns Base64 编码的字符串
 * @throws Error 图片文件不存在或编码失败
 */
export function imageToBase64(imagePath: string): string {
  if (!fs.existsSync(imagePath)) {
    throw new Error(`图片文件不存在: ${imagePath}`);
  }

  try {
    const encoded = fs.readFileSync(imagePath).toString("base64");

    if (!encoded) {
      throw new Error("Base64 编码结果为空");
    }

    logger.debug(
      `图片已转换为 Base64: ${path.basename(imagePath)} (${encoded.length} 字符)`,
    );
    return encoded;
  } catch (e) {
    logger.error(`图片 Base64 编码失败: ${imagePath}, 错误: ${e}`);
    throw e;
  }
}

/**
 * 根据文件扩展名获取图片的 MIME 类型
 *
 * @param imagePath 图片文件路径
 * @returns MIME 类型字符串（如 "image/jpeg"）
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
// JSON 验证工具函数
// ============================================================

/**
 * 验证并清理 JSON 内容（只做基础处理）
 *
 * 功能：
 * - 移除 Markdown 代码块标记
 * - 提取 JSON 部分
 * - 转义控制字符（换行符、制表符等）
 * - 修复非法转义（如 LaTeX 符号）
 * - 解析 JSON
 *
 * 注意：此函数只负责基础的 JSON 格式验证和清理，
 * 业务逻辑验证（字段、类型、结构）请使用 validators 模块。
 *
 * @param text LLM 返回的原始文本
 * @returns 解析后的 JSON 数据（object 或 array）
 * @throws Error JSON 格式无效
 */
export function validateAndCleanJson(
  text: string,
): Record<string, unknown> | unknown[] {
  // 1. 类型检查
  if (typeof text !== "string") {
    throw new Error(`输入必须是字符串，实际类型: ${typeof text}`);
  }

  // 2. 清理文本
  text = text.trim();
  if (!text) {
    throw new Error("输入文本为空");
  }

  // 3. 移除 Markdown 代码块
  if (text.includes("```")) {
    const mdMatch = /```(?:json)?\s*\n(.*?)\n```/is.exec(text);
    if (mdMatch) {
      text = mdMatch[1]!;
    } else {
      text = text.replace(/```/g, "");
    }
  }

  // 4. 提取 JSON 部分（查找第一个 { 到最后一个 } 或 [ 到 ]）
  const jsonMatch = /[{[].*[}\]]/s.exec(text);
  if (jsonMatch) {
    text = jsonMatch[0];
  }

  // 5. 预处理：转义控制字符
  text = escapeControlChars(text);

  // 6. 预处理：修复非法转义
  text = fixInvalidEscapes(text);

  // 7. 解析 JSON
  try {
    const data = JSON.parse(text) as Record<string, unknown> | unknown[];
    logger.debug(
      `✓ JSON 格式验证通过，类型: ${Array.isArray(data) ? "array" : "object"}`,
    );
    return data;
  } catch (e) {
    const errorMsg = `无法解析JSON: ${e}\n原始内容前200字符: ${text.slice(0, 200)}...`;
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }
}

// ============================================================
// JSON 预处理辅助函数（内部使用，不导出）
// ============================================================

/**
 * 转义 JSON 字符串中的控制字符（真实的换行符、制表符等）
 *
 * 只在双引号内的字符串中进行转义，不破坏 JSON 结构
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
 * 修复非法转义序列（如 \alpha）
 *
 * 策略：把单独的反斜杠转义成双反斜杠，保留原文内容
 */
function fixInvalidEscapes(jsonText: string): string {
  return jsonText.replace(/(?<!\\)\\(?!["\\/bfnrtu])/g, "\\\\");
}
