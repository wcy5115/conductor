/**
 * LLM 测试脚本
 *
 * 通过框架封装层（callModel）批量测试多个模型是否能正常工作。
 * 会打印每个模型的耗时、token 用量和回复内容，最后汇总通过/失败结果。
 *
 * 修改下方配置区，然后运行：
 *   npx tsx scripts/debug_llm.ts
 */

// callModel 是 model_caller.ts 提供的高级调用接口
// 传入模型简称（如 "gpt35"）即可自动查找配置并调用对应 API
// 返回 LlmResult，包含 content（回复文本）和 usage（token 用量统计）
import { callModel } from "../src/model_caller.js";

// ================================================================
// 配置区：按需修改
// ================================================================

// MODELS：要测试的模型简称列表，名称需与 models.yaml 中的 key 一致
// 取消注释即可添加更多模型进行批量测试
const MODELS: string[] = [
  "deepseek-v4-flash-nonthinking",
  // "kimi",
  // "qwen-max",
];

// PROMPT：发送给每个模型的测试提示词
const PROMPT = "你好，用一句话介绍一下你自己。";

// TEMPERATURE：控制回复的随机性，0 = 确定性最高，1 = 最随机
const TEMPERATURE = 0.7;

// MAX_TOKENS：限制模型回复的最大 token 数（防止回复过长浪费额度）
const MAX_TOKENS = 500;

// ================================================================

/**
 * 测试单个模型
 *
 * 调用 callModel 发送 PROMPT，记录耗时和返回结果。
 * 成功时打印回复内容和 token 用量，失败时打印错误信息。
 *
 * @param model - 模型简称（如 "gpt35"），对应 models.yaml 中的 key
 * @returns true 表示调用成功，false 表示出错
 */
async function testModel(model: string): Promise<boolean> {
  // 打印分隔线和当前测试的模型名称
  console.log(`\n${"─".repeat(50)}`);
  console.log(`模型: ${model}`);
  console.log(`${"─".repeat(50)}`);

  // 记录开始时间，用于计算调用耗时
  // performance.now() 返回毫秒级时间戳，比 Date.now() 精度更高
  const start = performance.now();

  try {
    // 第一步：调用 callModel，传入模型简称和参数
    // callModel 内部会：查找配置 → 构造请求 → 发送 HTTP → 解析响应
    const result = await callModel(model, PROMPT, TEMPERATURE, MAX_TOKENS);

    // 计算耗时（毫秒转秒）
    const elapsed = (performance.now() - start) / 1000;

    // 第二步：从返回结果中提取回复内容和 token 用量
    // result.content：模型的回复文本
    // result.usage：token 统计对象，包含 prompt_tokens、completion_tokens、total_tokens
    const content = result.content;
    const totalTokens = result.usage?.total_tokens ?? "?";

    // 第三步：打印测试结果
    console.log(`耗时   : ${elapsed.toFixed(2)}s`);
    console.log(`Tokens : ${totalTokens}`);
    console.log(`回复   :\n${content}`);
    return true;
  } catch (e) {
    // 调用失败时打印错误信息
    const elapsed = (performance.now() - start) / 1000;
    console.log(`耗时   : ${elapsed.toFixed(2)}s`);
    console.log(`错误   : ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * 主函数：批量测试所有模型并汇总结果
 */
async function main(): Promise<void> {
  console.log(`Prompt : ${PROMPT}`);

  // 第一步：逐个测试每个模型，收集通过/失败结果
  // 使用 Map 保持插入顺序，方便最后按顺序打印
  const results = new Map<string, boolean>();
  for (const model of MODELS) {
    const ok = await testModel(model);
    results.set(model, ok);
  }

  // 第二步：打印汇总结果
  console.log(`\n${"═".repeat(50)}`);
  // 统计通过的数量：过滤出 value 为 true 的条目
  const passed = [...results.values()].filter(Boolean).length;
  console.log(`结果: ${passed} / ${MODELS.length} 通过`);
  for (const [model, ok] of results) {
    // ✓ 表示通过，✗ 表示失败
    console.log(`  ${ok ? "✓" : "✗"} ${model}`);
  }
}

// 入口：运行主函数
main();
