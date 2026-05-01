/**
 * CLI cleanup utility.
 *
 * Provides cleanup helpers for workflow output directories, including
 * intermediate artifacts, result files, and logs.
 *
 * Main features:
 *   - cleanDirectory(): cleans selected subdirectories and files
 *   - Supports dry-run mode for previewing without deleting
 *   - Tracks freed disk space
 *   - Shows the list of kept files
 *
 * Typical usage:
 *   // Call from code
 *   const stats = cleanDirectory("data/my_project", {
 *     targets: ["artifacts"],
 *   });
 *
 *   // Run as a command-line utility
 *   // npx ts-node src/cli/clean.ts data/my_project --targets artifacts --dry-run
 *
 * Python counterpart: LLM_agent/src/cli/clean.py
 */

// ============================================================
// Imports
// ============================================================

// Node.js built-in file system module.
// Used for existence checks, deletion, directory traversal, and file stats.
import fs from "fs";

// Node.js built-in path helper module.
// Used for joining paths and reading directory names.
import path from "path";

// ============================================================
// Types
// ============================================================

/**
 * Options for a cleanup operation.
 *
 * Example:
 *   const options: CleanOptions = {
 *     targets: ["artifacts", "temp"],
 *     dryRun: true,           // Preview only; do not delete anything.
 *     deleteResults: false,
 *     deleteLogs: false,
 *   };
 */
export interface CleanOptions {
  /**
   * Names of child directories to delete.
   *
   * These directories live under baseDir.
   * For example, baseDir="data/my_project" and targets=["artifacts"]
   * deletes the whole "data/my_project/artifacts/" directory.
   *
   * Default: ["artifacts"]
   */
  targets?: string[];

  /**
   * Whether to preview the cleanup.
   *
   * When true, the cleaner only prints what would be deleted and the
   * estimated size. It does not delete anything.
   * Useful for previewing the impact before a real cleanup.
   *
   * Default: false
   */
  dryRun?: boolean;

  /**
   * Whether to delete result files.
   *
   * When true, deletes all files under baseDir/results/ without deleting the
   * results directory itself.
   *
   * Default: false
   */
  deleteResults?: boolean;

  /**
   * Whether to delete the logs directory.
   *
   * When true, deletes the whole baseDir/logs/ directory.
   *
   * Default: false
   */
  deleteLogs?: boolean;
}

/**
 * Stats returned by a cleanup operation.
 *
 * Example:
 *   {
 *     deletedDirs: 2,
 *     deletedFiles: 5,
 *     freedBytes: 1048576,    // 1 MB.
 *     keptItems: ["data/my_project/workflow_config.yaml"],
 *   }
 */
export interface CleanStats {
  /** Number of deleted directories. */
  deletedDirs: number;

  /** Number of deleted files. */
  deletedFiles: number;

  /** Freed disk space in bytes. */
  freedBytes: number;

  /** Paths of files that were kept. */
  keptItems: string[];
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * Recursively calculate the total size of a file or directory in bytes.
 *
 * How it works:
 *   - For a file: returns the file size directly
 *   - For a directory: recursively walks child files and sums their sizes
 *
 * @param targetPath File or directory path to measure.
 * @returns Total size in bytes.
 *
 * Example:
 *   getPathSize("data/my_project/artifacts")   returns 5242880  (5 MB)
 *   getPathSize("data/my_project/config.yaml") returns 1024     (1 KB)
 */
function getPathSize(targetPath: string): number {
  // First, check whether the path exists.
  if (!fs.existsSync(targetPath)) {
    return 0;
  }

  // Then read metadata such as file type and size.
  const stat = fs.statSync(targetPath);

  // Files can return their size directly.
  if (stat.isFile()) {
    return stat.size;
  }

  // Directories need a recursive walk.
  let total = 0;
  if (stat.isDirectory()) {
    // withFileTypes returns Dirent objects and avoids extra stat calls.
    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(targetPath, entry.name);
      if (entry.isFile()) {
        total += fs.statSync(entryPath).size;
      } else if (entry.isDirectory()) {
        total += getPathSize(entryPath);
      }
    }
  }

  return total;
}

function assertInsideBaseDir(
  resolvedBaseDir: string,
  targetPath: string,
  target: string,
): void {
  const relativePath = path.relative(resolvedBaseDir, targetPath);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`Cleanup target must stay inside base directory: ${target}`);
  }
}

/**
 * Format a byte count as a readable size string.
 *
 * @param bytes Byte count.
 * @returns Formatted size string.
 *
 * Example:
 *   formatSize(512)       returns "0.50 KB"
 *   formatSize(1048576)   returns "1.00 MB"
 *   formatSize(5242880)   returns "5.00 MB"
 */
