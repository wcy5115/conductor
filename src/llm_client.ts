/**
 * LLM 客户端模块
 *
 * 本模块是整个项目与大语言模型（LLM）交互的唯一出口，职责包括：
 *   1. 将用户消息发送给 OpenAI 兼容的 API（如 OpenAI、Azure、OpenRouter 等）
 *   2. 处理 API 响应：提取生成文本、token 用量，判断成功/可重试/致命错误
 *   3. 内置自动重试机制：对速率限制(429)、服务器错误(5xx)、网络超时等自动重试
 *
 * 已拆分到其他模块的功能：
 *   - 图片预处理（processMessagesWithImages） → utils.ts
 *   - Token 估算（estimateTokensFromText）    → cost_calculator.ts
 *
 * 对外暴露两个主要函数：
 *   - callLlmApi()  —— 底层调用，接受完整的消息列表，返回 [status, result] 元组
 *   - chat()        —— 简化接口，传入单条 prompt 字符串即可，自动包装为消息列表
 */

// processMessagesWithImages: 预处理消息列表，将本地图片路径自动转换为 Base64 Data URL
// 原本位于 llm_client.ts 内部，因为与图片工具函数（imageToBase64、getImageMimeType）关系更紧密，
// 已移至 utils.ts，让 llm_client.ts 只专注于 HTTP 调用逻辑
import { processMessagesWithImages } from "./utils.js";

// estimateTokensFromText: 根据中英文字符数估算 token 数量
// 原本位于 llm_client.ts 内部，因为属于 token/成本计算逻辑，
// 已移至 cost_calculator.ts，让成本相关功能集中管理
import { estimateTokensFromText } from "./cost_calculator.js";

// ============================================================
// 简易日志器
// ============================================================

/**
 * 简易日志器，将不同级别的日志输出到控制台。
 *
 * 没有使用 src/core/logging.ts 中的完整日志系统，是因为 llm_client 作为底层模块
 * 需要保持依赖最小化，避免循环依赖。
 *
 * 四个级别分别对应 console 的不同方法：
 *   - info:    一般信息（如 token 估算结果）
 *   - warning: 警告信息（如 API 响应缺少 usage 字段）
 *   - error:   错误信息（如图片转换失败）
 *   - debug:   调试信息（如图片转换成功的确认）
 */
const logger = {
  info: (msg: string) => console.info(msg),
  warning: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
  debug: (msg: string) => console.debug(msg),
};

// ============================================================
// 类型定义
// ============================================================

/**
 * 消息内容块的类型定义
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
export interface MessageContent {
  type: string;
  [key: string]: unknown;
}

/**
 * 单条聊天消息的类型定义
 *
 * role 表示发言角色，常见值：
 *   - "system":    系统提示词，设置 AI 的行为方式
 *   - "user":      用户输入
 *   - "assistant": AI 的回复
 *
 * content 有两种形态：
 *   - string: 纯文本消息，最常见的形式
 *     示例：{ role: "user", content: "你好" }
 *   - MessageContent[]: 多模态消息，包含文本 + 图片等多种内容块
 *     示例：{ role: "user", content: [
 *       { type: "text", text: "这是什么？" },
 *       { type: "image_url", image_url: { url: "data:..." } }
 *     ]}
 */
export interface Message {
  role: string;
  content: string | MessageContent[];
}

/**
 * Token 用量统计的类型定义
 *
 * 每次 API 调用后都会返回（或估算）token 用量，用于成本计算。
 *
 * prompt_tokens:      输入消息消耗的 token 数
 * completion_tokens:  AI 生成回复消耗的 token 数
 * total_tokens:       以上两者之和
 * token_source:       用量数据的来源
 *   - "api":       API 响应中直接提供（准确）
 *   - "estimated": 本地通过字符数估算（有误差，但保证成本计算不会缺失）
 */
export interface UsageDict {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  token_source: "api" | "estimated";
}

/**
 * LLM 调用成功时的返回结果
 *
 * content: AI 生成的文本回复
 * usage:   本次调用的 token 用量统计
 */
