/**
 * CLI 清理工具（Clean Utility）
 *
 * 提供工作流输出目录的清理功能，可删除中间产物（artifacts）、
 * 结果文件（results）、日志文件（logs）等。
 *
 * 主要功能：
 *   - cleanDirectory()：清理指定目录下的子目录和文件
 *   - 支持 dry-run 模式（模拟运行，不实际删除）
 *   - 统计释放的磁盘空间
 *   - 显示保留的文件列表
 *
 * 典型使用方式：
 *   // 在代码中调用
 *   const stats = cleanDirectory("data/my_project", ["artifacts"]);
 *
 *   // 作为命令行工具（见文件底部 main 函数）
 *   // npx ts-node src/cli/clean.ts data/my_project --targets artifacts --dry-run
 *
 * 对应 Python 版：LLM_agent/src/cli/clean.py
 */

// ============================================================
// 导入依赖
// ============================================================

// fs：Node.js 内置文件系统模块
// 用于文件/目录的存在检查（existsSync）、删除（rmSync）、遍历（readdirSync）、
// 获取文件信息（statSync）等
import fs from "fs";

// path：Node.js 内置路径处理模块
// 用于路径拼接（path.join）和获取目录名（path.basename）
import path from "path";

// ============================================================
// 类型定义
// ============================================================

/**
 * 清理操作的选项
 *
 * 示例：
 *   const options: CleanOptions = {
 *     targets: ["artifacts", "temp"],
 *     dryRun: true,           // 模拟运行，不实际删除
 *     deleteResults: false,
 *     deleteLogs: false,
 *   };
 */
export interface CleanOptions {
  /**
   * 要删除的子目录名列表
   *
   * 这些目录位于 baseDir 下。
   * 例如 baseDir="data/my_project"，targets=["artifacts"]
   * → 删除 "data/my_project/artifacts/" 整个目录
   *
   * 默认值：["artifacts"]
   */
  targets?: string[];

  /**
   * 是否模拟运行
   *
   * 为 true 时只打印将要删除的内容和大小，不实际执行删除操作。
   * 适合在正式清理前先预览影响范围。
   *
   * 默认值：false
   */
  dryRun?: boolean;

  /**
   * 是否删除结果文件
   *
   * 为 true 时会删除 baseDir/results/ 目录下的所有文件（但不删除 results 目录本身）。
   *
   * 默认值：false
   */
  deleteResults?: boolean;

  /**
   * 是否删除日志目录
   *
   * 为 true 时会删除整个 baseDir/logs/ 目录。
   *
   * 默认值：false
   */
  deleteLogs?: boolean;
}

/**
 * 清理操作的统计结果
 *
 * 示例：
 *   {
 *     deletedDirs: 2,
 *     deletedFiles: 5,
 *     freedBytes: 1048576,    // 1 MB
 *     keptItems: ["data/my_project/workflow_config.yaml"],
 *   }
 */
export interface CleanStats {
  /** 已删除的目录数量 */
  deletedDirs: number;

  /** 已删除的文件数量 */
  deletedFiles: number;

  /** 释放的磁盘空间（字节） */
  freedBytes: number;

  /** 保留的文件路径列表 */
  keptItems: string[];
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 递归计算文件或目录的总大小（字节）
 *
 * 工作原理：
 *   - 如果是文件：直接返回文件大小
 *   - 如果是目录：递归遍历所有子文件，累加大小
 *
 * @param targetPath 要计算大小的文件或目录路径
 * @returns 总大小（字节数）
 *
 * 示例：
 *   getPathSize("data/my_project/artifacts")  → 5242880  (5 MB)
 *   getPathSize("data/my_project/config.yaml") → 1024    (1 KB)
 */
function getPathSize(targetPath: string): number {
  // 第一步：检查路径是否存在
  if (!fs.existsSync(targetPath)) {
    return 0;
  }

  // 第二步：获取路径的状态信息（文件类型、大小等）
  const stat = fs.statSync(targetPath);

  // 第三步：如果是文件，直接返回文件大小
  if (stat.isFile()) {
    return stat.size;
  }

  // 第四步：如果是目录，递归遍历所有内容
  let total = 0;
  if (stat.isDirectory()) {
    // readdirSync 列出目录内容
    // withFileTypes: true 返回 Dirent 对象（包含 isFile/isDirectory 方法），避免额外的 statSync 调用
    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(targetPath, entry.name);
      if (entry.isFile()) {
        // 文件：直接累加大小
        total += fs.statSync(entryPath).size;
      } else if (entry.isDirectory()) {
        // 子目录：递归计算
        total += getPathSize(entryPath);
      }
    }
  }

  return total;
}

/**
 * 将字节数格式化为可读的大小字符串
 *
 * @param bytes 字节数
 * @returns 格式化后的字符串
 *
 * 示例：
 *   formatSize(512)       → "0.50 KB"
 *   formatSize(1048576)   → "1.00 MB"
 *   formatSize(5242880)   → "5.00 MB"
 */
function formatSize(bytes: number): string {
  // 如果大于等于 1 MB (1024 * 1024 = 1048576)，用 MB 显示
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
  // 否则用 KB 显示
  return `${(bytes / 1024).toFixed(2)} KB`;
}

// ============================================================
// 主函数
// ============================================================

