/**
 * 视觉模型测试脚本（原始透传）
 *
 * 绕过框架封装，直接用 fetch() 裸调 API，可以查看完整的请求体和响应体。
 * 适用于排查模型兼容性问题、验证图片格式是否正确等场景。
 *
 * 输出两段：
 *   === 请求体 ===  （base64 已截断，防止终端刷屏）
 *   === 响应体 ===  （完整 JSON）
 *
 * 修改下方配置区，然后运行：
 *   npx tsx scripts/debug_raw.ts
 */

import "dotenv/config";

// fs 是 Node.js 内置的文件系统模块，用于检查图片文件是否存在
import * as fs from "fs";
// MODEL_MAPPINGS 是从 models.yaml 加载的全部模型配置字典
// SingleModelConfig 是单个模型配置的类型（包含 api_url、api_key、model_name 等字段）
// ModelConfigEntry 是配置条目类型：可能是单个 SingleModelConfig，也可能是 SingleModelConfig[]（列表格式）
import {
  MODEL_MAPPINGS,
  SingleModelConfig,
  ModelConfigEntry,
} from "../src/model_caller.js";
// imageToBase64 将图片文件读取并转为 Base64 编码字符串
// getImageMimeType 根据文件扩展名返回对应的 MIME 类型（如 .png → "image/png"）
import { imageToBase64, getImageMimeType } from "../src/utils.js";

// ================================================================
// 配置区：按需修改
// ================================================================

// MODEL：要测试的模型简称，需与 models.yaml 中的 key 一致
const MODEL = "gpt5.5";

// PROMPT：发送给模型的提示词
const PROMPT =
  "请把下面这串无声调拼音转换成最自然的汉字，只输出汉字，不要解释：daodishishenmcainengrangnirucizhebanxionghanmengliegangmeng";

// IMAGE_PATH：图片路径配置，支持三种形式：
//   null      → 不发送图片（纯文本模式）
//   字符串     → 发送单张图片
//   字符串数组 → 发送多张图片
const IMAGE_PATH: string | string[] | null = null;
// const IMAGE_PATH = "C:\\path\\to\\image.png";
// const IMAGE_PATH = ["C:\\path\\to\\img1.png", "C:\\path\\to\\img2.png"];

// ================================================================

/**
 * 从 MODEL_MAPPINGS 中提取指定模型的配置
 *
 * 兼容两种 models.yaml 配置格式：
 *   1. 字典格式：一个别名直接对应一个配置对象 → 直接返回
 *   2. 列表格式：一个别名对应多个配置（多提供商），通过 enabled: true 选择当前使用的
 *
 * @param alias - 模型简称（如 "doubao-vision"）
 * @returns 解析后的单个模型配置
 *
 * 示例（列表格式，从多个提供商中选择 enabled 的）：
 *   models.yaml:
 *     doubao-vision:
 *       - provider: "volcengine"
 *         enabled: true       ← 选这个
 *         api_url: "..."
 *       - provider: "azure"
 *         enabled: false
 *         api_url: "..."
 */
function getConfig(alias: string): SingleModelConfig {
  // 第一步：从 MODEL_MAPPINGS 中查找别名对应的条目
  const entry: ModelConfigEntry | undefined = MODEL_MAPPINGS[alias];
  if (entry === undefined) {
    throw new Error(`未找到模型别名 '${alias}'，请检查 models.yaml。`);
  }

  // 第二步：判断配置格式
  if (Array.isArray(entry)) {
    // 列表格式：遍历所有配置，找到 enabled === true 的那个
    // 使用场景：同一个模型在多个提供商都有部署，通过 enabled 字段快速切换
    for (const item of entry) {
      // item 的类型是 SingleModelConfig，其中 enabled 是可选字段
      // 使用类型断言访问 enabled 属性（SingleModelConfig 类型可能未显式声明此字段）
      if ((item as Record<string, unknown>)["enabled"] === true) {
        return item;
      }
    }
    throw new Error(
      `模型 '${alias}' 的列表配置中没有 enabled=true 的条目。`
    );
  }

  // 字典格式：直接返回配置对象
  return entry;
}

/**
 * 截断 Base64 字符串，防止终端输出刷屏
 *
 * 完整的 Base64 图片编码通常有几十万字符，打印到终端会淹没其他信息。
 * 截断后显示前 maxLen 个字符并附加总长度提示。
 *
 * @param data   - 完整的 Base64 字符串
 * @param maxLen - 保留的最大字符数（默认 80）
 * @returns 截断后的字符串，超长时格式为 "前80字符...[共 N 字符]"
 *
 * 示例：
 *   输入: "iVBORw0KGgo..." (10000 字符)
 *   输出: "iVBORw0KGgo...前80字符...[共 10000 字符]"
 */
function truncateBase64(data: string, maxLen: number = 80): string {
  if (data.length > maxLen) {
    return `${data.slice(0, maxLen)}...[共 ${data.length} 字符]`;
  }
  return data;
}

/**
 * 将单张图片编码为 data URI 格式
 *
 * data URI 格式：data:<MIME类型>;base64,<Base64编码内容>
 * 这是 OpenAI 兼容 API 中传递图片的标准格式
 *
 * @param imagePath - 图片文件的绝对路径
 * @returns data URI 字符串，如 "data:image/png;base64,iVBORw0KGgo..."
 */