export interface LlmResult {
  content: string;
  usage: UsageDict;
}

/**
 * LLM 调用的状态码（三态）
 *
 * "success":         调用成功，result 中包含有效内容
 * "retriable_error": 可重试的错误（如网络超时、速率限制），调用方可以稍后重试
 * "fatal_error":     致命错误（如认证失败、参数错误），重试无意义
 */
export type LlmStatus = "success" | "retriable_error" | "fatal_error";

/**
 * LLM 调用的可选参数
 *
 * temperature:    生成随机性，0.0 最确定 ~ 2.0 最随机，默认 0.7
 * max_tokens:     生成回复的最大 token 数，默认 2000
 * timeout:        单次 HTTP 请求的超时时间（秒），默认 120
 * max_retries:    最大重试次数，默认 3
 * retry_delay:    重试间隔基数（秒），实际间隔 = retry_delay × 第几次重试，默认读环境变量
 * extra_headers:  附加的 HTTP 请求头，例如 OpenRouter 需要的 HTTP-Referer
 *                 类型 Record<string, string> 等价于 Python 的 dict[str, str]
 * extra_params:   附加的请求体参数，例如某些 API 的思考模式(thinking)开关
 *                 类型 Record<string, unknown> 等价于 Python 的 dict[str, Any]
 */
export interface LlmCallOptions {
  temperature?: number;
  max_tokens?: number;
  timeout?: number;
  max_retries?: number;
  retry_delay?: number;
  extra_headers?: Record<string, string>;
  extra_params?: Record<string, unknown>;
}

/**
 * 安全熔断检查：LLM 调用是否已启用
 *
 * 读取环境变量 LLM_API_ENABLE，只有明确设为以下值时才允许调用（不区分大小写）：
 *   "true" / "1" / "yes" / "on"
 * 其他情况一律返回 false（默认冻结），防止误触产生 API 费用。
 *
 * 对应 Python 版 safety.py 的 is_llm_enabled()
 */
function isLlmEnabled(): boolean {
  // 从环境变量读取开关值，未设置时默认 "false"（冻结状态）
  const val = (process.env.LLM_API_ENABLE ?? "false").toLowerCase();
  // 只有这几个值视为"启用"，其他一律冻结
  return ["true", "1", "yes", "on"].includes(val);
}

// ============================================================
// 核心 API 调用
// ============================================================

/**
 * 统一的 LLM API 调用函数（底层核心）
 *
 * 这是整个项目中所有 LLM 调用的统一入口。它封装了完整的 HTTP 请求-响应流程：
 *   1. 预处理消息（图片路径 → Base64）
 *   2. 构建 HTTP 请求（OpenAI Chat Completions 兼容格式）
 *   3. 发送请求并处理响应
 *   4. 错误分类与自动重试
 *
 * 返回值是一个元组 [status, result]：
 *   - status 为 "success" 时，result 是 LlmResult（包含 content 和 usage）
 *   - status 为 "retriable_error" 时，result 是 { error: string }，调用方可稍后重试
 *   - status 为 "fatal_error" 时，result 是 { error: string }，重试无意义
 *
 * 自动重试的错误类型：
 *   - HTTP 429（速率限制）、5xx（服务器错误）、408（请求超时）
 *   - 网络层错误：超时（AbortError）、SSL 错误、代理错误
 *   - 重试间隔采用线性退避：第 N 次重试等待 retry_delay × N 秒
 *
 * @param messages  聊天消息列表（可包含图片路径，会自动转换）
 * @param apiUrl    API 端点 URL，如 "https://api.openai.com/v1/chat/completions"
 * @param apiKey    API 密钥
 * @param model     模型名称，如 "gpt-4o"、"claude-3-sonnet"
 * @param options   可选参数（温度、最大 token 数、超时、重试设置等）
 * @returns [status, result] 元组
 */
