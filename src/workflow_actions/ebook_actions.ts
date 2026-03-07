/**
 * 电子书翻译 Action 集合
 *
 * 本模块包含 3 个辅助函数和 3 个 Action 类，用于实现电子书翻译工作流：
 *   辅助函数：
 *     - calculateTokens —— 简易 token 估算（中文字符计 1，英文单词计 2）
 *     - forceTruncateAtTarget —— 按 token 数强制截断文本
 *     - splitBySentences —— 智能切分：按标点断句 + token 感知累积
 *
 *   Action 类：
 *     - EpubExtractAction —— 读取 ePub 文件，提取文本并按 token 数智能切分为块
 *     - MergeToEpubAction —— 将翻译后的对齐文本合并生成新 ePub + TXT
 *     - ParseTranslationAction —— 解析 LLM 翻译响应中的 ###SEGMENT### 格式
 *
 * 迁移自 Python 版 LLM_agent/src/workflow_actions/ebook_actions.py
 */

// fs 是 Node.js 内置的文件系统模块，这里用于读取对齐文件、写入 TXT 文件、创建目录等操作
import fs from "fs";
// path 是 Node.js 内置的路径处理模块，用于拼接输出文件路径、提取目录名
import path from "path";
// EPub 是 epub 包的核心类，用于解析 ePub 文件
// 原理：读取 .epub（本质上是 ZIP 包），解析内部 XML 元数据和 XHTML 内容文件
// flow 属性包含所有章节的清单项（ManifestItem），通过 getChapter(id) 获取章节 HTML
import { EPub } from "epub";
// cheerio 是服务端 jQuery 替代品，用于从 HTML 中提取纯文本
// 等价于 Python 的 BeautifulSoup：load(html) 解析 HTML，然后 .text() 提取纯文本
import * as cheerio from "cheerio";
// WorkflowContext 是工作流的全局上下文对象，包含 data（共享数据）、history（执行历史）等
// StepResult 是每个步骤执行完毕后的返回值，包含 nextStep（下一步）、data（数据）、metadata（元数据）
import { WorkflowContext, StepResult } from "../workflow_engine.js";
// BaseAction 是所有工作流动作的基类，提供 run() 方法（模板方法模式）
import { BaseAction } from "./base.js";

// nodepub 是 CommonJS 模块且没有类型定义，需要用 require 导入并手动声明接口
// 用于创建新的 ePub 文件（写入），与 epub 包（读取）配合使用
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodepub = require("nodepub");

/**
 * nodepub 文档对象接口（手动声明）
 *
 * nodepub 是纯 JS 库，没有自带 TypeScript 类型定义。
 * 这里根据 nodepub 源码和文档，手动声明我们用到的方法签名。
 *
 * nodepub.document(metadata) 返回此接口的实例。
 */
interface NodepubDocument {
  /** 添加一个章节（section）到 ePub 中 */
  addSection: (
    title: string,       // 章节标题
    content: string,     // 章节 HTML 内容
    excludeFromContents?: boolean,  // 是否从目录中排除
    isFrontMatter?: boolean,        // 是否为前言（出现在目录之前）
    overrideFilename?: string       // 自定义内部文件名（不含扩展名）
  ) => void;
  /** 写入 ePub 文件到指定目录，文件名不含 .epub 后缀 */
  writeEPUB: (folder: string, filename: string) => Promise<void>;
}

/**
 * 简易日志器
 *
 * 与 base.ts 保持一致的最小化日志方案，避免引入复杂依赖。
 */
const logger = {
  info: (msg: string) => console.info(msg),
  error: (msg: string) => console.error(msg),
  warn: (msg: string) => console.warn(msg),
};

// ============================================================
// 辅助函数（仅本模块内部使用）
// ============================================================

