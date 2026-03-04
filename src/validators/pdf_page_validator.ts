/**
 * PDF 页面 JSON 验证器
 *
 * 验证从 PDF 页面提取的 JSON 数据结构是否符合规范。
 *
 * 适用场景：
 * - 需要按自然段提取文字的工作流
 * - 需要验证段落编号连续性
 * - 严格的数据质量要求
 *
 * 验证规则：
 * 1. 数据必须是字典类型
 * 2. 必须包含"页码"和"内容"字段
 * 3. "页码"必须是字符串类型
 * 4. "内容"要么是字符串"kong"（表示空页面），要么是段落对象
 * 5. 段落对象的键名必须是"段落1"、"段落2"、"段落3"...（连续编号）
 * 6. 编号必须从1开始
 * 7. 编号不能跳号
 *
 * 设计理念：
 * - 分层验证：从外到内逐层检查
 * - 详细错误：每个错误都包含上下文信息
 * - 防御性：处理各种边界情况
 */

// BaseValidator 是所有验证器的抽象基类，提供 validate() 和 name 两个抽象成员
import { BaseValidator } from "./base.js";

/**
 * PDF 页面 JSON 验证器
 *
 * 验证从 PDF 页面提取的结构化数据，确保段落编号的连续性。
 *
 * 验证层级：
 * - 第1层：最外层结构验证（数据类型、必填字段）
 * - 第2层：内容类型验证（"kong" 或对象）
 * - 第3层：段落编号连续性验证
 *
 * 合法数据示例：
 *   // 正常页面（多段落）
 *   { "页码": "1", "内容": { "段落1": "第一段内容", "段落2": "第二段内容" } }
 *
 *   // 正常页面（单段落）
 *   { "页码": "5", "内容": { "段落1": "唯一的段落" } }
 *
 *   // 罗马数字页码
 *   { "页码": "iii", "内容": { "段落1": "前言内容" } }
 *
 *   // 空页面
 *   { "页码": "kong", "内容": "kong" }
 *
 * 非法数据示例：
 *   { "页码": "1" }                                       // 缺少"内容"
 *   { "页码": "1", "内容": { "段落1": "...", "段落3": "..." } }  // 段落跳号
 *   { "页码": "1", "内容": { "自然段1": "..." } }         // 键名格式错误
 */
export class PDFPageValidator extends BaseValidator {
  /**
   * 验证器名称，用于在 YAML 配置中引用
   *
   * YAML 中写 validator: "pdf_page" 就会匹配到这个验证器
   */
  get name(): string {
    return "pdf_page";
  }

  /**
   * 验证 PDF 页面 JSON 结构
   *
   * 验证流程：
   * 1. 验证最外层结构（必须是对象，包含必填字段）
   * 2. 验证内容类型（"kong" 或对象）
   * 3. 如果是对象，验证段落编号连续性
   *
   * @param data 解析后的 JSON 数据
   * @returns 验证通过返回 true
   * @throws Error 验证失败，包含详细错误信息
   */
  validate(data: unknown): boolean {
    // 第1层：验证最外层结构（类型、必填字段、字段类型）
    this._validateStructure(data);

    // 经过 _validateStructure 后，data 一定是包含"页码"和"内容"的对象
    const obj = data as Record<string, unknown>;
    const content = obj["内容"];

    // 第2层：如果内容是 "kong"，说明是空页面，直接通过
    if (content === "kong") {
      console.debug(`✓ PDF 页面验证通过（空页面，页码: ${obj["页码"]}）`);
      return true;
    }

    // 第3层：验证段落结构（键名格式、编号连续性）
    this._validateParagraphs(content, obj);

    // 统计段落数，输出调试日志
    const paragraphCount = Object.keys(
      content as Record<string, unknown>
    ).length;
    console.debug(
      `✓ PDF 页面验证通过 (页码: ${obj["页码"]}, ${paragraphCount} 个段落)`
    );
    return true;
  }

  /**
   * 验证最外层结构（私有方法）
   *
   * 检查项：
   * 1. 数据类型必须是对象（不能是数组、null、基本类型）
   * 2. 必须包含"页码"字段
   * 3. 必须包含"内容"字段
   * 4. "页码"字段必须是字符串类型
   *
   * @param data 要验证的数据
   * @throws Error 结构不符合要求
   */
  private _validateStructure(data: unknown): void {
    // 检查1：数据类型必须是对象
    // typeof null === "object"，所以要额外排除 null
    // Array.isArray 排除数组（数组的 typeof 也是 "object"）
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      // 获取实际类型名称，区分 null 和 array
      const actualType = Array.isArray(data)
        ? "array"
        : data === null
          ? "null"
          : typeof data;
      const repr = JSON.stringify(data);
      // 截断过长的数据，避免错误信息过于冗长
      const truncated = repr.length > 200 ? repr.slice(0, 200) + "..." : repr;
      throw new Error(
        `❌ 数据必须是对象类型\n` +
          `\n` +
          `【实际类型】\n` +
          `  ${actualType}\n` +
          `\n` +
          `【实际数据】\n` +
          `  ${truncated}\n` +
          `\n` +
          `【期望格式】\n` +
          `  {"页码": "1", "内容": {"段落1": "..."}}\n` +
          `\n` +
          `【修复建议】\n` +
          `  确保返回的是 JSON 对象（使用花括号 {}）`
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
          `  {"页码": "1", "内容": {...}}\n` +
          `\n` +
          `【修复建议】\n` +
          `  添加 "页码" 字段`
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
          `  {"页码": "1", "内容": {"段落1": "..."}}\n` +
          `  或（空页面）：{"页码": "kong", "内容": "kong"}\n` +
          `\n` +
          `【修复建议】\n` +
          `  添加 "内容" 字段`
      );
    }

