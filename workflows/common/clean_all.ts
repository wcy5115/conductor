/**
 * 批量清理所有工作流的中间文件
 *
 * 扫描 data/ 目录下的所有工作流数据目录，清理其中的 artifacts/ 子目录。
 *
 * 使用方法：
 *   npx tsx workflows/common/clean_all.ts
 */

// fs：Node.js 内置文件系统模块，用于遍历目录和检查路径
import fs from "fs";

// path：Node.js 内置路径处理模块，用于拼接路径
import path from "path";

// cleanDirectory：清理工作流输出目录的工具函数
import { cleanDirectory } from "../../src/cli/clean.js";

// ============================================================
// 工具函数
// ============================================================

/**
 * 查找 data/ 目录下所有包含 artifacts/ 子目录的工作流数据目录
 *
 * 跳过 conversations、outputs 等非工作流目录。
 *
 * @returns 工作流数据目录路径列表
 */
function findWorkflowDataDirs(): string[] {
  const dataDir = "data";

  // 第一步：检查 data/ 是否存在
  if (!fs.existsSync(dataDir)) {
    return [];
  }

  const workflowDirs: string[] = [];

  // 第二步：遍历 data/ 下的子目录
  const entries = fs.readdirSync(dataDir, { withFileTypes: true });
  for (const entry of entries) {
    // 跳过文件和非工作流目录
    if (!entry.isDirectory()) continue;
    if (["conversations", "outputs"].includes(entry.name)) continue;

    const dirPath = path.join(dataDir, entry.name);

    // 第三步：检查是否包含 artifacts/ 子目录（工作流的中间产物标志）
    const artifactsDir = path.join(dirPath, "artifacts");
    if (fs.existsSync(artifactsDir)) {
      workflowDirs.push(dirPath);
    }
  }

  return workflowDirs;
}

// ============================================================
// 主函数
// ============================================================

function main(): void {
  const separator = "=".repeat(60);
  console.log(separator);
  console.log("批量清理所有工作流中间文件");
  console.log(separator);
  console.log();

  // 第一步：查找所有工作流数据目录
  const workflowDirs = findWorkflowDataDirs();

  if (workflowDirs.length === 0) {
    console.log("[OK] 没有需要清理的工作流");
    return;
  }

  // 第二步：列出将要清理的目录
  console.log(`发现 ${workflowDirs.length} 个工作流需要清理:\n`);
  for (const dir of workflowDirs) {
    console.log(`  - ${path.basename(dir)}`);
  }
  console.log();

  // 第三步：逐个清理
  let totalCleaned = 0;
  for (const dir of workflowDirs) {
    const stats = cleanDirectory(dir, { targets: ["artifacts"] });
    totalCleaned += stats.deletedDirs;
    console.log();
  }

  // 第四步：打印汇总
  console.log(separator);
  if (totalCleaned > 0) {
    console.log(`[OK] 清理完成！共清理 ${totalCleaned} 个目录`);
  } else {
    console.log("[OK] 所有工作流都很干净");
  }
  console.log(separator);
}

main();