export async function callLlmApi(
  messages: Message[],
  apiUrl: string,
  apiKey: string,
  model: string,
  options: LlmCallOptions = {}
): Promise<[LlmStatus, LlmResult | Record<string, unknown>]> {
  // 从 options 对象中解构出各个参数，并为每个参数设置默认值
  //
  // 语法说明：const { key = 默认值 } = 对象
  //   - 如果对象中有 key 属性且值不是 undefined → 使用传入的值
  //   - 如果对象中没有 key 属性，或值为 undefined → 使用等号右边的默认值
  //
  // 示例：假设调用方传入 options = { temperature: 0.3 }
  //   temperature = 0.3    ← 调用方传了，用传入的值
  //   max_tokens  = 2000   ← 调用方没传，用默认值 2000
  //   timeout     = 300    ← 调用方没传，用默认值 300
  //   ...以此类推
  const {
    temperature = 0.7,      // 生成随机性，0=确定性最高，1=最随机，默认 0.7
    max_tokens = 50000,     // 最大输出 token 数，默认 50000
    timeout = 300,          // 请求超时秒数，默认 300 秒（5 分钟）
    max_retries = 3,        // 失败后最多重试次数，默认 3 次
    // retry_delay：两次重试之间等待的秒数
    // 优先从环境变量 NETWORK_RETRY_DELAY 读取（方便运维调整，不改代码）
    // ?? "5" 表示环境变量未设置时用字符串 "5"
    // parseFloat 将字符串转为数字（环境变量都是字符串类型）
    retry_delay = parseFloat(process.env["NETWORK_RETRY_DELAY"] ?? "5"),
    extra_headers,          // 额外的 HTTP 请求头（可选，无默认值，不传则为 undefined）
    extra_params,           // 额外的 API 参数（可选，无默认值，不传则为 undefined）
  } = options;

  // 第一步：预处理消息——将本地图片路径转换为 Base64 Data URL
  const processedMessages = processMessagesWithImages(messages);

  // 第二步：带重试的请求循环
  // attempt 从 0 开始计数，最多尝试 max_retries 次
  for (let attempt = 0; attempt < max_retries; attempt++) {
    try {
      // ⭐ 密钥熔断机制：如果安全检查未通过，直接返回错误，不发起网络请求
      // 返回 "fatal" 状态，表示不可重试的致命错误，上层会停止调用
      if (!isLlmEnabled()) {
        logger.warning("🔒 [SAFETY] LLM 调用已冻结，跳过 API 请求");
        return ["fatal_error", { error: "LLM 调用已冻结（LLM_API_ENABLE 未启用）" }];
      }

      // 第三步：构建 OpenAI Chat Completions 格式的请求体
      // 参考：https://platform.openai.com/docs/api-reference/chat/create
      const payload: Record<string, unknown> = {
        model,                        // 模型名称
        messages: processedMessages,  // 处理后的消息列表
        temperature,                  // 生成随机性
        max_tokens,                   // 最大生成长度
      };

      // 合并额外参数（如思考模式开关、top_p 等 API 特有参数）
      // Object.assign 会将 extra_params 的所有属性复制到 payload 上
      if (extra_params) {
        Object.assign(payload, extra_params);
      }

      // 构建 HTTP 请求头
      // Authorization: Bearer <key> 是 OpenAI 兼容 API 的标准认证方式
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      };

      // 合并额外请求头（如 OpenRouter 要求的 HTTP-Referer、X-Title 等）
      if (extra_headers) {
        Object.assign(headers, extra_headers);
      }

      // 第四步：发送 HTTP 请求
      // 使用 AbortController 实现请求超时控制
      // AbortController 是 Web API 标准，Node.js 18+ 原生支持
      const controller = new AbortController();
      // setTimeout 在 timeout 秒后触发 abort()，取消请求
      // timeout 单位是秒，setTimeout 需要毫秒，所以乘以 1000
      const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);

      let response: Response;
      try {
        // fetch 是 Node.js 18+ 内置的 HTTP 客户端（之前需要 node-fetch 包）
        // signal: controller.signal 将 fetch 与 AbortController 关联
        // 当 controller.abort() 被调用时，fetch 会抛出 AbortError
        response = await fetch(apiUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } finally {
        // 无论请求成功还是失败，都要清除定时器，避免内存泄漏
        clearTimeout(timeoutId);
      }

      // ============================================================
      // 第五步：处理 HTTP 响应
      // ============================================================

      if (response.status === 200) {
        // ---- 成功响应，解析 JSON ----
        const responseData = await response.json() as Record<string, unknown>;

        // 提取 AI 生成的文本内容
        // OpenAI 响应格式：{ choices: [{ message: { content: "..." }, finish_reason: "stop" }] }
        const choices = responseData["choices"] as Array<Record<string, unknown>> | undefined;
        // choices?.[0] 是可选链：如果 choices 为 undefined 则返回 undefined，不会报错
        const choice = choices?.[0] ?? {};
        const message = choice["message"] as Record<string, unknown> | undefined;
        // 提取文本内容，若为空则默认为空字符串
        let content = (message?.["content"] as string | undefined) ?? "";
        // 去除首尾空白字符（API 有时会返回带换行的内容）
        if (content) content = content.trim();
        // finish_reason 表示生成停止的原因：
        //   "stop":   正常完成
        //   "length": 达到 max_tokens 限制被截断
        const finishReason = choice["finish_reason"] as string | undefined;

        // ⭐ 处理 token 用量（usage 字段可能缺失）
        // 标准 OpenAI API 会返回 usage，但某些第三方 API 可能不返回
        const usageRaw = responseData["usage"] as Record<string, number> | undefined;

        let usageDict: UsageDict;
        if (usageRaw) {
          // API 提供了 usage，直接使用（准确值）
          usageDict = {
            prompt_tokens: usageRaw["prompt_tokens"] ?? 0,
            completion_tokens: usageRaw["completion_tokens"] ?? 0,
            total_tokens: usageRaw["total_tokens"] ?? 0,
            token_source: "api",
          };
        } else {
          // ⭐ API 未提供 usage，使用本地估算
          // 这种情况常见于 Ollama 等本地部署的模型、部分第三方代理
          logger.warning("API响应缺少usage字段，使用token估算值计算成本");

          // 将所有输入消息的文本内容拼接起来估算 prompt token
          // 注意：多模态消息的图片部分无法估算，这里只统计文本
          const promptText = processedMessages
            .map((msg) => (typeof msg.content === "string" ? msg.content : ""))
            .join(" ");
          const estimatedPrompt = estimateTokensFromText(promptText);
          // 用 AI 回复的文本估算 completion token
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

        // 组装最终结果
        const resultDict: LlmResult = { content, usage: usageDict };

        // 根据 finish_reason 判断调用是否成功
        if (finishReason === "stop") {
          // 正常完成，返回成功
          return ["success", resultDict];
        } else if (finishReason === "length") {
          // 被截断：达到了 max_tokens 限制
          logger.warning(
            `响应被截断，已消耗${usageDict.total_tokens}tokens ` +
              `(来源: ${usageDict.token_source})`
          );
          // 如果截断前已经有内容，仍视为成功（部分内容总比没有好）
          if (content) return ["success", resultDict];
          // 截断且无内容 → 致命错误，需要增大 max_tokens
          return [
            "fatal_error",
            { error: "响应被截断且无内容，请增加max_tokens", usage: usageDict },
          ];
        } else {
          // 其他异常的 finish_reason（如 "content_filter" 等）
          if (content) {
            // 有内容就视为成功，只记录警告
            logger.warning(`异常的完成原因: ${finishReason}，但已获取到内容`);
            return ["success", resultDict];
          }
          return ["fatal_error", { error: `异常的完成原因: ${finishReason}` }];
        }
      }

      // ============================================================
      // HTTP 错误处理（非 200 状态码）
      // ============================================================

      // 读取错误响应体（文本格式），用于错误消息
      const responseText = await response.text();

      // 按 HTTP 状态码分类处理
      if (response.status === 400) {
        // 400 Bad Request：请求参数错误（如不支持的模型名、无效的 temperature 值）
        // 致命错误，修正参数前重试无意义
        return ["fatal_error", { error: `客户端错误 (400): ${responseText}` }];
      } else if (response.status === 401 || response.status === 403) {
        // 401 Unauthorized / 403 Forbidden：API 密钥无效或无权限
        // 致命错误，更换密钥前重试无意义
        return ["fatal_error", { error: `认证错误 (${response.status}): ${responseText}` }];
      } else if (response.status === 404) {
        // 404 Not Found：API 端点或模型名不存在
        // 致命错误，检查 URL 和模型名
        return ["fatal_error", { error: `资源未找到 (404): ${responseText}` }];
      } else if (response.status === 429) {
        // 429 Too Many Requests：触发速率限制（每分钟请求数/token 数超限）
        // 可重试：等待后重试，间隔线性递增（retry_delay × 第几次重试）
        if (attempt < max_retries - 1) {
          await sleep(retry_delay * (attempt + 1));
          continue; // 跳到下一次重试
        }
        // 重试次数用尽，返回可重试错误（交给上层决定是否继续重试）
        return ["retriable_error", { error: `速率限制 (429): ${responseText}` }];
      } else if (response.status >= 500 && response.status < 600) {
        // 5xx 服务器错误：API 服务端出问题，通常是暂时性的
        // 可重试：等待后重试，间隔线性递增
        if (attempt < max_retries - 1) {
          await sleep(retry_delay * (attempt + 1));
          continue;
        }
        return ["retriable_error", { error: `服务器错误 (${response.status}): ${responseText}` }];
      } else if (response.status === 408) {
        // 408 Request Timeout：服务端超时（区别于客户端 AbortError 超时）
        // 可重试：等待固定间隔后重试
        if (attempt < max_retries - 1) {
          await sleep(retry_delay);
          continue;
        }
        return ["retriable_error", { error: `请求超时 (408): ${responseText}` }];
      } else {
        // 其他未预期的 HTTP 状态码（如 418 I'm a teapot），视为致命错误
        return ["fatal_error", { error: `未知HTTP错误 (${response.status}): ${responseText}` }];
      }
    } catch (e) {
      // ============================================================
      // 网络层错误处理（请求未能到达服务器或未收到完整响应）
      // ============================================================

      if (e instanceof Error) {
        const name = e.name;
        const msg = e.message;

        if (name === "AbortError") {
          // AbortError：客户端超时——AbortController 在 timeout 秒后触发了 abort()
          // 可重试：服务器可能暂时响应慢
          if (attempt < max_retries - 1) {
            await sleep(retry_delay);
            continue;
          }
          return ["retriable_error", { error: "请求超时" }];
        }

        if (msg.includes("SSL") || msg.includes("certificate")) {
          // SSL/TLS 证书错误：证书过期、自签名证书、证书链不完整等
          // 可重试：有时是暂时性的网络问题导致证书验证失败
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
          // 代理连接错误：HTTP/HTTPS 代理不可达或拒绝连接
          // 可重试：代理服务器可能暂时不可用
          logger.warning(`代理连接错误: ${msg}`);
          if (attempt < max_retries - 1) {
            await sleep(retry_delay);
            continue;
          }
          return ["retriable_error", { error: `代理连接失败: ${msg}`, error_type: "proxy_error" }];
        }

        if (msg.includes("redirect") || msg.includes("REDIRECT")) {
          // 重定向过多：通常是 API URL 配置错误导致的无限重定向循环
          // 致命错误：重试不会改善，需要修正 URL 配置
          logger.error(`重定向次数过多: ${msg}`);
          return [
            "fatal_error",
            { error: `重定向次数超限: ${msg}`, error_type: "redirect_error" },
          ];
        }

        if (
          msg.includes("chunked") ||
          msg.includes("CHUNKED") ||
          msg.includes("incomplete") ||
          msg.includes("truncated")
        ) {
          // 分块传输错误：HTTP chunked transfer encoding 数据不完整
          // 对应 Python 版 requests.exceptions.ChunkedEncodingError
          // 常见原因：服务器在传输响应体时中断连接（网络抖动、服务端超时等）
          // 可重试：通常是暂时性的网络问题
          logger.warning(`分块传输错误（尝试 ${attempt + 1}/${max_retries}）: ${msg}`);
          if (attempt < max_retries - 1) {
            await sleep(retry_delay);
            continue;
          }
          return [
            "retriable_error",
            { error: `数据传输中断: ${msg}`, error_type: "chunked_encoding_error" },
          ];
        }

        // 通用网络错误（DNS 解析失败、连接拒绝、网络不可达等）
        // 可重试：网络问题通常是暂时性的
        if (attempt < max_retries - 1) {
          await sleep(retry_delay);
          continue;
        }
        return ["retriable_error", { error: `请求异常: ${msg}` }];
      }

      // e 不是 Error 实例（极少见，如 throw "string" 或 throw 42）
      // 致命错误：无法判断类型，不适合重试
      return ["fatal_error", { error: `未知错误: ${e}` }];
    }
  }

  // 所有重试都用尽后仍未成功（理论上不应到达这里，但作为安全兜底）
  return ["retriable_error", { error: `重试${max_retries}次后仍然失败` }];
}

