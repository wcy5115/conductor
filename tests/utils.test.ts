/**
 * utils.ts 单元测试
 *
 * 测试 src/utils.ts 中的纯工具函数：
 * - getImageMimeType()：根据扩展名返回 MIME 类型
 * - validateAndCleanJson()：清理并解析 LLM 返回的 JSON 文本
 * - saveToFile()：保存内容到文件
 * - imageToBase64()：将图片文件转换为 Base64 编码
 *
 * 未覆盖的函数：
 * - processMessagesWithImages()：涉及多模态消息结构和文件 I/O，待补充
 * - escapeControlChars() / fixInvalidEscapes()：内部辅助函数，
 *   通过 validateAndCleanJson 的测试间接覆盖了部分场景
 */

// ---- 测试框架 API ----
// describe：将相关用例分组，便于组织和阅读测试报告
// it：定义单个测试用例（别名 test），描述"它应该做什么"
// expect：创建断言，配合 .toBe() / .toEqual() / .toThrow() 等匹配器验证结果
// afterAll：注册一个回调，在当前 describe 块的所有测试跑完后执行一次（用于清理）
import { describe, it, expect, afterAll } from "vitest";

// fs（File System）是 Node.js 内置的文件系统模块
// 这里用到：existsSync（检查路径是否存在）、rmSync（递归删除目录）、
//           mkdirSync（创建目录）、writeFileSync（写文件）、readFileSync（读文件）
import * as fs from "fs";

// path 是 Node.js 内置的路径处理模块
// 这里用到：path.join（拼接路径片段）、path.dirname（取文件所在目录）
import * as path from "path";

// ---- 被测函数 ----
// 从 src/utils.ts 导入 4 个需要测试的公共函数
import {
  getImageMimeType,
  validateAndCleanJson,
  saveToFile,
  imageToBase64,
} from "../src/utils";

// 临时测试目录的绝对路径
// __dirname 是当前文件所在目录（即 tests/），拼接后得到 tests/_tmp_test_utils/
// 所有测试产生的文件都放在这里，与项目其他文件隔离，测试结束后统一清理
const TEST_TMP_DIR = path.join(__dirname, "_tmp_test_utils");

// afterAll 在所有测试跑完后执行一次清理：
// 第一步：检查临时目录是否存在（首次运行前目录可能不存在，直接删会报错）
// 第二步：递归删除整个目录及其内容，force: true 忽略不存在的文件（防御性写法）
afterAll(() => {
  if (fs.existsSync(TEST_TMP_DIR)) {
    fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true });
  }
});

// ============================================================
// getImageMimeType() 测试
// ============================================================
// 源码逻辑（utils.ts:77-90）：
//   1. path.extname() 取扩展名 → 2. .toLowerCase() 转小写 → 3. 查 mimeTypes 映射表
//   4. 查不到则用 ?? 运算符回退到 "image/jpeg"
describe("getImageMimeType", () => {
  // 覆盖目标：mimeTypes 映射表中注册的全部 6 种扩展名
  // 确保每种扩展名都映射到正确的 MIME 类型字符串
  //
  // 输入 → 输出 对照：
  //   "photo.png"  → "image/png"
  //   "photo.jpg"  → "image/jpeg"
  //   "photo.jpeg" → "image/jpeg"   （.jpg 和 .jpeg 都映射到 image/jpeg）
  //   "photo.webp" → "image/webp"
  //   "photo.bmp"  → "image/bmp"
  //   "photo.gif"  → "image/gif"
  it("常见扩展名返回正确 MIME 类型", () => {
    expect(getImageMimeType("photo.png")).toBe("image/png");
    expect(getImageMimeType("photo.jpg")).toBe("image/jpeg");
    expect(getImageMimeType("photo.jpeg")).toBe("image/jpeg");
    expect(getImageMimeType("photo.webp")).toBe("image/webp");
    expect(getImageMimeType("photo.bmp")).toBe("image/bmp");
    expect(getImageMimeType("photo.gif")).toBe("image/gif");
  });

  // 覆盖目标：源码中 .toLowerCase() 这一步
  // 用户传入的文件名可能来自 Windows（全大写）或混合大小写，都应正确识别
  //
  // 输入 → 输出 对照：
  //   "photo.PNG"  → "image/png"    （全大写）
  //   "photo.JPG"  → "image/jpeg"   （全大写）
  //   "photo.Webp" → "image/webp"   （首字母大写）
  it("大小写不敏感", () => {
    expect(getImageMimeType("photo.PNG")).toBe("image/png");
    expect(getImageMimeType("photo.JPG")).toBe("image/jpeg");
    expect(getImageMimeType("photo.Webp")).toBe("image/webp");
  });

  // 覆盖目标：?? "image/jpeg" 空值合并兜底逻辑
  // 当 mimeTypes[suffix] 返回 undefined 时，函数应返回默认值 "image/jpeg"
  //
  // 测试数据选择理由：
  //   "file.tiff" — 真实存在但未注册的图片格式
  //   "file.svg"  — 矢量图格式，不在位图映射表中
  //   "file"      — 无扩展名，path.extname() 返回空字符串 ""，映射表中也没有 "" 键
  it("未知扩展名默认返回 image/jpeg", () => {
    expect(getImageMimeType("file.tiff")).toBe("image/jpeg");
    expect(getImageMimeType("file.svg")).toBe("image/jpeg");
    expect(getImageMimeType("file")).toBe("image/jpeg");
  });
});