/**
 * 简易 token 估算
 *
 * 不使用真正的 tokenizer（如 tiktoken），而是用简单的启发式规则估算 token 数：
 *   - 中文字符（\u4e00-\u9fff）：每个字符计 1 个 token
 *   - 英文单词（\b[a-zA-Z]+\b）：每个单词计 2 个 token
 *
 * 这个估算方式粗略但速度快，适合用于文本切分时的大致控制。
 * 实际 token 数取决于具体模型的 tokenizer，但对于切分来说够用了。
 *
 * 示例：
 *   calculateTokens("你好世界")        → 4（4 个中文字符 × 1）
 *   calculateTokens("hello world")    → 4（2 个英文单词 × 2）
 *   calculateTokens("你好 hello")     → 4（2 个中文字符 × 1 + 1 个英文单词 × 2）
 *   calculateTokens("")               → 0
 *
 * @param text 要估算的文本
 * @returns 估算的 token 数
 */
function calculateTokens(text: string): number {
  if (!text) return 0;

  // 正则 [\u4e00-\u9fff] 匹配 CJK 统一表意文字区间（基本汉字）
  // \u4e00 是"一"，\u9fff 是"鿿"，覆盖了绝大多数常用汉字
  const chineseChars = (text.match(/[\u4e00-\u9fff]/gu) || []).length;

  // 正则 \b[a-zA-Z]+\b 匹配由英文字母组成的完整单词
  // \b 是单词边界锚点，确保匹配完整单词而非部分子串
  const englishWords = (text.match(/\b[a-zA-Z]+\b/gu) || []).length;

  return chineseChars + englishWords * 2;
}

/**
 * 按 token 数强制截断文本
 *
 * 逐字符遍历文本，累加每个字符的 token 数，当超出目标值时截断。
 * 返回 [head, tail] 二元组：head 是目标长度以内的前半部分，tail 是剩余部分。
 *
 * 如果整段文本的 token 数未超过 target，则 head = 整段文本，tail = 空字符串。
 *
 * 示例：
 *   forceTruncateAtTarget("你好世界测试", 3) → ["你好世", "界测试"]
 *   forceTruncateAtTarget("hi", 100)        → ["hi", ""]
 *
 * @param text 要截断的文本
 * @param targetTokens 目标 token 数上限
 * @returns [前半段, 后半段] 的二元组
 */
function forceTruncateAtTarget(
  text: string,
  targetTokens: number
): [string, string] {
  // 快速判断：整段文本未超限，直接返回
  if (calculateTokens(text) <= targetTokens) {
    return [text, ""];
  }

  // 逐字符累加 token 数，找到截断位置
  let currentTokens = 0;
  for (let i = 0; i < text.length; i++) {
    const charTokens = calculateTokens(text[i]!);
    // 如果加上当前字符会超出目标，就在这里截断
    if (currentTokens + charTokens > targetTokens) {
      return [text.slice(0, i), text.slice(i)];
    }
    currentTokens += charTokens;
  }

  // 理论上走不到这里（前面已判断整段未超限的情况），保险起见返回整段
  return [text, ""];
}

/**
 * 智能切分：按标点断句 + token 感知累积
 *
 * 工作流程：
 *   1. 先按中英文句末标点（。！？.?!）将文本拆分为句子
 *   2. 逐句累积 token 数，当累积到 targetTokens 时切出一个块
 *   3. 如果累积量超过 emergencyThreshold（紧急阈值），
 *      触发强制截断模式（调用 forceTruncateAtTarget），避免单个块过长
 *
 * 设计意图：
 *   - targetTokens 是"理想块大小"，尽量在句子边界处切分
 *   - emergencyThreshold 是"安全上限"，超过时不再等句子结束，直接截断
 *   - 这样既保证了语义完整性（在句子边界切），又避免了超长块
 *
 * 示例：
 *   splitBySentences("第一句。第二句。第三句。", 5, 10)
 *   → 根据每句的 token 数，可能返回 ["第一句。第二句。", "第三句。"]
 *
 * @param fullText 要切分的完整文本
 * @param targetTokens 每个块的理想 token 数
 * @param emergencyThreshold 强制截断的紧急阈值
 * @returns 切分后的文本块数组
 */