// ============================================================
// 简化接口
// ============================================================

/**
 * 简化的对话接口
 *
 * 适用于只需发送单条文本消息的简单场景。
 * 内部将 prompt 包装为 [{ role: "user", content: prompt }] 后调用 callLlmApi()。
 *
 * 与 callLlmApi 的区别：
 *   - callLlmApi 返回 [status, result] 元组，调用方自行判断状态
 *   - chat 直接返回 LlmResult，遇到错误时抛出异常
 *
 * 使用示例：
 *   const result = await chat("你好", apiUrl, apiKey, "gpt-4o");
 *   console.log(result.content);  // "你好！有什么可以帮助你的吗？"
 *   console.log(result.usage);    // { prompt_tokens: 5, completion_tokens: 12, ... }
 *
 * @param prompt  用户输入的文本
 * @param apiUrl  API 端点 URL
 * @param apiKey  API 密钥
 * @param model   模型名称
 * @param options 可选参数
 * @returns LlmResult 包含生成文本和 token 用量
 * @throws Error 可重试错误或致命错误时抛出异常
 */
export async function chat(
  prompt: string,
  apiUrl: string,
  apiKey: string,
  model: string,
  options: LlmCallOptions = {}
): Promise<LlmResult> {
  // 将单条 prompt 包装为标准的消息列表格式
  const messages: Message[] = [{ role: "user", content: prompt }];

  const [status, result] = await callLlmApi(messages, apiUrl, apiKey, model, options);

  if (status === "success") {
    // 成功时 result 一定是 LlmResult 类型，使用 as 断言告诉 TypeScript
    return result as LlmResult;
  } else if (status === "retriable_error") {
    // 可重试错误：抛出异常，调用方可 catch 后决定是否重试
    // result 可能是 { error: "..." } 对象，需要安全地提取错误消息
    const errorMsg =
      typeof result === "object" && result !== null && "error" in result
        ? result["error"]
        : String(result);
    throw new Error(`API调用失败（可重试）: ${errorMsg}`);
  } else {
    // 致命错误：同样抛出异常，但调用方不应重试
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

/**
 * 异步等待指定秒数
 *
 * 封装 setTimeout 为 Promise，使其可以配合 async/await 使用。
 * 用于重试间隔等待。
 *
 * 示例：await sleep(5)  // 等待 5 秒
 *
 * @param seconds 等待的秒数
 * @returns Promise，在指定秒数后 resolve
 */
function sleep(seconds: number): Promise<void> {
  // setTimeout 的单位是毫秒，所以 seconds × 1000
  // new Promise + resolve 将回调式的 setTimeout 转为 Promise 风格
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
