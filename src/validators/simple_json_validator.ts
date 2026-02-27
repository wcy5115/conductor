/**
 * 简单 JSON 验证器
 *
 * 只验证最基本的字段存在性，不验证具体的内容结构。
 *
 * 适用场景：
 * - 简单的 JSON 提取工作流
 * - 只需要确保基本字段存在
 * - 内容格式可以是任意的（字符串、对象等）
 * - 不需要验证段落编号等细节
 *
 * 验证规则：
 * 1. 数据必须是字典类型
 * 2. 必须包含"页码"字段
 * 3. 必须包含"内容"字段
 * 4. 不验证字段的具体类型和内容结构
 */

import { BaseValidator } from "./base.js";

/**
 * 简单 JSON 验证器
 *
 * 只验证基础结构，不验证详细内容。
 *
 * 合法数据示例（所有这些都能通过验证）：
 *   {"页码": "1", "内容": "完整的文字内容"}
 *   {"页码": "1", "内容": {"段落1": "...", "段落2": "..."}}
 *   {"页码": "kong", "内容": "kong"}
 *   {"页码": "1", "内容": {}}
 *
 * 非法数据示例：
 *   {"页码": "1"}          // 缺少"内容"
 *   {"内容": "..."}        // 缺少"页码"
 *   ["页码", "内容"]       // 是数组
 */
export class SimpleJSONValidator extends BaseValidator {
  get name(): string {
    return "simple_json";
  }

  validate(data: unknown): boolean {
    // 检查1：数据类型必须是字典
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      const repr = JSON.stringify(data);
      const truncated = repr.length > 200 ? repr.slice(0, 200) + "..." : repr;
      throw new Error(
        `❌ 数据必须是对象类型\n` +
          `\n` +
          `【实际类型】\n` +
          `  ${Array.isArray(data) ? "array" : data === null ? "null" : typeof data}\n` +
          `\n` +
          `【实际数据】\n` +
          `  ${truncated}\n` +
          `\n` +
          `【期望格式】\n` +
          `  {"页码": "...", "内容": "..."}\n` +
          `\n` +
          `【修复建议】\n` +
          `  确保 LLM 返回的是 JSON 对象（使用花括号 {}）`
      );
    }

    const obj = data as Record<string, unknown>;

    // 检查2：必须包含"页码"字段
    if (!("页码" in obj)) {
      throw new Error(
        `❌ 缺少必填字段: 页码\n` +
          `\n` +
          `【实际字段】\n` +
          `  ${JSON.stringify(Object.keys(obj))}\n` +
          `\n` +
          `【实际数据】\n` +
          `${JSON.stringify(obj, null, 2)}\n` +
          `\n` +
          `【期望格式】\n` +
          `  {"页码": "识别到的页码", "内容": "..."}\n` +
          `\n` +
          `【修复建议】\n` +
          `  在 JSON 中添加 "页码" 字段`
      );
    }

    // 检查3：必须包含"内容"字段
    if (!("内容" in obj)) {
      throw new Error(
        `❌ 缺少必填字段: 内容\n` +
          `\n` +
          `【实际字段】\n` +
          `  ${JSON.stringify(Object.keys(obj))}\n` +
          `\n` +
          `【实际数据】\n` +
          `${JSON.stringify(obj, null, 2)}\n` +
          `\n` +
          `【期望格式】\n` +
          `  {"页码": "...", "内容": "文字内容或段落对象"}\n` +
          `\n` +
          `【修复建议】\n` +
          `  在 JSON 中添加 "内容" 字段`
      );
    }

    // 验证通过
    const contentType = Array.isArray(obj["内容"]) ? "array" : typeof obj["内容"];
    console.debug(
      `✓ 简单 JSON 验证通过 (页码: ${obj["页码"]}, 内容类型: ${contentType})`
    );
    return true;
  }
}
