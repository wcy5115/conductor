/**
 * 验证器模块入口
 *
 * 提供验证器注册表（VALIDATORS）和工厂函数（getValidator）。
 *
 * 工作原理：
 *   1. 所有验证器类在 VALIDATORS 注册表中注册（名称 → 类的映射）
 *   2. YAML 工作流配置中通过名称引用验证器：validator: "simple_json"
 *   3. 运行时 getValidator("simple_json") 查表 → new SimpleJSONValidator(config)
 *
 * 添加新验证器的步骤：
 *   1. 创建新文件，继承 BaseValidator，实现 name 属性和 validate 方法
 *   2. 在本文件中 import 新验证器类
 *   3. 在 VALIDATORS 中添加一行注册：my_validator: MyValidator
 */

// BaseValidator 是所有验证器的抽象基类，定义了 validate() 和 name 两个抽象成员
// 导入后在本文件底部重新导出，方便外部模块统一从 validators/index.ts 导入
import { BaseValidator } from "./base.js";
// SimpleJSONValidator 只校验基础字段存在性（"页码"和"内容"），不验证内容结构
import { SimpleJSONValidator } from "./simple_json_validator.js";
// PDFPageValidator 在 SimpleJSONValidator 的基础上，额外验证段落编号连续性（"段落1"→"段落2"→...）
import { PDFPageValidator } from "./pdf_page_validator.js";

// ============================================================
// 验证器注册表
// ============================================================

/**
 * 验证器注册表：名称 → 验证器类 的映射
 *
 * 类型说明：
 *   Record<string, new (config: Record<string, unknown>) => BaseValidator>
 *   即 { [名称: string]: 构造函数 }
 *
 *   其中 `new (config: ...) => BaseValidator` 是 TS 的"构造签名"（construct signature），
 *   表示"可以用 new 调用、接受 config 参数、返回 BaseValidator 实例的类"。
 *   这样 VALIDATORS["simple_json"] 拿到的就是类本身（不是实例），可以 new 它。
 *
 * 使用示例：
 *   const Cls = VALIDATORS["simple_json"];  // → SimpleJSONValidator 类
 *   const v = new Cls({ strict: true });    // → SimpleJSONValidator 实例
 */
export const VALIDATORS: Record<string, new (config: Record<string, unknown>) => BaseValidator> = {
  simple_json: SimpleJSONValidator,
  pdf_page: PDFPageValidator,
};

// ============================================================
// 工厂函数
// ============================================================

/**
 * 根据名称获取验证器实例
 *
 * 这是外部调用验证器的唯一入口，封装了"查表 + 实例化"的过程。
 * 调用方无需知道具体的验证器类，只需传入 YAML 中配置的名称字符串。
 *
 * 使用示例：
 *   const v = getValidator("simple_json", { strict: true });
 *   v.validate(parsedData);  // 验证通过返回 true，失败抛出 Error
 *
 * @param name   验证器名称（在 YAML 配置中指定，如 "simple_json"）
 * @param config 验证器配置（可选），透传给验证器构造函数
 * @returns      BaseValidator 实例
 * @throws Error 验证器名称不存在时抛出，错误信息包含所有可用的验证器名称
 */
export function getValidator(
  name: string,
  config: Record<string, unknown> = {}
): BaseValidator {
  // 从注册表中查找对应的类
  const ValidatorClass = VALIDATORS[name];

  // 名称不在注册表中 → 给出友好的错误提示，列出所有可用选项
  if (!ValidatorClass) {
    const available = Object.keys(VALIDATORS).sort();
    throw new Error(
      `❌ 未知的验证器: '${name}'\n\n` +
        `【可用验证器】\n  ${available.join(", ")}\n\n` +
        `【使用方法】\n  在 YAML 配置中指定：\n` +
        `  validator: "${available[0] ?? "validator_name"}"`
    );
  }

  // 实例化并返回
  // 这就是"工厂模式"的核心价值：调用方只需传一个名称字符串，工厂负责查表并 new 出对应的对象。
  // 如果没有这个工厂函数，调用方就得自己 import 每个具体的验证器类，然后写 if/switch 判断该用哪个——
  // 每新增一个验证器，所有调用方的代码都要改。
  // 有了工厂函数后，新增验证器只需在 VALIDATORS 注册表里加一行，调用方代码完全不用动。
  return new ValidatorClass(config);
}

// 重新导出，方便外部模块统一从 "validators/index.ts" 导入
// 例如：import { BaseValidator, SimpleJSONValidator } from "./validators/index.js"
// 而不需要深入到 validators/base.js 或 validators/simple_json_validator.js
export { BaseValidator };
export { SimpleJSONValidator };
export { PDFPageValidator };
