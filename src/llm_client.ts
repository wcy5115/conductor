/**
 * LLM客户端模块
 * 统一的API调用接口，支持OpenAI兼容的API
 * 支持自动将图片路径转换为Base64编码
 */

import * as fs from "fs";
import { imageToBase64, getImageMimeType } from "./utils.js";

const logger = {
  info: (msg: string) => console.info(msg),
  warning: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
  debug: (msg: string) => console.debug(msg),
};

// ============================================================
// 类型定义
// ============================================================

export interface MessageContent {
  type: string;
  [key: string]: unknown;
}

export interface Message {
  role: string;
  content: string | MessageContent[];
}

export interface UsageDict {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  token_source: "api" | "estimated";
}

export interface LlmResult {
  content: string;
  usage: UsageDict;
}

export type LlmStatus = "success" | "retriable_error" | "fatal_error";

export interface LlmCallOptions {
  temperature?: number;
  max_tokens?: number;
  timeout?: number;
  max_retries?: number;
  retry_delay?: number;
  extra_headers?: Record<string, string>;
  extra_params?: Record<string, unknown>;
}

// ============================================================
// 内部函数
// ============================================================

/**
 * 预处理消息列表，自动将图片路径转换为 Base64 编码
 *
 * 检测格式: {"type": "image", "path": "xxx.jpg"}
 * 转换为: {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,..."}}
 */
function processMessagesWithImages(messages: Message[]): Message[] {
  const processedMessages: Message[] = [];

  for (const msg of messages) {
    const processedMsg = { ...msg };

    // 检查 content 是否为列表（多模态消息）
    if (Array.isArray(msg.content)) {
      const processedContent: MessageContent[] = [];

      for (const item of msg.content) {
        if (typeof item === "object" && item !== null) {
          // 检测图片路径标记
          if (item.type === "image" && "path" in item) {
            const imagePath = item.path as string;

            // 检查文件是否存在
            if (!fs.existsSync(imagePath)) {
              logger.warning(`图片文件不存在，跳过: ${imagePath}`);
              continue;
            }

            // 转换为 Base64
            try {
              const base64Data = imageToBase64(imagePath);
              const mimeType = getImageMimeType(imagePath);

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
              // 跳过失败的图片
              continue;
            }
          } else {
            processedContent.push(item as MessageContent);
          }
        } else {
          processedContent.push(item as MessageContent);
        }
      }

      processedMsg.content = processedContent;
    }

    processedMessages.push(processedMsg);
  }

  return processedMessages;
}

/**
 * 从文本内容估算token数量
 *
 * 规则:
 * - 中文字符: 1个汉字 ≈ 0.3 tokens
 * - 英文字母: 3个字母 ≈ 0.3 tokens
 */
function estimateTokensFromText(text: string): number {
  if (!text) return 0;

  // 统计中文字符（汉字范围）
  const chineseCount = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;

  // 统计英文字母
  const englishCount = (text.match(/[a-zA-Z]/g) ?? []).length;

  // 计算tokens
  const chineseTokens = chineseCount * 0.3;
  const englishTokens = (englishCount / 3.0) * 0.3;

  const total = Math.floor(chineseTokens + englishTokens);

  logger.debug(
    `Token估算: 中文${chineseCount}字×0.3=${chineseTokens.toFixed(1)}, ` +
      `英文${englishCount}字母÷3×0.3=${englishTokens.toFixed(1)}, ` +
      `总计≈${total}`
  );

  return total;
}

/**
 * 安全熔断检查：LLM调用是否已启用
 * TODO: 迁移 safety.py 后替换为真实实现
 */
function isLlmEnabled(): boolean {
  return true;
}

// ============================================================
// 核心 API 调用
// ============================================================

/**
 * 统一的LLM API调用函数
 *
 * @returns [status, result]
 * - status: "success" | "retriable_error" | "fatal_error"
 * - result: 成功时为包含content和usage的字典，失败时为错误字典
 */
