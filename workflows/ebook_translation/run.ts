/**
 * 电子书翻译工作流启动器
 *
 * 使用方法：
 *   npx tsx workflows/ebook_translation/run.ts
 */

// dotenv：从 .env 文件加载环境变量（API 密钥等）
import "dotenv/config";

// path：Node.js 内置路径处理模块
import path from "path";

// fs：Node.js 内置文件系统模块，用于检查输入文件是否存在
import fs from "fs";

// fileURLToPath：将 import.meta.url 转换为普通文件路径
import { fileURLToPath } from "url";

// WorkflowRunner：工作流一键启动器
import { WorkflowRunner } from "../../src/core/workflow_runner.js";

// ============================================================
// 配置区：按需修改
// ============================================================

// INPUT_EPUB：输入电子书文件的路径（支持 .epub 和 .txt）
const INPUT_EPUB = String.raw`C:\Users\wcy51\Downloads\the_economist_2026-4-3.txt`;

// BOOK_NAME：书名，用于输出文件的命名（如 "浪潮之巅_translated.epub"）
const BOOK_NAME = "The-Economist-2026-4-3";

// ============================================================
// 主函数
// ============================================================

const SUPPORTED_EXTENSIONS = new Set([".epub", ".txt"]);

async function main(): Promise<void> {
  // 第一步：检查输入文件是否存在
  if (!fs.existsSync(INPUT_EPUB)) {
    console.error(`错误：找不到输入文件: ${INPUT_EPUB}`);
    console.error("请修改脚本中的 INPUT_EPUB 变量");
    process.exit(1);
  }

  // 检查文件格式
  const ext = path.extname(INPUT_EPUB).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    console.error(`错误：不支持的文件格式: ${ext}，支持: ${[...SUPPORTED_EXTENSIONS].join(", ")}`);
    process.exit(1);
  }

  // 第二步：定位 workflow.yaml 路径
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const yamlPath = path.join(__dirname, "workflow.yaml");

  // 第三步：从 YAML 创建 WorkflowRunner 实例
  const runner = await WorkflowRunner.fromYaml(yamlPath);

  // 第四步：执行工作流
  // workflow.yaml 中的步骤引用 {input_epub} 和 {book_name}
  const result = await runner.run({
    inputData: {
      input_epub: INPUT_EPUB,
      book_name: BOOK_NAME,
    },
    cleanupOnSuccess: false,
  });

  // 第五步：根据结果退出
  if (result.status === "failed") {
    console.error(`工作流执行失败: ${result.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
