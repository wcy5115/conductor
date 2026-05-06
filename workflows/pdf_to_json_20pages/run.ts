/**
 * PDF 前20页转 JSON 工作流启动器
 *
 * 提取 PDF 前20页的文字内容为 JSON 格式，每页一个 JSON 对象。
 *
 * 使用方法：
 *   1. 修改下方 INPUT_PDF 为你的 PDF 文件路径
 *   2. 运行: npx tsx workflows/pdf_to_json_20pages/run.ts
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
const INPUT_PDF = String.raw``;

// ============================================================
// 主函数
// ============================================================

async function main(): Promise<void> {
  if (!INPUT_PDF) {
    console.error("Please fill in INPUT_PDF in this runner.");
    process.exit(1);
  }

  // 第一步：检查输入文件是否存在
  if (!fs.existsSync(INPUT_PDF)) {
    console.error(`错误：找不到 PDF 文件: ${INPUT_PDF}`);
    console.error("请修改脚本中的 INPUT_PDF 变量");
    process.exit(1);
  }

  // 第二步：定位 workflow.yaml 路径
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const yamlPath = path.join(__dirname, "workflow.yaml");

  // 第三步：从 YAML 创建 WorkflowRunner 实例
  const runner = await WorkflowRunner.fromYaml(yamlPath);

  // 第四步：执行工作流
  // workflow.yaml 中的步骤引用 {input_pdf}
  const result = await runner.run({
    inputData: {
      input_pdf: INPUT_PDF,
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
