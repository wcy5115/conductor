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
// 多模态消息预处理
// ============================================================

/**
 * 消息内容块的类型定义（从 llm_client.ts 导入时使用）
 *
 * 多模态消息（如同时包含文本和图片）的 content 字段是一个数组，
 * 数组中每个元素就是一个 MessageContent。
 *
 * 示例 —— 文本块：  { type: "text", text: "请描述这张图片" }
 * 示例 —— 图片块：  { type: "image_url", image_url: { url: "data:image/png;base64,..." } }
 *
 * [key: string]: unknown 表示允许携带任意额外字段（等价于 Python 的 dict[str, Any]）
 * 这样设计是因为不同 API 提供商可能有自定义字段
 */
interface MessageContent {
  type: string;
  [key: string]: unknown;
}

/**
 * 单条聊天消息的类型定义（从 llm_client.ts 导入时使用）
 *
 * role 表示发言角色，常见值：
 *   - "system":    系统提示词
 *   - "user":      用户输入
 *   - "assistant": AI 的回复
 *
 * content 有两种形态：
 *   - string: 纯文本消息
 *   - MessageContent[]: 多模态消息，包含文本 + 图片等多种内容块
 */
interface MessageForImageProcessing {
  role: string;
  content: string | MessageContent[];
}

/**
 * 预处理消息列表，自动将本地图片路径转换为 Base64 编码
 *
 * 工作流 YAML 中用户可以这样引用本地图片：
 *   { type: "image", path: "./screenshots/page1.jpg" }
 *
 * 但 OpenAI 兼容 API 要求图片以 Base64 Data URL 传递，格式为：
 *   { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQ..." } }
 *
 * 本函数遍历所有消息，找到 type="image" 的内容块，读取文件并转换格式。
 * 纯文本消息（content 是 string）不做任何处理，原样保留。
 *
 * @param messages 原始消息列表
 * @returns 处理后的消息列表（新数组，不修改原始数据）
 */
export function processMessagesWithImages(messages: MessageForImageProcessing[]): MessageForImageProcessing[] {
  // 创建新数组存放处理后的消息，避免修改原始输入（不可变数据原则）
  const processedMessages: MessageForImageProcessing[] = [];

  for (const msg of messages) {
    // 浅拷贝消息对象，后续可能替换 content 字段
    // { ...msg } 是展开运算符，创建一个新对象，复制 msg 的所有属性
    const processedMsg = { ...msg };

    // 只有 content 为数组时才需要处理（数组 = 多模态消息，可能包含图片）
    // 纯文本消息（string）不可能包含图片路径，直接跳过
    if (Array.isArray(msg.content)) {
      const processedContent: MessageContent[] = [];

      for (const item of msg.content) {
        // 防御性检查：确保元素是对象且非 null
        if (typeof item === "object" && item !== null) {
          // 检测图片路径标记：type 为 "image" 且携带 path 字段
          // 这是本项目自定义的格式，不是 OpenAI API 标准
          if (item.type === "image" && "path" in item) {
            const imagePath = item.path as string;

            // 第一步：检查图片文件是否存在
            if (!fs.existsSync(imagePath)) {
              logger.error(`图片文件不存在，跳过: ${imagePath}`);
              // continue 跳过当前图片，不中断其他内容的处理
              continue;
            }

            // 第二步：读取文件并转换为 Base64 Data URL
            try {
              // imageToBase64() 读取二进制文件内容，返回 Base64 编码字符串
              const base64Data = imageToBase64(imagePath);
              // getImageMimeType() 根据扩展名返回 MIME 类型
              // 例如：.jpg → "image/jpeg"，.png → "image/png"
              const mimeType = getImageMimeType(imagePath);

              // 构建 OpenAI 兼容的图片内容块
              // Data URL 格式：data:<MIME类型>;base64,<编码数据>
              // detail: "high" 表示使用高分辨率模式解析图片（消耗更多 token 但更清晰）
              const processedItem: MessageContent = {
                type: "image_url",
                image_url: {
                  url: `data:${mimeType};base64,${base64Data}`,
                  detail: "high",
                },
              };
              processedContent.push(processedItem);
              logger.debug(`图片已转换: ${imagePath}`);
            } catch (e) {
              logger.error(`图片转换失败: ${imagePath}, 错误: ${e}`);
              // 转换失败时跳过该图片，不影响其余内容
              continue;
            }
          } else {
            // 非图片类型的内容块（如文本块），原样保留
            processedContent.push(item as MessageContent);
          }
        } else {
          // 非对象类型的元素（理论上不应出现），原样保留以保证健壮性
          processedContent.push(item as MessageContent);
        }
      }

      // 用处理后的内容块数组替换原始 content
      processedMsg.content = processedContent;
    }

    processedMessages.push(processedMsg);
  }

  return processedMessages;
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