function splitBySentences(
  fullText: string,
  targetTokens: number,
  emergencyThreshold: number
): string[] {
  // 正则匹配中英文句末标点，使用捕获组 () 让 split 保留分隔符
  // 例如 "你好。世界！" 会被拆分为 ["你好", "。", "世界", "！"]
  const SENTENCE_ENDINGS = /([。！？.?!])/;
  const sentences = fullText.split(SENTENCE_ENDINGS);

  // 将标点与前面的句子重新合并
  // sentences[0::2] 是句子内容，sentences[1::2] 是标点
  // zip 后得到 ["你好。", "世界！"]
  let parts: string[];
  if (sentences.length <= 1) {
    // 没有找到标点分隔符，整段作为一个 part
    parts = [fullText];
  } else {
    parts = [];
    // 每两个元素配对：sentences[0]+sentences[1], sentences[2]+sentences[3], ...
    for (let i = 0; i < sentences.length - 1; i += 2) {
      parts.push((sentences[i] ?? "") + (sentences[i + 1] ?? ""));
    }
    // 如果 sentences 数量为奇数，最后一个元素没有配对的标点，单独追加
    if (sentences.length % 2 !== 0) {
      parts.push(sentences[sentences.length - 1] ?? "");
    }
  }

  // 逐句累积，达到目标 token 数时切出一个块
  const finalChunks: string[] = [];
  let currentChunkParts: string[] = [];
  let currentTokens = 0;

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const partTokens = calculateTokens(trimmed);

    // 紧急模式：当前累积量已达到或即将达到紧急阈值
    // 此时不再等待句子边界，直接强制截断
    if (
      currentTokens >= emergencyThreshold ||
      currentTokens + partTokens >= emergencyThreshold
    ) {
      currentChunkParts.push(trimmed);
      const superChunk = currentChunkParts.join("");

      // 循环截断：将超长文本反复截断为 targetTokens 大小的块
      let processingChunk = superChunk;
      while (calculateTokens(processingChunk) > 0) {
        const [head, tail] = forceTruncateAtTarget(
          processingChunk,
          targetTokens
        );
        if (head) {
          finalChunks.push(head);
        }
        processingChunk = tail;
      }

      // 重置累积器
      currentChunkParts = [];
      currentTokens = 0;
      continue;
    }

    // 正常模式：如果加上当前句子会超出目标，先切出当前块，再开始新块
    if (currentTokens + partTokens > targetTokens && currentChunkParts.length > 0) {
      finalChunks.push(currentChunkParts.join(""));
      currentChunkParts = [trimmed];
      currentTokens = partTokens;
    } else {
      // 未超出目标，继续累积
      currentChunkParts.push(trimmed);
      currentTokens += partTokens;
    }
  }

  // 收尾：将最后一段残余的累积内容作为最后一个块
  if (currentChunkParts.length > 0) {
    finalChunks.push(currentChunkParts.join(""));
  }

  return finalChunks;
}

// ============================================================
// EpubExtractAction — 从 ePub 提取文本并按段落切分
// ============================================================

/**
 * 从 ePub 提取文本并按段落切分
 *
 * 工作流程：
 *   1. 读取 ePub 文件（使用 epub 包解析 ZIP 内部结构）
 *   2. 遍历所有章节（flow），用 cheerio 从 HTML 中提取纯文本
 *   3. 合并所有章节文本
 *   4. 使用 splitBySentences 智能切分为合适大小的块
 *   5. 输出带序号的文本块列表
 *
 * 输入：context.data[inputKey] — ePub 文件路径
 * 输出：context.data[outputKey] — 文本块列表，每个块是 { index: number, text: string }
 *
 * 示例输出：
 *   [
 *     { index: 1, text: "第一章的内容..." },
 *     { index: 2, text: "第二章的内容..." }
 *   ]
 */
export class EpubExtractAction extends BaseAction {
  // inputKey：从 context.data 中取 ePub 文件路径的键名
  private readonly inputKey: string;
  // outputKey：切分后的文本块列表存入 context.data 的键名
  private readonly outputKey: string;
  // targetTokens：每个文本块的理想 token 数（传给 splitBySentences）
  private readonly targetTokens: number;
  // emergencyThreshold：强制截断的紧急阈值（传给 splitBySentences）
  private readonly emergencyThreshold: number;
  // nextStep：执行完毕后跳转到的下一步 ID
  private readonly nextStep: string;
  // saveToFile：可选的断点续传配置
  // 如果配置了该字段，提取后的文本块会保存到文件，下次运行时直接从文件恢复跳过 ePub 解析
  // 配置格式：{ output_dir: "data/{project}/original", filename_template: "chunk_{index:04d}.txt" }
  private readonly saveToFile?: { output_dir: string; filename_template?: string };