/**
 * 清理工作流输出目录
 *
 * 按以下顺序执行清理：
 *   1. 删除 targets 列表中指定的子目录（如 artifacts/）
 *   2.（可选）删除 results/ 下的文件
 *   3.（可选）删除 logs/ 目录
 *   4. 显示保留的文件列表
 *   5. 输出统计摘要
 *
 * @param baseDir 基础目录路径（如 "data/my_project"）
 * @param options 清理选项（可选，全部有默认值）
 * @returns 清理统计信息
 *
 * 示例：
 *   // 只清理 artifacts 目录
 *   const stats = cleanDirectory("data/my_project");
 *
 *   // 清理 artifacts 并预览（不实际删除）
 *   const stats = cleanDirectory("data/my_project", { dryRun: true });
 *
 *   // 清理所有（artifacts + results + logs）
 *   const stats = cleanDirectory("data/my_project", {
 *     deleteResults: true,
 *     deleteLogs: true,
 *   });
 */
export function cleanDirectory(
  baseDir: string,
  options: CleanOptions = {},
): CleanStats {
  // 第一步：解构选项，设置默认值
  const {
    targets = ["artifacts"],
    dryRun = false,
    deleteResults = false,
    deleteLogs = false,
  } = options;

  // 第二步：检查基础目录是否存在
  if (!fs.existsSync(baseDir)) {
    console.log(`[INFO] 目录不存在: ${baseDir}`);
    return { deletedDirs: 0, deletedFiles: 0, freedBytes: 0, keptItems: [] };
  }

  // 第三步：打印清理头部信息
  const separator = "=".repeat(60);
  // path.basename 提取目录名（不含父路径），如 "data/my_project" → "my_project"
  console.log(separator);
  console.log(`清理工具: ${path.basename(baseDir)}`);
  console.log(separator);
  console.log(`基础目录: ${baseDir}`);

  // 第四步：初始化统计对象
  const stats: CleanStats = {
    deletedDirs: 0,
    deletedFiles: 0,
    freedBytes: 0,
    keptItems: [],
  };

  // 第五步：删除 targets 列表中的子目录
  // 例如 targets=["artifacts", "temp"] → 删除 baseDir/artifacts/ 和 baseDir/temp/
  for (const target of targets) {
    const targetPath = path.join(baseDir, target);

    if (fs.existsSync(targetPath)) {
      // 先计算目录大小，用于打印释放的空间和统计
      const size = getPathSize(targetPath);

      if (dryRun) {
        // dry-run 模式：只打印不删除
        console.log(`\n[DRY RUN] 将删除: ${target}/ (${formatSize(size)})`);
      } else {
        // 实际删除：rmSync + recursive + force
        // recursive: true 递归删除目录中的所有内容
        // force: true 如果路径不存在不报错（防止竞态条件）
        fs.rmSync(targetPath, { recursive: true, force: true });
        console.log(`\n[DELETED] ${target}/ (${formatSize(size)})`);
        stats.deletedDirs += 1;
        stats.freedBytes += size;
      }
    }
  }

  // 第六步：（可选）删除 results 目录下的文件
  // 只删除文件，不删除 results 目录本身，也不递归删除子目录
  if (deleteResults) {
    const resultsDir = path.join(baseDir, "results");
    if (fs.existsSync(resultsDir)) {
      const entries = fs.readdirSync(resultsDir, { withFileTypes: true });
      for (const entry of entries) {
        // 只处理文件，跳过子目录
        if (entry.isFile()) {
          const filePath = path.join(resultsDir, entry.name);
          const size = fs.statSync(filePath).size;

          if (dryRun) {
            console.log(
              `[DRY RUN] 将删除: results/${entry.name} (${formatSize(size)})`,
            );
          } else {
            fs.unlinkSync(filePath);
            console.log(`[DELETED] results/${entry.name}`);
            stats.deletedFiles += 1;
            stats.freedBytes += size;
          }
        }
      }
    }
  }

  // 第七步：（可选）删除日志目录
  if (deleteLogs) {
    const logsDir = path.join(baseDir, "logs");
    if (fs.existsSync(logsDir)) {
      const size = getPathSize(logsDir);

      if (dryRun) {
        console.log(`\n[DRY RUN] 将删除: logs/ (${formatSize(size)})`);
      } else {
        fs.rmSync(logsDir, { recursive: true, force: true });
        console.log(`\n[DELETED] logs/ (${formatSize(size)})`);
        stats.deletedDirs += 1;
        stats.freedBytes += size;
      }
    }
  }

  // 第八步：显示保留的文件列表
  // 遍历 baseDir 下剩余的文件（不含目录），帮助用户了解哪些内容被保留
  console.log("\n[KEEP] 保留:");
  if (fs.existsSync(baseDir)) {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const filePath = path.join(baseDir, entry.name);
        stats.keptItems.push(filePath);
        console.log(`  - ${entry.name}`);
      }
    }
  }

  // 第九步：打印统计摘要
  if (dryRun) {
    console.log("\n[DRY RUN] 这是模拟运行，未实际删除");
  } else {
    console.log(`\n[SUMMARY] 释放空间: ${formatSize(stats.freedBytes)}`);
  }
  console.log(separator);

  return stats;
}