    // 检查4："页码"必须是字符串类型
    // 页码用字符串是因为可能是罗马数字（如 "iii"）或特殊标记（如 "kong"）
    if (typeof obj["页码"] !== "string") {
      throw new Error(
        `❌ 字段'页码'必须是字符串类型\n` +
          `\n` +
          `【实际类型】\n` +
          `  ${typeof obj["页码"]}\n` +
          `\n` +
          `【实际值】\n` +
          `  ${JSON.stringify(obj["页码"])}\n` +
          `\n` +
          `【修复建议】\n` +
          `  将页码改为字符串，例如 "1" 而不是 1`
      );
    }
  }

  /**
   * 验证段落结构（私有方法）
   *
   * 检查项：
   * 1. 内容必须是对象类型（非 "kong" 的情况下）
   * 2. 段落键名必须是 "段落1", "段落2", "段落3" ...
   * 3. 编号必须从 1 开始
   * 4. 编号必须连续（不能跳号）
   *
   * @param content  内容字段（段落对象）
   * @param fullData 完整的数据（用于错误报告时展示上下文）
   * @throws Error 段落结构不符合要求
   */
  private _validateParagraphs(
    content: unknown,
    fullData: Record<string, unknown>
  ): void {
    // 检查：内容必须是对象（不是 "kong" 时只能是 { "段落1": ..., "段落2": ... } 格式）
    if (typeof content !== "object" || content === null || Array.isArray(content)) {
      const repr = JSON.stringify(content);
      const truncated = repr.length > 100 ? repr.slice(0, 100) + "..." : repr;
      throw new Error(
        `❌ 字段'内容'必须是字符串'kong'或对象\n` +
          `\n` +
          `【实际类型】\n` +
          `  ${Array.isArray(content) ? "array" : content === null ? "null" : typeof content}\n` +
          `\n` +
          `【实际值】\n` +
          `  ${truncated}\n` +
          `\n` +
          `【允许的格式】\n` +
          `  1. 空页面: "kong"\n` +
          `  2. 有内容: {"段落1": "...", "段落2": "..."}\n` +
          `\n` +
          `【完整数据】\n` +
          `${JSON.stringify(fullData, null, 2)}`
      );
    }

    const contentObj = content as Record<string, unknown>;
    const keys = Object.keys(contentObj);

    // 处理空对象——空页面应该用 "kong" 而不是 {}，但不算致命错误，给个警告就行
    if (keys.length === 0) {
      console.warn(
        "⚠️ 内容为空对象\n" +
          "   建议：空页面应使用字符串 'kong' 而不是空对象 {}"
      );
      return;
    }

    // 逐个检查段落键名：期望 "段落1", "段落2", "段落3" ...
    // index 从 0 开始遍历数组，但期望的段落编号从 1 开始，所以 expectedKey = `段落${index + 1}`
    for (let index = 0; index < keys.length; index++) {
      const expectedKey = `段落${index + 1}`;
      const actualKey = keys[index]!;

      if (actualKey !== expectedKey) {
        // 段落编号不匹配，构建详细的错误报告
        const errorLines: string[] = [
          "❌ 段落编号不连续或格式错误！",
          "",
          "【错误位置】",
          `  第 ${index + 1} 个段落`,
          "",
          "【期望】",
          `  键名: '${expectedKey}'`,
          "",
          "【实际】",
          `  键名: '${actualKey}'`,
          "",
          "【所有段落键】",
          `  ${JSON.stringify(keys)}`,
          "",
          "【编号规则】",
          "  1. 从'段落1'开始",
          "  2. 依次递增：段落1 → 段落2 → 段落3 ...",
          "  3. 不能跳号（如不能：段落1 → 段落3）",
          "  4. 必须是阿拉伯数字",
          "  5. 不能重复",
          "",
          "【修复建议】",
        ];

        // 根据具体的键名错误类型，给出更精准的修复建议
        if (actualKey.startsWith("段落")) {
          // 键名以"段落"开头，说明格式对了但编号有问题
          const numStr = actualKey.slice(2); // "段落" 是2个字符，取后面的数字部分
          const num = parseInt(numStr, 10);
          if (!isNaN(num)) {
            // 成功解析出数字
            if (num > index + 1) {
              // 实际编号比期望的大 → 中间跳号了
              errorLines.push(`  缺少了 '${expectedKey}'，请补充`);
            } else if (num < index + 1) {
              // 实际编号比期望的小 → 重复或顺序错误
              errorLines.push(`  '${actualKey}' 重复或顺序错误`);
            } else {
              errorLines.push(`  检查段落编号是否正确`);
            }
          } else {
            // "段落" 后面跟的不是数字，比如 "段落一"、"段落abc"
            errorLines.push(
              `  段落编号必须是数字，不能是 '${numStr}'`
            );
          }
        } else {
          // 键名格式完全不对，比如 "自然段1"、"paragraph1"
          errorLines.push(
            `  键名必须是 '段落N' 格式，不能是 '${actualKey}'`
          );
        }

        // 附上完整数据，方便调试
        errorLines.push("", "【完整数据】");
        errorLines.push(JSON.stringify(fullData, null, 2));

        throw new Error(errorLines.join("\n"));
      }
    }
  }
}