  constructor(
    inputKey: string = "input_epub",
    outputKey: string = "chunks",
    targetTokens: number = 1000,
    emergencyThreshold: number = 1500,
    nextStep: string = "2",
    name: string = "提取并切分文本",
    saveToFile?: { output_dir: string; filename_template?: string },
    config: Record<string, unknown> = {}
  ) {
    super(name, config);
    this.inputKey = inputKey;
    this.outputKey = outputKey;
    this.targetTokens = targetTokens;
    this.emergencyThreshold = emergencyThreshold;
    this.nextStep = nextStep;
    this.saveToFile = saveToFile;
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    // 第一步：从上下文获取 ePub 文件路径
    const epubPath = context.data[this.inputKey] as string | undefined;
    if (!epubPath) {
      throw new Error(`缺少输入路径: ${this.inputKey}`);
    }

    // ----- 断点续传：如果文本块文件已存在，直接从文件恢复 -----
    // 当 saveToFile 配置了 output_dir 且目录中已有 chunk_*.txt 文件时，
    // 说明之前的运行已经完成了 ePub 提取，无需重复解析（ePub 解析较慢）
    if (this.saveToFile) {
      // 用 context.data 中的值替换路径模板中的占位符
      // 例如 output_dir: "{paths.original}" → "data/mybook/original"
      let resolvedDir = this.saveToFile.output_dir;
      for (const [key, value] of Object.entries(context.data)) {
        resolvedDir = resolvedDir.replaceAll(`{${key}}`, String(value));
      }
      const outputDir = path.resolve(resolvedDir);

      // 检查目录中是否已有 chunk_*.txt 文件
      if (fs.existsSync(outputDir)) {
        const existingFiles = fs.readdirSync(outputDir)
          .filter((f) => /^chunk_\d+\.txt$/.test(f))
          .sort();

        if (existingFiles.length > 0) {
          // 从已有文件恢复文本块列表
          const chunkList = existingFiles.map((f, i) => ({
            index: i + 1,
            text: fs.readFileSync(path.join(outputDir, f), "utf-8"),
          }));
          logger.info(`从已有文本块文件恢复 ${chunkList.length} 个块，跳过 epub 提取`);
          return new StepResult(
            this.nextStep,
            { [this.outputKey]: chunkList },
            { chunk_count: chunkList.length, source: "cache" }
          );
        }
      }
    }

    logger.info(`开始提取ePub: ${epubPath}`);

    // 第二步：解析 ePub 文件
    // epub 包的使用方式：new EPub(path) 创建实例 → await epub.parse() 解析元数据和目录
    // 解析后 epub.flow 包含所有章节的清单项（ManifestItem），
    // 每项有 id 和 media-type 等属性
    const epub = new EPub(epubPath);
    await epub.parse();

    // 第三步：遍历所有章节，提取纯文本
    // epub.flow 是按阅读顺序排列的章节列表（来自 spine）
    // 对于每个章节：getChapter(id) 返回章节的 HTML 内容 → cheerio.load() 解析 → .text() 提取纯文本
    const allText: string[] = [];
    for (const item of epub.flow) {
      try {
        // getChapter 返回处理过的 HTML（已移除 script/style 标签）
        const html = await epub.getChapter(item.id);
        if (html) {
          // cheerio.load(html) 等价于 BeautifulSoup(html, 'html.parser')
          // $("*") 选择所有元素，.text() 提取其中的纯文本（去掉所有 HTML 标签）
          const $ = cheerio.load(html);
          const text = $.text();
          if (text.trim()) {
            allText.push(text.trim());
          }
        }
      } catch {
        // 某些非文本章节（如图片页）可能无法解析，跳过即可
        logger.warn(`跳过无法解析的章节: ${item.id}`);
      }
    }

    // 第四步：合并所有章节文本，章节间用双换行分隔
    const fullText = allText.join("\n\n");

    // 第五步：智能切分（句子级 + token 感知）
    const chunks = splitBySentences(
      fullText,
      this.targetTokens,
      this.emergencyThreshold
    );

    // 第六步：转换为带序号的字典列表
    // index 从 1 开始（1-based），与 Python 版保持一致
    const chunkList = chunks.map((chunk, i) => ({
      index: i + 1,
      text: chunk,
    }));

    logger.info(`提取完成，共切分为 ${chunkList.length} 个文本块`);

    // ----- 保存文本块到文件（供断点续传使用） -----
    // 将每个文本块写入独立的 .txt 文件，下次运行时可直接从文件恢复
    if (this.saveToFile) {
      let resolvedDir = this.saveToFile.output_dir;
      for (const [key, value] of Object.entries(context.data)) {
        resolvedDir = resolvedDir.replaceAll(`{${key}}`, String(value));
      }
      const outputDir = path.resolve(resolvedDir);
      fs.mkdirSync(outputDir, { recursive: true });

      // 文件名模板，默认 "chunk_{index:04d}.txt"
      const template = this.saveToFile.filename_template ?? "chunk_{index:04d}.txt";
      for (const chunk of chunkList) {
        // 简单替换 {index:04d} 格式的占位符为零补全的数字
        const filename = template.replace(
          /\{index(?::(\d+)d)?\}/,
          (_, width) => {
            const w = width ? parseInt(width, 10) : 0;
            return String(chunk.index).padStart(w, "0");
          }
        );
        fs.writeFileSync(path.join(outputDir, filename), chunk.text, "utf-8");
      }
      logger.info(`已保存 ${chunkList.length} 个文本块到 ${outputDir}`);
    }

    return new StepResult(
      this.nextStep,
      { [this.outputKey]: chunkList },
      { chunk_count: chunkList.length }
    );
  }
}

