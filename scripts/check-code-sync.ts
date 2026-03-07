/**
 * 代码同步检查脚本
 *
 * 用途：确保 src/（中文注释版）与 docs/src-en/（英文注释版）的实际代码完全一致。
 * 原理：用 TypeScript 编译器 API 解析源码，去除所有注释后逐行对比纯代码。
 *
 * 运行方式：npx tsx scripts/check-code-sync.ts
 * 退出码：0 = 全部一致，1 = 有差异或缺失文件
 */

// fs — Node.js 文件系统模块，用于读取文件和目录
import * as fs from "fs";
// path — Node.js 路径模块，用于拼接、解析文件路径
import * as path from "path";
// url — Node.js URL 模块，用于将 import.meta.url 转换为文件路径（ESM 中没有 __dirname）
import { fileURLToPath } from "url";
// ts — TypeScript 编译器 API，用于解析源码 AST 并定位注释区间
import * as ts from "typescript";

// ============================================================
// 常量定义
// ============================================================

// ESM 模块中没有 __dirname，需要通过 import.meta.url 手动构造
// import.meta.url 返回形如 "file:///D:/project/scripts/check-code-sync.ts" 的 URL
// fileURLToPath 将其转为本地路径，path.dirname 取其目录部分
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 项目根目录（脚本位于 scripts/ 下，所以往上一级就是项目根）
const PROJECT_ROOT = path.resolve(__dirname, "..");
// 需要检查同步的目录配对列表
// 每一对：[中文注释目录, 英文注释目录, 显示用的标签]
// 左边是项目中的原始目录，右边是 docs/ 下对应的英文注释副本
const DIR_PAIRS: Array<[string, string, string]> = [
  [path.join(PROJECT_ROOT, "src"), path.join(PROJECT_ROOT, "docs", "src-en"), "src"],
  [path.join(PROJECT_ROOT, "tests"), path.join(PROJECT_ROOT, "docs", "tests-en"), "tests"],
  [path.join(PROJECT_ROOT, "scripts"), path.join(PROJECT_ROOT, "docs", "scripts-en"), "scripts"],
];

// ============================================================
// 递归扫描目录，返回所有 .ts 文件的相对路径
// ============================================================

/**
 * 递归扫描指定目录下的所有 .ts 文件
 *
 * @param dir - 要扫描的目录绝对路径
 * @param baseDir - 基准目录，用于计算相对路径
 * @returns 相对路径数组，如 ["index.ts", "core/logging.ts"]
 *
 * 示例：
 *   scanTsFiles("/project/src", "/project/src")
 *   → ["index.ts", "core/logging.ts", "utils.ts", ...]
 */
function scanTsFiles(dir: string, baseDir: string): string[] {
  // 结果数组，存放所有找到的 .ts 文件相对路径
  const results: string[] = [];

  // 如果目录不存在，直接返回空数组（docs/src-en/ 可能尚未创建）
  if (!fs.existsSync(dir)) {
    return results;
  }

  // 读取目录下所有条目（文件和子目录）
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    // 拼接条目的完整路径
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // 如果是子目录，递归扫描并合并结果
      results.push(...scanTsFiles(fullPath, baseDir));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      // 如果是 .ts 文件，计算相对路径并加入结果
      // path.relative 示例：path.relative("/project/src", "/project/src/core/logging.ts") → "core/logging.ts"
      results.push(path.relative(baseDir, fullPath));
    }
  }

  return results;
}

// ============================================================
// 用 TypeScript 编译器 API 去除源码中的所有注释
// ============================================================

/**
 * 收集源码文本中所有注释的起止位置区间
 *
 * 原理：TypeScript 的 `getLeadingCommentRanges` 和 `getTrailingCommentRanges`
 * 分别返回节点前方和后方的注释区间（包括 // 行注释和 /* * / 块注释）。
 * 我们递归遍历 AST 的每个节点，收集所有注释的 [pos, end] 区间。
 *
 * @param sourceFile - ts.createSourceFile 解析得到的 AST
 * @param text - 原始源码文本
 * @returns 注释区间数组 [{pos, end}, ...]
 */