// ============================================================
// validateAndCleanJson() 测试
// ============================================================
// 源码逻辑（utils.ts:240-288）是一个 7 步流水线：
//   1. typeof 检查 → 2. trim() → 3. 去 Markdown 代码块 → 4. 正则提取 JSON 片段
//   5. escapeControlChars() 转义控制字符 → 6. fixInvalidEscapes() 修复非法转义
//   7. JSON.parse()
//
// 这个函数是专门为处理 LLM 输出设计的：LLM 返回的文本经常不是纯净 JSON，
// 可能被 Markdown 代码块包裹、前后带解释文字、内含非法控制字符等
describe("validateAndCleanJson", () => {
  // 覆盖目标：第 7 步 JSON.parse() 的最基本 happy path
  // 输入已经是合法 JSON，前 6 步都不需要做任何修改，直接解析即可
  //
  // 输入：  '{"name": "test", "value": 42}'
  // 输出：  { name: "test", value: 42 }
  it("解析正常 JSON 字符串", () => {
    const result = validateAndCleanJson('{"name": "test", "value": 42}');
    expect(result).toEqual({ name: "test", value: 42 });
  });

  // 覆盖目标：返回类型的 unknown[] 分支
  // validateAndCleanJson 的返回类型是 Record<string, unknown> | unknown[]
  // 此用例验证当输入是 JSON 数组时也能正确解析
  //
  // 输入：  '[1, 2, 3]'
  // 输出：  [1, 2, 3]
  it("解析 JSON 数组", () => {
    const result = validateAndCleanJson("[1, 2, 3]");
    expect(result).toEqual([1, 2, 3]);
  });

  // 覆盖目标：第 3 步——去除 Markdown 代码块标记
  // LLM 常用 ```json ... ``` 包裹 JSON 输出（尤其是 ChatGPT 和 Claude）
  // 源码用正则 /```(?:json)?\s*\n(.*?)\n```/is 提取代码块内部内容
  //
  // 输入（清洗前）：
  //   ```json
  //   {"key": "value"}
  //   ```
  //
  // 清洗后传给 JSON.parse 的内容：
  //   {"key": "value"}
  it("提取 markdown 代码块中的 JSON", () => {
    const input = '```json\n{"key": "value"}\n```';
    expect(validateAndCleanJson(input)).toEqual({ key: "value" });
  });

  // 覆盖目标：第 4 步——从垃圾文本中提取 JSON 片段
  // LLM 可能在 JSON 前后添加自然语言解释（如 "以下是结果：{...} 希望对你有帮助"）
  // 源码用正则 /[{[].*[}\]]/s 找到第一个 { 到最后一个 } 之间的内容
  //
  // 输入（清洗前）：
  //   "这是一些垃圾文本 {"key": "value"} 后面也有垃圾"
  //
  // 正则提取后：
  //   {"key": "value"}
  it("提取前后有垃圾文本的 JSON", () => {
    const input = '这是一些垃圾文本 {"key": "value"} 后面也有垃圾';
    expect(validateAndCleanJson(input)).toEqual({ key: "value" });
  });

  // 覆盖目标：第 5 步——escapeControlChars() 转义字符串内部的控制字符
  // JSON 规范禁止字符串值中出现真实的控制字符（码点 < 0x20），
  // 但 LLM 输出可能包含真实的换行符 \n 和制表符 \t（不是转义序列，是实际字符）
  //
  // escapeControlChars() 会逐字符扫描，仅在双引号内部：
  //   真实换行符（0x0A）→ 转义序列 \\n
  //   真实制表符（0x09）→ 转义序列 \\t
  // 这样 JSON.parse() 就能正确解析了
  //
  // 输入：  '{"text": "line1\nline2\ttab"}'  （\n \t 是真实的控制字符）
  // 输出：  { text: "line1\nline2\ttab" }     （解析后字符串值包含换行和制表）
  it("处理包含控制字符的 JSON", () => {
    const input = '{"text": "line1\nline2\ttab"}';
    const result = validateAndCleanJson(input) as Record<string, unknown>;
    expect(result.text).toBe("line1\nline2\ttab");
  });

  // 覆盖目标：第 2 步——trim() 后检查空字符串并抛异常
  // 空输入没有任何可解析的内容，应尽早失败并给出明确错误信息
  //
  // ""    → trim 后仍为 ""  → 抛 "输入文本为空"
  // "   " → trim 后变为 ""  → 抛 "输入文本为空"
  it("空字符串抛异常", () => {
    expect(() => validateAndCleanJson("")).toThrow("输入文本为空");
    expect(() => validateAndCleanJson("   ")).toThrow("输入文本为空");
  });

  // 覆盖目标：第 7 步——JSON.parse() 失败时抛异常
  // 经过前 6 步清洗后仍然不是合法 JSON 的内容，应该抛出解析错误
  //
  // "{invalid}"        — 花括号内不是合法的 key:value 格式
  // "not json at all"  — 完全不含 JSON 结构（第 4 步正则也提取不到）
  it("无效 JSON 抛异常", () => {
    expect(() => validateAndCleanJson("{invalid}")).toThrow();
    expect(() => validateAndCleanJson("not json at all")).toThrow();
  });
});