// ============================================================
// MergeToEpubAction — 合并对齐后的文本生成 ePub
// ============================================================

/**
 * 合并对齐后的文本生成 ePub
 *
 * 工作流程：
 *   1. 验证步骤 3 的对齐结果是否成功
 *   2. 从文件系统读取所有 aligned_*.txt 对齐文件
 *   3. 合并文本，用 nodepub 生成新的 ePub 文件
 *   4. 同时生成 TXT 文件（便于查看纯文本）
 *
 * 路径模板支持：outputDir / outputFilename / bookTitle 中的 {key} 占位符
 * 会被替换为 context.data 中对应的值（如 {book_name} → 实际书名）
 *
 * 输入：context.data[alignedKey] — 步骤 3 的对齐结果（用于验证成功数量）
 * 输出：context.data[outputKey] — { output_epub: string, output_txt: string }
 */
export class MergeToEpubAction extends BaseAction {
  // alignedKey：步骤 3 输出结果在 context.data 中的键名（用于验证是否有成功结果）
  private readonly alignedKey: string;
  // alignedDir：对齐文件所在目录路径（支持路径模板占位符）
  private readonly alignedDir: string;
  // outputDir：输出目录路径（支持路径模板占位符）
  private readonly outputDir: string;
  // outputFilename：输出文件名（支持路径模板占位符），包含 .epub 后缀
  private readonly outputFilename: string;
  // bookTitle：ePub 的书名元数据
  private readonly bookTitle: string;
  // outputKey：输出结果存入 context.data 的键名
  private readonly outputKey: string;
  private readonly nextStep: string;

