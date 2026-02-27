/**
 * 验证器基类
 *
 * 定义所有验证器必须实现的接口，确保验证器的一致性和可扩展性。
 *
 * 设计理念：
 * - 单一职责：每个验证器只验证一种数据结构
 * - 接口统一：所有验证器实现相同的接口
 * - 错误详细：验证失败时提供清晰的错误信息
 */

/**
 * 验证器基类（抽象类）
 *
 * 所有自定义验证器必须继承此类并实现 validate 方法和 name 属性。
 *
 * 使用示例：
 *   class MyValidator extends BaseValidator {
 *     get name() { return "my_validator"; }
 *     validate(data: unknown): boolean {
 *       if (typeof data !== "object" || data === null || Array.isArray(data)) {
 *         throw new Error("数据必须是字典");
 *       }
 *       return true;
 *     }
 *   }
 *
 *   const validator = new MyValidator();
 *   validator.validate({ key: "value" }); // true
 */
export abstract class BaseValidator {
  readonly config: Record<string, unknown>;

  /**
   * 初始化验证器
   *
   * @param config 验证器配置字典（来自 YAML 的 validator_config）
   *               可以包含任意配置参数，由具体验证器自行解释和使用
   *
   * 配置示例：
   *   validator_config:
   *     strict_mode: true       # 严格模式
   *     max_paragraphs: 100     # 最大段落数
   *     allow_empty: false      # 是否允许空对象
   */
  constructor(config: Record<string, unknown> = {}) {
    this.config = config;
  }

  /**
   * 验证器名称（抽象属性，子类必须实现）
   *
   * 返回验证器的唯一标识符，用于在 YAML 配置中引用。
   * 命名规范：小写字母，多个单词用下划线分隔，简洁明了。
   *
   * 命名示例：
   *   - "pdf_page"    # PDF 页面
   *   - "simple_json" # 简单 JSON
   *   - "chapter"     # 章节
   *   - "table_data"  # 表格数据
   */
  abstract get name(): string;

  /**
   * 验证数据（抽象方法，子类必须实现）
   *
   * @param data 要验证的数据（通常是解析后的 JSON 对象）
   * @returns 验证通过必须返回 true
   * @throws Error 验证失败时必须抛出此异常，信息应包含详细的错误描述
   *
   * 实现要求：
   *   1. 验证失败时必须抛出 Error（不要返回 false）
   *   2. 错误信息要详细，格式建议：❌ 标记错误 / 期望 / 实际 / 修复建议
   *   3. 验证通过时返回 true
   */
  abstract validate(data: unknown): boolean;

  toString(): string {
    return `<${this.constructor.name}(name='${this.name}')>`;
  }
}