// ============================================================
// saveToFile() 测试
// ============================================================
// 源码逻辑（utils.ts:26-36）：
//   第一步：mkdirSync({ recursive: true }) 确保目标文件的父目录存在
//          recursive: true 表示自动创建所有缺失的中间目录（类似 mkdir -p）
//   第二步：writeFileSync(filepath, content, "utf-8") 将字符串写入文件
describe("saveToFile", () => {
  // 覆盖目标：最基本的写入 + 读取验证
  // 调用 saveToFile 写入内容，再用 fs.readFileSync 独立读回来对比
  // 这样确保文件确实被创建了，且内容与传入的完全一致
  //
  // 输入：  filePath = "tests/_tmp_test_utils/test_save.txt", content = "hello world"
  // 预期：  读取该文件得到 "hello world"
  it("写入文件并验证内容", () => {
    const filePath = path.join(TEST_TMP_DIR, "test_save.txt");
    saveToFile(filePath, "hello world");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("hello world");
  });

  // 覆盖目标：mkdirSync 的 recursive: true 参数
  // 当路径包含多层不存在的目录时（如 nested/deep/），应自动创建所有中间目录
  // 如果没有 recursive: true，mkdirSync 在父目录不存在时会抛 ENOENT 错误
  //
  // 输入：  filePath = "tests/_tmp_test_utils/nested/deep/file.txt"
  //         nested/ 和 deep/ 两层目录都不存在
  // 预期：  自动创建目录链并写入文件，读取得到 "nested content"
  it("自动创建嵌套目录", () => {
    const filePath = path.join(TEST_TMP_DIR, "nested", "deep", "file.txt");
    saveToFile(filePath, "nested content");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("nested content");
  });
});

// ============================================================
// imageToBase64() 测试
// ============================================================
// 源码逻辑（utils.ts:49-69）：
//   第一步：fs.existsSync() 检查文件是否存在，不存在则抛 "图片文件不存在"
//   第二步：fs.readFileSync() 读取文件的原始二进制内容（返回 Buffer）
//   第三步：.toString("base64") 将 Buffer 编码为 Base64 字符串
//   第四步：检查编码结果非空后返回
describe("imageToBase64", () => {
  // 覆盖目标：第一步的 existsSync 检查 + 抛异常分支
  // 传入一个必定不存在的路径，验证函数抛出包含 "图片文件不存在" 的错误
  // 这个检查很重要：如果没有这步，readFileSync 会抛出晦涩的 ENOENT 系统错误，
  // 而自定义错误信息对调用者更友好
  it("不存在的文件路径抛异常", () => {
    expect(() => imageToBase64("/nonexistent/path/image.png")).toThrow(
      "图片文件不存在",
    );
  });

  // 覆盖目标：第二步 readFileSync + 第三步 toString("base64") 的完整流程
  //
  // 测试策略：
  //   1. 手动创建一个临时文件，写入已知内容 "fake image data for testing"
  //   2. 调用 imageToBase64() 获取 Base64 编码结果
  //   3. 用 Buffer.from(result, "base64").toString() 将 Base64 解码回原始字符串
  //   4. 对比解码后的字符串与原始内容是否一致
  //
  // 为什么不用真实图片：测试关注的是编解码逻辑的正确性，
  // 用纯文本更容易验证（可以直接字符串比较），真实图片只会增加测试复杂度
  //
  // 输入：  文件内容 = "fake image data for testing"
  // 中间值：Base64 = "ZmFrZSBpbWFnZSBkYXRhIGZvciB0ZXN0aW5n"
  // 验证：  解码后 = "fake image data for testing"（与原始内容一致）
  it("正常读取文件并返回 Base64 字符串", () => {
    // 构造临时文件路径，放在统一的测试临时目录下
    const filePath = path.join(TEST_TMP_DIR, "test_image.bin");
    // 确保目录存在（saveToFile 的测试可能还没跑，目录可能不存在）
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // 用 Buffer.from() 创建二进制内容（模拟图片文件的原始字节）
    const content = Buffer.from("fake image data for testing");
    // 写入临时文件
    fs.writeFileSync(filePath, content);

    const result = imageToBase64(filePath);
    // 验证：Base64 解码后应与原始内容一致（往返测试 / round-trip test）
    expect(Buffer.from(result, "base64").toString()).toBe(
      "fake image data for testing",
    );
  });
});