function formatSize(bytes: number): string {
  // Use MB for values at or above 1 MB.
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
  // Otherwise use KB.
  return `${(bytes / 1024).toFixed(2)} KB`;
}

// ============================================================
// Main Function
// ============================================================

/**
 * Clean a workflow output directory.
 *
 * Cleanup order:
 *   1. Delete child directories listed in targets, such as artifacts/
 *   2. Optionally delete files under results/
 *   3. Optionally delete the logs/ directory
 *   4. Show the list of kept files
 *   5. Print a summary
 *
 * @param baseDir Base directory path, such as "data/my_project".
 * @param options Optional cleanup settings. Every option has a default.
 * @returns Cleanup stats.
 *
 * Example:
 *   // Clean only the artifacts directory.
 *   const stats = cleanDirectory("data/my_project");
 *
 *   // Preview cleaning artifacts without deleting anything.
 *   const stats = cleanDirectory("data/my_project", { dryRun: true });
 *
 *   // Clean artifacts, results, and logs.
 *   const stats = cleanDirectory("data/my_project", {
 *     deleteResults: true,
 *     deleteLogs: true,
 *   });
 */
export function cleanDirectory(
  baseDir: string,
  options: CleanOptions = {},
): CleanStats {
  // Read options and apply defaults.
  const {
    targets = ["artifacts"],
    dryRun = false,
    deleteResults = false,
    deleteLogs = false,
  } = options;

  const resolvedBaseDir = path.resolve(baseDir);

  // Check whether the base directory exists.
  if (!fs.existsSync(resolvedBaseDir)) {
    console.log(`[INFO] Directory does not exist: ${baseDir}`);
    return { deletedDirs: 0, deletedFiles: 0, freedBytes: 0, keptItems: [] };
  }

  // Print the cleanup header.
  const separator = "=".repeat(60);
  // path.basename extracts the final directory name.
  console.log(separator);
  console.log(`Clean utility: ${path.basename(baseDir)}`);
  console.log(separator);
  console.log(`Base directory: ${baseDir}`);

  // Initialize stats.
  const stats: CleanStats = {
    deletedDirs: 0,
    deletedFiles: 0,
    freedBytes: 0,
    keptItems: [],
  };

  // Delete child directories listed in targets.
  for (const target of targets) {
    const targetPath = path.resolve(resolvedBaseDir, target);
    assertInsideBaseDir(resolvedBaseDir, targetPath, target);

    if (fs.existsSync(targetPath)) {
      // Measure the directory first for reporting and stats.
      const size = getPathSize(targetPath);

      if (dryRun) {
        console.log(`\n[DRY RUN] Would delete: ${target}/ (${formatSize(size)})`);
      } else {
        // recursive deletes the whole tree; force avoids races if it disappears.
        fs.rmSync(targetPath, { recursive: true, force: true });
        console.log(`\n[DELETED] ${target}/ (${formatSize(size)})`);
        stats.deletedDirs += 1;
        stats.freedBytes += size;
      }
    }
  }

  // Optionally delete files under results/. Keep the directory itself.
  if (deleteResults) {
    const resultsDir = path.join(baseDir, "results");
    if (fs.existsSync(resultsDir)) {
      const entries = fs.readdirSync(resultsDir, { withFileTypes: true });
      for (const entry of entries) {
        // Delete files only and skip child directories.
        if (entry.isFile()) {
          const filePath = path.join(resultsDir, entry.name);
          const size = fs.statSync(filePath).size;

          if (dryRun) {
            console.log(
              `[DRY RUN] Would delete: results/${entry.name} (${formatSize(size)})`,
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

  // Optionally delete the logs directory.
  if (deleteLogs) {
    const logsDir = path.join(baseDir, "logs");
    if (fs.existsSync(logsDir)) {
      const size = getPathSize(logsDir);

      if (dryRun) {
        console.log(`\n[DRY RUN] Would delete: logs/ (${formatSize(size)})`);
      } else {
        fs.rmSync(logsDir, { recursive: true, force: true });
        console.log(`\n[DELETED] logs/ (${formatSize(size)})`);
        stats.deletedDirs += 1;
        stats.freedBytes += size;
      }
    }
  }

  // Show files kept at the top level of baseDir.
  console.log("\n[KEEP] Kept:");
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

  // Print the summary.
  if (dryRun) {
    console.log("\n[DRY RUN] This was a preview; no files were deleted");
  } else {
    console.log(`\n[SUMMARY] Freed space: ${formatSize(stats.freedBytes)}`);
  }
  console.log(separator);

  return stats;
}
