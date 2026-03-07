/**
 * PDF OCR 并发处理工作流启动器
 *
 * 展示原子化操作组合：PDF转图片 + 并发OCR
 *
 * 使用方法：
 *   1. 准备 PDF 文件并修改下方 INPUT_PDF 路径
 *   2. 设置环境变量（.env 文件中配置 API 密钥）
 *   3. 运行: npx tsx workflows/pdf_ocr_concurrent/run.ts
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

// INPUT_PDF：输入 PDF 文件路径
const INPUT_PDF = "data/input.pdf";

// OUTPUT_IMAGES_DIR：图片输出目录
const OUTPUT_IMAGES_DIR = "data/pdf_images";

// OUTPUT_TEXTS_DIR：OCR 文本输出目录
const OUTPUT_TEXTS_DIR = "data/ocr_texts";

// ============================================================
// 主函数
// ============================================================

async function main(): Promise<void> {
  // 第一步：检查输入文件是否存在
  if (!fs.existsSync(INPUT_PDF)) {
    console.error(`错误：输入 PDF 文件不存在: ${INPUT_PDF}`);
    console.error("请修改脚本中的 INPUT_PDF 变量，或将 PDF 文件放到指定路径");
    process.exit(1);
  }

  // 第二步：定位 workflow.yaml 路径
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const yamlPath = path.join(__dirname, "workflow.yaml");

  // 第三步：从 YAML 创建 WorkflowRunner 实例
  const runner = await WorkflowRunner.fromYaml(yamlPath);

  // 第四步：执行工作流
  // workflow.yaml 中的步骤引用 {input_pdf}、{output_images_dir}、{output_texts_dir}
  const result = await runner.run({
    inputData: {
      input_pdf: INPUT_PDF,
      output_images_dir: OUTPUT_IMAGES_DIR,
      output_texts_dir: OUTPUT_TEXTS_DIR,
    },
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