export async function callLlmApi(
  messages: Message[],
  apiUrl: string,
  apiKey: string,
  model: string,
  options: LlmCallOptions = {}
): Promise<[LlmStatus, LlmResult | Record<string, unknown>]> {
  const {
    temperature = 0.7,
    max_tokens = 2000,
    timeout = 120,
    max_retries = 3,
    retry_delay = parseFloat(process.env["NETWORK_RETRY_DELAY"] ?? "5"),
    extra_headers,
    extra_params,
  } = options;

  // 预处理消息：自动转换图片路径为 Base64
  const processedMessages = processMessagesWithImages(messages);

  for (let attempt = 0; attempt < max_retries; attempt++) {
    try {
      // ⭐ 密钥熔断：如果被冻结，替换为无效密钥
      let actualApiKey = apiKey;
      if (!isLlmEnabled()) {
        logger.warning("🔒 [SAFETY] LLM 调用已冻结，使用无效密钥");
        actualApiKey = "sk-INVALID-SAFETY-FREEZE-ENABLED";
      }

      // 构建请求体
      const payload: Record<string, unknown> = {
        model,
        messages: processedMessages,
        temperature,
        max_tokens,
      };

      // 添加额外的请求参数（如思考模式等）
      if (extra_params) {
        Object.assign(payload, extra_params);
      }

      const headers: Record<string, string> = {
        Authorization: `Bearer ${actualApiKey}`,
        "Content-Type": "application/json",
      };

      // 添加额外的headers（如OpenRouter的HTTP-Referer等）
      if (extra_headers) {
        Object.assign(headers, extra_headers);
      }

      // 发送请求
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);

      let response: Response;
      try {
        response = await fetch(apiUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      // 处理响应
      if (response.status === 200) {
        const responseData = await response.json() as Record<string, unknown>;
        const choices = responseData["choices"] as Array<Record<string, unknown>> | undefined;
        const choice = choices?.[0] ?? {};
        const message = choice["message"] as Record<string, unknown> | undefined;
        let content = (message?.["content"] as string | undefined) ?? "";
        if (content) content = content.trim();
        const finishReason = choice["finish_reason"] as string | undefined;

        // ⭐ 处理usage（可能缺失）
        const usageRaw = responseData["usage"] as Record<string, number> | undefined;

        let usageDict: UsageDict;
        if (usageRaw) {
          usageDict = {
            prompt_tokens: usageRaw["prompt_tokens"] ?? 0,
            completion_tokens: usageRaw["completion_tokens"] ?? 0,
            total_tokens: usageRaw["total_tokens"] ?? 0,
            token_source: "api",
          };
        } else {
          // ⭐ API未提供usage，手工估算
          logger.warning("API响应缺少usage字段，使用token估算值计算成本");

          const promptText = processedMessages
            .map((msg) => (typeof msg.content === "string" ? msg.content : ""))
            .join(" ");
          const estimatedPrompt = estimateTokensFromText(promptText);
          const estimatedCompletion = estimateTokensFromText(content);

          usageDict = {
            prompt_tokens: estimatedPrompt,
            completion_tokens: estimatedCompletion,
            total_tokens: estimatedPrompt + estimatedCompletion,
            token_source: "estimated",
          };

          logger.info(
            `Token估算: prompt≈${estimatedPrompt}, ` +
              `completion≈${estimatedCompletion}, ` +
              `total≈${usageDict.total_tokens}`
          );
        }

        const resultDict: LlmResult = { content, usage: usageDict };

        if (finishReason === "stop") {
          return ["success", resultDict];
        } else if (finishReason === "length") {
          logger.warning(
            `响应被截断，已消耗${usageDict.total_tokens}tokens ` +
              `(来源: ${usageDict.token_source})`
          );
          if (content) return ["success", resultDict];
          return [
            "fatal_error",
            { error: "响应被截断且无内容，请增加max_tokens", usage: usageDict },
          ];
        } else {
          if (content) {
            logger.warning(`异常的完成原因: ${finishReason}，但已获取到内容`);
            return ["success", resultDict];
          }
          return ["fatal_error", { error: `异常的完成原因: ${finishReason}` }];
        }
      }

      // HTTP 错误处理
      const responseText = await response.text();

      if (response.status === 400) {
        return ["fatal_error", { error: `客户端错误 (400): ${responseText}` }];
      } else if (response.status === 401 || response.status === 403) {
        return ["fatal_error", { error: `认证错误 (${response.status}): ${responseText}` }];
      } else if (response.status === 404) {
        return ["fatal_error", { error: `资源未找到 (404): ${responseText}` }];
      } else if (response.status === 429) {
        if (attempt < max_retries - 1) {
          await sleep(retry_delay * (attempt + 1));
          continue;
        }
        return ["retriable_error", { error: `速率限制 (429): ${responseText}` }];
      } else if (response.status >= 500 && response.status < 600) {
        if (attempt < max_retries - 1) {
          await sleep(retry_delay * (attempt + 1));
          continue;
        }
        return ["retriable_error", { error: `服务器错误 (${response.status}): ${responseText}` }];
      } else if (response.status === 408) {
        if (attempt < max_retries - 1) {
          await sleep(retry_delay);
          continue;
        }
        return ["retriable_error", { error: `请求超时 (408): ${responseText}` }];
      } else {
        return ["fatal_error", { error: `未知HTTP错误 (${response.status}): ${responseText}` }];
      }
    } catch (e) {
      // 网络层错误处理
      if (e instanceof Error) {
        const name = e.name;
        const msg = e.message;

        if (name === "AbortError") {
          // fetch timeout
          if (attempt < max_retries - 1) {
            await sleep(retry_delay);
            continue;
          }
          return ["retriable_error", { error: "请求超时" }];
        }

        if (msg.includes("SSL") || msg.includes("certificate")) {
          logger.warning(`SSL证书错误（尝试 ${attempt + 1}/${max_retries}）: ${msg}`);
          if (attempt < max_retries - 1) {
            logger.info(`等待 ${retry_delay} 秒后重试...`);
            await sleep(retry_delay);
            continue;
          }
          return [
            "retriable_error",
            {
              error: `SSL证书验证失败（重试${max_retries}次后仍失败）: ${msg}`,
              error_type: "ssl_error",
            },
          ];
        }

        if (msg.includes("proxy") || msg.includes("PROXY")) {
          logger.warning(`代理连接错误: ${msg}`);
          if (attempt < max_retries - 1) {
            await sleep(retry_delay);
            continue;
          }
          return ["retriable_error", { error: `代理连接失败: ${msg}`, error_type: "proxy_error" }];
        }

        if (msg.includes("redirect") || msg.includes("REDIRECT")) {
          logger.error(`重定向次数过多: ${msg}`);
          return [
            "fatal_error",
            { error: `重定向次数超限: ${msg}`, error_type: "redirect_error" },
          ];
        }

        // 通用网络错误，可重试
        if (attempt < max_retries - 1) {
          await sleep(retry_delay);
          continue;
        }
        return ["retriable_error", { error: `请求异常: ${msg}` }];
      }

      return ["fatal_error", { error: `未知错误: ${e}` }];
    }
  }

  return ["retriable_error", { error: `重试${max_retries}次后仍然失败` }];
}

// ============================================================
// 简化接口
// ============================================================

/**
 * 简化的对话接口
 *
 * @throws ConnectionError 可重试错误
 * @throws ValueError 致命错误
 */
export async function chat(
  prompt: string,
  apiUrl: string,
  apiKey: string,
  model: string,
  options: LlmCallOptions = {}
): Promise<LlmResult> {
  const messages: Message[] = [{ role: "user", content: prompt }];

  const [status, result] = await callLlmApi(messages, apiUrl, apiKey, model, options);

  if (status === "success") {
    return result as LlmResult;
  } else if (status === "retriable_error") {
    const errorMsg =
      typeof result === "object" && result !== null && "error" in result
        ? result["error"]
        : String(result);
    throw new Error(`API调用失败（可重试）: ${errorMsg}`);
  } else {
    const errorMsg =
      typeof result === "object" && result !== null && "error" in result
        ? result["error"]
        : String(result);
    throw new Error(`API调用失败（致命错误）: ${errorMsg}`);
  }
}

// ============================================================
// 工具函数
// ============================================================

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