  constructor(
    alignedKey: string = "3_response",
    alignedDir: string = "artifacts/aligned",
    outputDir: string = "results",
    outputFilename: string = "translated.epub",
    bookTitle: string = "Translated Book",
    outputKey: string = "output",
    nextStep: string = "END",
    name: string = "生成ePub",
    config: Record<string, unknown> = {}
  ) {
    super(name, config);
    this.alignedKey = alignedKey;
    this.alignedDir = alignedDir;
    this.outputDir = outputDir;
    this.outputFilename = outputFilename;
    this.bookTitle = bookTitle;
    this.outputKey = outputKey;
    this.nextStep = nextStep;
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    // 辅助函数：替换路径模板中的 {key} 占位符
    // 遍历 context.data 的所有键值对，将模板中的 {key} 替换为对应的值
    // 例如 context.data = { book_name: "三体" }，则 "{book_name}.epub" → "三体.epub"
    const replaceContextVars = (text: string): string => {
      let result = text;
      for (const [key, value] of Object.entries(context.data)) {
        const placeholder = `{${key}}`;
        if (result.includes(placeholder)) {
          result = result.replace(placeholder, String(value));
        }
      }
      return result;
    };

    const outputDir = replaceContextVars(this.outputDir);
    const outputFilename = replaceContextVars(this.outputFilename);
    const bookTitle = replaceContextVars(this.bookTitle);

    // 第一步：验证步骤 3 是否成功
    // alignedKey 指向的数据应该是一个包含 success 字段的对象
    const alignedResult = context.data[this.alignedKey] as
      | Record<string, unknown>
      | undefined;
    if (!alignedResult || typeof alignedResult !== "object") {
      throw new Error(`缺少对齐数据: ${this.alignedKey}`);
    }

    const successCount = (alignedResult["success"] as number) || 0;
    if (successCount === 0) {
      throw new Error("步骤3没有成功的对齐结果");
    }

    logger.info(`开始生成ePub... (成功对齐 ${successCount} 个块)`);

    // 第二步：从文件系统读取所有对齐文件
    const alignedDirResolved = replaceContextVars(this.alignedDir);
    if (!fs.existsSync(alignedDirResolved)) {
      throw new Error(`对齐文件目录不存在: ${alignedDirResolved}`);
    }

    // 读取 aligned_*.txt 文件并按文件名排序
    // readdirSync 返回文件名列表 → filter 筛选以 aligned_ 开头且 .txt 结尾的文件 → sort 按字母序排序
    const alignedFiles = fs
      .readdirSync(alignedDirResolved)
      .filter(
        (f) => f.startsWith("aligned_") && f.endsWith(".txt")
      )
      .sort()
      .map((f) => path.join(alignedDirResolved, f));

    if (alignedFiles.length === 0) {
      throw new Error(
        `未找到对齐文件: ${alignedDirResolved}/aligned_*.txt`
      );
    }

    // 逐个读取文件内容
    const alignedTexts: string[] = [];
    for (const filepath of alignedFiles) {
      const content = fs.readFileSync(filepath, "utf-8").trim();
      if (content) {
        alignedTexts.push(content);
      }
    }

    logger.info(`读取到 ${alignedTexts.length} 个对齐文件`);

    // 第三步：创建 ePub
    // nodepub.document(metadata) 创建新的 ePub 文档
    // metadata 必须包含 id、title、author、cover 四个必填字段
    // cover 设为空字符串时 nodepub 会报错，所以用一个占位值
    const metadata = {
      id: "translated_book_001",
      title: bookTitle,
      author: "Translated",
      language: "zh",
      cover: "", // nodepub 要求 cover 字段存在，但我们不需要封面图片
    };

    // 第四步：合并所有对齐文本
    const mergedContent = alignedTexts.join("\n\n");

    // 第五步：将对齐文本转换为 HTML（保留段落结构）
    // 每个段落用 <p> 标签包裹，特殊字符需要转义防止 XSS
    let htmlContent = "<h1>Translated Content</h1>";
    for (const para of mergedContent.split("\n\n")) {
      if (para.trim()) {
        // HTML 转义：& → &amp;  < → &lt;  > → &gt;  " → &quot;  ' → &#39;
        const escaped = para
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
        htmlContent += `<p>${escaped}</p>`;
      }
    }

    // 第六步：写入 ePub 文件
    // nodepub 的 writeEPUB(folder, filename) 会自动在 filename 后添加 .epub 后缀
    // 所以如果 outputFilename 已经包含 .epub，需要去掉
    const outputPath = path.join(outputDir, outputFilename);
    const outputDirResolved = path.dirname(outputPath);
    fs.mkdirSync(outputDirResolved, { recursive: true });

    // 从 outputFilename 中去掉 .epub 后缀（nodepub 会自动添加）
    const filenameWithoutExt = outputFilename.replace(/\.epub$/i, "");

    try {
      // nodepub 要求 cover 指向一个存在的图片文件
      // 如果没有封面，我们跳过 nodepub，直接生成 TXT
      // 因为 nodepub 的 cover 是必填字段且必须是有效图片路径
      // 这里尝试创建，如果失败则只生成 TXT
      const doc: NodepubDocument = nodepub.document(metadata);
      doc.addSection("Content", htmlContent);
      await doc.writeEPUB(outputDirResolved, filenameWithoutExt);
      logger.info(`ePub生成完成: ${outputPath}`);
    } catch (e) {
      // nodepub 可能因为 cover 图片不存在而失败
      // 此时退化为只生成 TXT 文件
      logger.warn(`ePub生成失败（${e}），将只生成TXT文件`);
    }

    // 第七步：生成 TXT 文件（便于查看纯文本）
    const txtPath = outputPath.replace(/\.epub$/i, ".txt");
    fs.writeFileSync(txtPath, mergedContent, "utf-8");
    logger.info(`TXT文件生成: ${txtPath}`);

    return new StepResult(
      this.nextStep,
      {
        [this.outputKey]: {
          output_epub: outputPath,
          output_txt: txtPath,
        },
      },
      {
        epub_path: outputPath,
        txt_path: txtPath,
        chapter_count: alignedTexts.length,
      }
    );
  }
}

