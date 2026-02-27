/**
 * 验证器模块入口
 *
 * 提供验证器注册表和工厂函数 getValidator。
 * 添加新验证器：继承 BaseValidator，在 VALIDATORS 中注册一行即可。
 */

import { BaseValidator } from "./base.js";
import { SimpleJSONValidator } from "./simple_json_validator.js";

// ============================================================
// 验证器注册表
// ============================================================

export const VALIDATORS: Record<string, new (config: Record<string, unknown>) => BaseValidator> = {
  simple_json: SimpleJSONValidator,
  // pdf_page: PDFPageValidator,  // ⏳ 待迁移（依赖 pdf_to_images）
};

// ============================================================
// 工厂函数
// ============================================================

/**
 * 根据名称获取验证器实例
 *
 * @param name   验证器名称（在 YAML 配置中指定）
 * @param config 验证器配置（可选）
 * @returns      BaseValidator 实例
 * @throws Error 验证器名称不存在时抛出
 */
export function getValidator(
  name: string,
  config: Record<string, unknown> = {}
): BaseValidator {
  const ValidatorClass = VALIDATORS[name];

  if (!ValidatorClass) {
    const available = Object.keys(VALIDATORS).sort();
    throw new Error(
      `❌ 未知的验证器: '${name}'\n\n` +
        `【可用验证器】\n  ${available.join(", ")}\n\n` +
        `【使用方法】\n  在 YAML 配置中指定：\n` +
        `  validator: "${available[0] ?? "validator_name"}"`
    );
  }

  return new ValidatorClass(config);
}

export { BaseValidator };
export { SimpleJSONValidator };