function collectCommentRanges(
  sourceFile: ts.SourceFile,
  text: string,
): Array<{ pos: number; end: number }> {
  // 存放所有注释区间
  const ranges: Array<{ pos: number; end: number }> = [];

  /**
   * 递归遍历 AST 节点，收集每个节点前后的注释区间
   *
   * 为什么用 ts.forEachChild 而不是 ts.visitEachChild？
   *   forEachChild 只遍历直接子节点，不需要 visitor 回调返回新节点，
   *   适合"只读遍历"场景，更简洁。
   */
  function visit(node: ts.Node): void {
    // 获取节点前方的注释（如函数前的 JSDoc、行前的 // 注释）
    const leading = ts.getLeadingCommentRanges(text, node.getFullStart());
    if (leading) {
      for (const range of leading) {
        ranges.push({ pos: range.pos, end: range.end });
      }
    }

    // 获取节点后方的注释（如行尾的 // 注释）
    const trailing = ts.getTrailingCommentRanges(text, node.getEnd());
    if (trailing) {
      for (const range of trailing) {
        ranges.push({ pos: range.pos, end: range.end });
      }
    }

    // 递归访问所有子节点
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return ranges;
}

/**
 * 从源码文本中去除所有注释，返回纯代码文本
 *
 * 步骤：
 *   1. 用 ts.createSourceFile 将源码解析为 AST
 *   2. 收集所有注释的 [pos, end] 区间
 *   3. 按位置排序、去重（不同节点可能报告相同的注释区间）
 *   4. 从原始文本中删除这些区间，拼接剩余部分
 *
 * @param code - 原始 TypeScript 源码
 * @param fileName - 文件名（仅用于 AST 解析的诊断信息）
 * @returns 去除注释后的纯代码
 *
 * 示例：
 *   stripComments("const x = 1; // 这是注释", "a.ts")
 *   → "const x = 1; "
 */
function stripComments(code: string, fileName: string): string {
  // 第一步：将源码解析为 AST（抽象语法树）
  // ScriptTarget.Latest 表示使用最新的 ES 标准解析
  // true 表示 setParentNodes，让每个节点都有 parent 引用
  const sourceFile = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    true,
  );

  // 第二步：收集所有注释区间
  const ranges = collectCommentRanges(sourceFile, code);

  // 第三步：按起始位置排序，便于后续从前到后处理
  ranges.sort((a, b) => a.pos - b.pos);

  // 去重：相同区间只保留一次
  // 为什么会有重复？因为相邻节点可能共享同一个注释区间
  // 例如：// 注释\nconst a = 1; 中，注释既是下一个节点的 leading，也可能被其他节点报告
  const unique: Array<{ pos: number; end: number }> = [];
  for (const r of ranges) {
    // 如果和上一个区间不同，才加入（利用已排序的特性，只需比较相邻的）
    if (unique.length === 0 || unique[unique.length - 1].pos !== r.pos || unique[unique.length - 1].end !== r.end) {
      unique.push(r);
    }
  }

  // 第四步：从原始文本中删除注释区间，拼接剩余部分
  // cursor 记录当前处理到的位置，跳过注释区间
  const parts: string[] = [];
  let cursor = 0;
  for (const r of unique) {
    if (r.pos > cursor) {
      // 将注释前的代码文本加入结果
      parts.push(code.slice(cursor, r.pos));
    }
    // 跳过注释区间，将 cursor 移到注释结束位置
    cursor = r.end;
  }
  // 别忘了最后一段（最后一个注释之后的代码）
  if (cursor < code.length) {
    parts.push(code.slice(cursor));
  }

  return parts.join("");
}

// ============================================================
// 规范化代码文本：消除注释位置差异导致的空白差异
// ============================================================

/**
 * 规范化代码文本
 *
 * 去除注释后，原来注释所在的位置可能留下多余的空行或空白。
 * 规范化步骤：
 *   1. 按行分割
 *   2. 每行 trim（去除首尾空白）
 *   3. 过滤空行
 *
 * 这样即使中英文注释的行数不同，只要纯代码一致就不会产生假阳性。
 *
 * @param code - 去除注释后的代码
 * @returns 规范化后的非空行数组
 */
function normalizeCode(code: string): string[] {
  return code
    .split("\n")             // 按换行符分割为行数组
    .map((line) => line.trim())   // 每行去除首尾空白
    .filter((line) => line !== ""); // 过滤掉空行
}

// ============================================================
// 比较两个文件的纯代码，输出差异报告
// ============================================================