// ============================================================
// ParseTranslationAction — 解析翻译结果
// ============================================================

/**
 * 解析翻译结果
 *
 * 从 LLM 翻译响应中提取 ###SEGMENT### 格式的翻译内容。
 * 用于 ConcurrentAction 的后处理步骤。
 *
 * LLM 翻译响应格式示例：
 *   ###SEGMENT1###
 *   这是第一段翻译内容...
 *   ###SEGMENT2###
 *   这是第二段翻译内容...
 *
 * 正则解析逻辑：
 *   匹配 ###SEGMENT数字### 标记，提取其后到下一个标记（或文本末尾）之间的内容
 *
 * 如果解析到的片段数量与预期不符，降级为返回原始响应文本（而非报错中断流程）。
 */
export class ParseTranslationAction extends BaseAction {
  // responseKey：LLM 响应文本在 context.data 中的键名
  private readonly responseKey: string;
  // outputKey：解析后的翻译文本存入 context.data 的键名
  private readonly outputKey: string;
  // expectedSegments：预期的片段数量（每次只翻译一个块时为 1）
  private readonly expectedSegments: number;

  constructor(
    responseKey: string = "llm_response",
    outputKey: string = "translated_text",
    expectedSegments: number = 1,
    name: string = "解析翻译结果",
    config: Record<string, unknown> = {}
  ) {
    super(name, config);
    this.responseKey = responseKey;
    this.outputKey = outputKey;
    this.expectedSegments = expectedSegments;
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    const responseText =
      (context.data[this.responseKey] as string) || "";

    // 正则解析 ###SEGMENT数字### 格式
    // 拆解：
    //   ###SEGMENT  — 字面量前缀
    //   (\d+)       — 捕获组1：片段编号（数字）
    //   ###         — 字面量后缀
    //   \s*\n       — 标记后的可选空白和换行
    //   (.*?)       — 捕获组2：片段内容（非贪婪匹配，尽可能少地匹配字符）
    //   (?=###SEGMENT\d+###|$) — 前瞻断言：匹配到下一个标记或文本末尾时停止
    //
    // 标志 s（dotAll）：让 . 也能匹配换行符（等价于 Python 的 re.DOTALL）
    const pattern = /###SEGMENT(\d+)###\s*\n(.*?)(?=###SEGMENT\d+###|$)/gs;
    const matches = [...responseText.matchAll(pattern)];

    if (matches.length !== this.expectedSegments) {
      logger.error(
        `期望 ${this.expectedSegments} 个片段，找到 ${matches.length} 个`
      );
      // 降级：返回原始响应文本，避免翻译丢失
      return new StepResult(
        "END",
        { [this.outputKey]: responseText },
        { parse_success: false }
      );
    }

    // 提取第一个片段的内容（因为每次只翻译一个块）
    // matches[0][2] 是第一个匹配的捕获组2（片段内容）
    const translatedText = matches.length > 0
      ? (matches[0]?.[2] ?? responseText).trim()
      : responseText;

    return new StepResult(
      "END",
      { [this.outputKey]: translatedText },
      { parse_success: true }
    );
  }
}