function encodeImage(imagePath: string): string {
  // 第一步：检查文件是否存在
  if (!fs.existsSync(imagePath)) {
    throw new Error(`图片不存在：${imagePath}`);
  }

  // 第二步：获取 MIME 类型（根据扩展名判断）
  // 例如 .png → "image/png"，.jpg → "image/jpeg"
  const mime = getImageMimeType(imagePath);

  // 第三步：读取图片文件并编码为 Base64
  // imageToBase64 内部使用 fs.readFileSync + Buffer.toString("base64")
  const b64 = imageToBase64(imagePath);

  // 第四步：拼接为 data URI 格式
  return `data:${mime};base64,${b64}`;
}

/**
 * 主函数：构造请求、发送并打印请求体和响应体
 */
async function main(): Promise<void> {
  // ─── 第一步：读取模型配置 ───
  const config = getConfig(MODEL);
  // 从配置中提取 API 连接信息
  const apiUrl = config.api_url; // API 端点 URL
  const apiKey = config.api_key; // API 密钥（Bearer Token）
  const modelName = config.model_name; // 模型全名（如 "doubao-vision-pro-32k"）
  // extra_params 是可选的额外参数（如 stream: false），展开到 payload 顶层
  const extraParams = config.extra_params ?? {};

  // ─── 第二步：处理图片路径，统一为数组 ───
  // IMAGE_PATH 支持三种形式，这里统一转为字符串数组方便后续处理
  let paths: string[];
  if (IMAGE_PATH === null) {
    paths = []; // 不发送图片
  } else if (typeof IMAGE_PATH === "string") {
    paths = [IMAGE_PATH]; // 单张图片 → 包装成数组
  } else {
    paths = [...IMAGE_PATH]; // 多张图片 → 复制数组
  }

  // ─── 第三步：构造 messages 中的 content 数组 ───
  // OpenAI 兼容 API 的多模态格式：content 是一个数组，每个元素是文本或图片
  // 图片在前，文字在后（部分模型对顺序敏感）

  // content 数组的类型定义：每个元素要么是图片 URL 类型，要么是文本类型
  type ContentPart =
    | { type: "image_url"; image_url: { url: string } }
    | { type: "text"; text: string };

  // 先添加所有图片
  const content: ContentPart[] = paths.map((p) => ({
    type: "image_url" as const,
    image_url: { url: encodeImage(p) },
  }));
  // 最后添加文本提示词
  content.push({ type: "text", text: PROMPT });

  // ─── 第四步：构造完整的请求 payload ───
  // payload 遵循 OpenAI Chat Completions API 格式
  const payload: Record<string, unknown> = {
    model: modelName, // 模型全名
    messages: [{ role: "user", content }], // 消息列表（这里只有一条用户消息）
    temperature: config.temperature ?? 0.7,
    max_tokens: config.max_tokens ?? 2000,
    ...extraParams, // 展开额外参数（如 temperature、max_tokens 等）
  };

  // ─── 第五步：打印截断版请求体 ───
  // 深拷贝 payload，然后将 base64 内容截断，避免终端输出几十万字符
  // JSON.parse(JSON.stringify(...)) 是最简单的深拷贝方式（适用于纯 JSON 数据）
  const payloadDisplay = JSON.parse(JSON.stringify(payload));
  for (const msg of payloadDisplay.messages ?? []) {
    const msgContent = msg.content;
    if (Array.isArray(msgContent)) {
      for (const part of msgContent) {
        if (part.type === "image_url") {
          // 找到 base64 部分并截断
          // data URI 格式：data:image/png;base64,<这里是Base64内容>
          const urlVal: string = part.image_url.url;
          const base64Marker = "base64,";
          const markerIndex = urlVal.indexOf(base64Marker);
          if (markerIndex !== -1) {
            // 提取 base64 前缀和编码内容
            const prefix = urlVal.slice(0, markerIndex + base64Marker.length);
            const b64Part = urlVal.slice(markerIndex + base64Marker.length);
            // 拼接截断后的版本
            part.image_url.url = prefix + truncateBase64(b64Part);
          }
        }
      }
    }
  }

  console.log("=".repeat(60));
  console.log("=== 请求体 ===");
  console.log("=".repeat(60));
  console.log(`POST ${apiUrl}`);
  // JSON.stringify 的第三个参数 4 表示缩进 4 个空格，方便阅读
  console.log(JSON.stringify(payloadDisplay, null, 4));

  // ─── 第六步：发送 HTTP 请求 ───
  // 使用 Node.js 内置的 fetch()（Node 18+ 原生支持）
  const headers = {
    Authorization: `Bearer ${apiKey}`, // API 鉴权：Bearer Token 方式
    "Content-Type": "application/json", // 请求体格式：JSON
  };

  const response = await fetch(apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload), // 发送完整 payload（包含未截断的 base64）
    signal: AbortSignal.timeout(120_000), // 超时 120 秒（等价于 Python 的 timeout=120）
  });

  // ─── 第七步：打印完整响应体 ───
  console.log("\n" + "=".repeat(60));
  console.log("=== 响应体 ===");
  console.log("=".repeat(60));
  console.log(`HTTP ${response.status}`);

  // 尝试将响应解析为 JSON 并格式化打印
  // 如果响应不是 JSON（如 HTML 错误页面），则直接打印原始文本
  const responseText = await response.text();
  try {
    const respJson = JSON.parse(responseText);
    console.log(JSON.stringify(respJson, null, 4));
  } catch {
    // JSON 解析失败，直接输出原始响应文本
    console.log(responseText);
  }
}

// 入口：运行主函数
main();