/**
 * 比较两个文件去除注释后的纯代码是否一致
 *
 * @param relativePath - 文件的相对路径（用于显示）
 * @param srcCode - 中文注释版的原始源码
 * @param enCode - 英文注释版的原始源码
 * @returns true = 一致，false = 有差异
 */
function compareFiles(
  relativePath: string,
  srcCode: string,
  enCode: string,
): boolean {
  // 分别去除注释并规范化
  const srcLines = normalizeCode(stripComments(srcCode, relativePath));
  const enLines = normalizeCode(stripComments(enCode, relativePath));

  // 如果规范化后的行数组完全相同，说明代码一致
  if (srcLines.length === enLines.length && srcLines.every((line, i) => line === enLines[i])) {
    return true;
  }

  // 有差异，输出详细报告
  console.log(`\n  差异详情：`);

  // 取两边行数的最大值，逐行对比
  const maxLen = Math.max(srcLines.length, enLines.length);
  // diffCount 用于限制输出的差异行数，避免刷屏
  let diffCount = 0;
  const MAX_DIFF_LINES = 10;

  for (let i = 0; i < maxLen; i++) {
    const srcLine = srcLines[i] ?? "(无)";  // 如果 src 行数较少，显示 "(无)"
    const enLine = enLines[i] ?? "(无)";    // 如果 en 行数较少，显示 "(无)"

    if (srcLine !== enLine) {
      diffCount++;
      if (diffCount <= MAX_DIFF_LINES) {
        // 显示差异行的行号和两边内容
        console.log(`    行 ${i + 1}:`);
        console.log(`      src:    ${srcLine}`);
        console.log(`      src-en: ${enLine}`);
      }
    }
  }

  if (diffCount > MAX_DIFF_LINES) {
    console.log(`    ... 还有 ${diffCount - MAX_DIFF_LINES} 处差异未显示`);
  }

  console.log(`  共 ${diffCount} 处差异`);
  return false;
}

// ============================================================
// 主函数：扫描、配对、比较、输出报告
// ============================================================

function main(): void {
  console.log("=== 代码同步检查 ===\n");

  // hasError 标记是否有任何差异或缺失，决定最终退出码
  let hasError = false;

  // 逐个检查每对目录
  for (const [cnDir, enDir, label] of DIR_PAIRS) {
    console.log(`--- ${label}/ ↔ docs/${label}-en/ ---`);

    // 扫描两个目录下的所有 .ts 文件
    const cnFiles = new Set(scanTsFiles(cnDir, cnDir));
    const enFiles = new Set(scanTsFiles(enDir, enDir));

    // 合并两边的文件路径，用于统一遍历
    const allFiles = new Set([...cnFiles, ...enFiles]);

    if (allFiles.size === 0) {
      console.log("  (无 .ts 文件，跳过)\n");
      continue;
    }

    // 按字母顺序排列，方便阅读
    const sortedFiles = [...allFiles].sort();

    for (const relativePath of sortedFiles) {
      // 将相对路径中的反斜杠统一为正斜杠（Windows 兼容）
      const displayPath = relativePath.replace(/\\/g, "/");

      const inCn = cnFiles.has(relativePath);
      const inEn = enFiles.has(relativePath);

      if (!inCn) {
        // 文件只存在于英文目录，中文目录中缺失
        console.log(`[缺失] ${displayPath} — 仅存在于 ${label}-en/，${label}/ 中缺失`);
        hasError = true;
        continue;
      }

      if (!inEn) {
        // 文件只存在于中文目录，英文目录中缺失
        console.log(`[缺失] ${displayPath} — 仅存在于 ${label}/，${label}-en/ 中缺失`);
        hasError = true;
        continue;
      }

      // 两边都有该文件，读取内容并比较
      const cnCode = fs.readFileSync(path.join(cnDir, relativePath), "utf-8");
      const enCode = fs.readFileSync(path.join(enDir, relativePath), "utf-8");

      const isMatch = compareFiles(relativePath, cnCode, enCode);

      if (isMatch) {
        console.log(`[一致] ${displayPath}`);
      } else {
        console.log(`[差异] ${displayPath}`);
        hasError = true;
      }
    }

    console.log(); // 目录对之间空一行
  }

  // 输出汇总
  console.log("=== 检查完成 ===");
  if (hasError) {
    console.log("结果：存在差异或缺失文件，请检查上方报告。");
    process.exit(1);
  } else {
    console.log("结果：所有文件代码一致。");
    process.exit(0);
  }
}

// 执行主函数
main();
