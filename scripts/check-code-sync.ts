/**
 * Code sync checker.
 *
 * Purpose: make sure working code and the detailed copies in
 * docs/code-explained/ contain the same executable code.
 *
 * Principle: use the TypeScript compiler API to parse source code, remove all
 * comments, normalize the remaining code, and compare it line by line.
 *
 * Run with: npx tsx scripts/check-code-sync.ts
 * Exit codes: 0 = all code matches, 1 = differences or missing files exist
 */

// fs: Node.js file-system module for reading files and directories.
import * as fs from "fs";
// path: Node.js path module for joining and resolving file paths.
import * as path from "path";
// url: converts import.meta.url into a local file path. ESM has no __dirname.
import { fileURLToPath } from "url";
// ts: TypeScript compiler API for parsing source code and locating comments.
import * as ts from "typescript";

// ============================================================
// Constants
// ============================================================

// ESM modules do not provide __dirname, so we build it from import.meta.url.
// import.meta.url returns a URL like "file:///D:/project/scripts/check-code-sync.ts".
// fileURLToPath converts that URL into a local path, and path.dirname keeps its directory.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root. This script lives under scripts/, so one level up is the root.
const PROJECT_ROOT = path.resolve(__dirname, "..");
const CODE_EXPLAINED_ROOT = path.join(PROJECT_ROOT, "docs", "code-explained");
// Directory pairs to compare.
// Each pair is [working-code directory, explained-code directory, display label].
// The left side is real project code; the right side is the matching explained copy.
const DIR_PAIRS: Array<[string, string, string]> = [
  [path.join(PROJECT_ROOT, "src"), path.join(CODE_EXPLAINED_ROOT, "src"), "src"],
  [path.join(PROJECT_ROOT, "tests"), path.join(CODE_EXPLAINED_ROOT, "tests"), "tests"],
  [path.join(PROJECT_ROOT, "scripts"), path.join(CODE_EXPLAINED_ROOT, "scripts"), "scripts"],
];

// ============================================================
// Recursively scan directories
// ============================================================

/**
 * Recursively scan a directory and return all .ts file paths relative to baseDir.
 *
 * @param dir - Absolute directory path to scan.
 * @param baseDir - Base directory used to calculate relative paths.
 * @returns Relative paths such as ["index.ts", "core/logging.ts"].
 *
 * Example:
 *   scanTsFiles("/project/src", "/project/src")
 *   -> ["index.ts", "core/logging.ts", "utils.ts", ...]
 */
function scanTsFiles(dir: string, baseDir: string): string[] {
  // Collect all relative .ts file paths found under dir.
  const results: string[] = [];

  // Missing directories are allowed because some explained-code folders may
  // not have been created yet.
  if (!fs.existsSync(dir)) {
    return results;
  }

  // Read both files and subdirectories.
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    // Build the full path for the current entry.
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Recurse into subdirectories and merge their results.
      results.push(...scanTsFiles(fullPath, baseDir));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      // For .ts files, calculate the relative path and add it to the result.
      // Example: path.relative("/project/src", "/project/src/core/logging.ts")
      // -> "core/logging.ts"
      results.push(path.relative(baseDir, fullPath));
    }
  }

  return results;
}

// ============================================================
// Strip comments with the TypeScript compiler API
// ============================================================

/**
 * Collect the start and end ranges for all comments in the source text.
 *
 * TypeScript's getLeadingCommentRanges and getTrailingCommentRanges report
 * comments before and after a node, including // line comments and block
 * comments. We walk every AST node and collect all [pos, end] ranges.
 *
 * @param sourceFile - AST returned by ts.createSourceFile.
 * @param text - Original source text.
 * @returns Comment ranges as [{pos, end}, ...].
 */
function collectCommentRanges(
  sourceFile: ts.SourceFile,
  text: string,
): Array<{ pos: number; end: number }> {
  // Store every comment range found during traversal.
  const ranges: Array<{ pos: number; end: number }> = [];

  /**
   * Walk AST nodes recursively and collect comment ranges around each node.
   *
   * We use ts.forEachChild instead of ts.visitEachChild because this is a
   * read-only traversal. We only need to visit child nodes, not return updated
   * nodes from a visitor callback.
   */
  function visit(node: ts.Node): void {
    // Comments before the node, such as JSDoc before a function.
    const leading = ts.getLeadingCommentRanges(text, node.getFullStart());
    if (leading) {
      for (const range of leading) {
        ranges.push({ pos: range.pos, end: range.end });
      }
    }

    // Comments after the node, such as an end-of-line // comment.
    const trailing = ts.getTrailingCommentRanges(text, node.getEnd());
    if (trailing) {
      for (const range of trailing) {
        ranges.push({ pos: range.pos, end: range.end });
      }
    }

    // Continue walking child nodes.
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return ranges;
}

/**
 * Remove all comments from source text and return code-only text.
 *
 * Steps:
 *   1. Parse the source with ts.createSourceFile.
 *   2. Collect all comment [pos, end] ranges.
 *   3. Sort and deduplicate ranges. Different nodes may report the same range.
 *   4. Remove those ranges from the original text and join the remaining parts.
 *
 * @param code - Original TypeScript source code.
 * @param fileName - File name, used only for parser diagnostics.
 * @returns Code with comments removed.
 *
 * Example:
 *   stripComments("const x = 1; // comment", "a.ts")
 *   -> "const x = 1; "
 */
function stripComments(code: string, fileName: string): string {
  // Parse source into an AST.
  // ScriptTarget.Latest uses the latest ECMAScript grammar supported by TypeScript.
  // The true argument enables setParentNodes so nodes keep parent references.
  const sourceFile = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    true,
  );

  // Collect all comment ranges.
  const ranges = collectCommentRanges(sourceFile, code);

  // Sort ranges by start position so later processing can move left to right.
  ranges.sort((a, b) => a.pos - b.pos);

  // Deduplicate identical ranges.
  // Duplicates can happen because adjacent nodes may share the same comment
  // range. For example, a comment before const a = 1 may be reported as leading
  // trivia for the next node and also by nearby nodes.
  const unique: Array<{ pos: number; end: number }> = [];
  for (const r of ranges) {
    // Because the list is sorted, only the previous range needs comparison.
    if (unique.length === 0 || unique[unique.length - 1].pos !== r.pos || unique[unique.length - 1].end !== r.end) {
      unique.push(r);
    }
  }

  // Remove comment ranges from the original text and join the remaining parts.
  // cursor tracks the current read position while skipping comment ranges.
  const parts: string[] = [];
  let cursor = 0;
  for (const r of unique) {
    if (r.pos > cursor) {
      // Keep the code text before the comment.
      parts.push(code.slice(cursor, r.pos));
    }
    // Skip the comment range.
    cursor = r.end;
  }
  // Keep the final code segment after the last comment.
  if (cursor < code.length) {
    parts.push(code.slice(cursor));
  }

  return parts.join("");
}

// ============================================================
// Normalize code text
// ============================================================

/**
 * Normalize code text.
 *
 * After comments are removed, their old positions may leave extra blank lines
 * or whitespace. Normalization:
 *   1. Split into lines.
 *   2. Trim each line.
 *   3. Remove empty lines.
 *
 * This avoids false positives when explained comments use different line counts
 * while the executable code is still identical.
 *
 * @param code - Code after comments have been removed.
 * @returns Normalized non-empty lines.
 */
function normalizeCode(code: string): string[] {
  return code
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

// ============================================================
// Compare code-only file contents
// ============================================================

/**
 * Compare two files after comments have been removed.
 *
 * @param relativePath - Relative path, used for display.
 * @param sourceCode - Original working source code.
 * @param explainedCode - Original explained-copy source code.
 * @returns true if code matches, false if it differs.
 */
function compareFiles(
  relativePath: string,
  sourceCode: string,
  explainedCode: string,
): boolean {
  // Strip comments and normalize both sides.
  const sourceLines = normalizeCode(stripComments(sourceCode, relativePath));
  const explainedLines = normalizeCode(stripComments(explainedCode, relativePath));

  // Exact line equality means the executable code matches.
  if (sourceLines.length === explainedLines.length && sourceLines.every((line, i) => line === explainedLines[i])) {
    return true;
  }

  // Print a focused diff report.
  console.log("\n  Difference details:");

  // Compare line by line up to the longer side.
  const maxLen = Math.max(sourceLines.length, explainedLines.length);
  // Limit displayed differences to avoid flooding the terminal.
  let diffCount = 0;
  const MAX_DIFF_LINES = 10;

  for (let i = 0; i < maxLen; i++) {
    const sourceLine = sourceLines[i] ?? "(none)";
    const explainedLine = explainedLines[i] ?? "(none)";

    if (sourceLine !== explainedLine) {
      diffCount++;
      if (diffCount <= MAX_DIFF_LINES) {
        // Show line number and content from both sides.
        console.log(`    Line ${i + 1}:`);
        console.log(`      source:    ${sourceLine}`);
        console.log(`      explained: ${explainedLine}`);
      }
    }
  }

  if (diffCount > MAX_DIFF_LINES) {
    console.log(`    ... ${diffCount - MAX_DIFF_LINES} more differences not shown`);
  }

  console.log(`  Total differences: ${diffCount}`);
  return false;
}

// ============================================================
// Main flow
// ============================================================

function main(): void {
  console.log("=== Code Sync Check ===\n");

  // hasError controls the final exit code.
  let hasError = false;

  // Check each source/explained directory pair.
  for (const [sourceDir, explainedDir, label] of DIR_PAIRS) {
    console.log(`--- ${label}/ <-> docs/code-explained/${label}/ ---`);

    // Scan all .ts files on both sides.
    const sourceFiles = new Set(scanTsFiles(sourceDir, sourceDir));
    const explainedFiles = new Set(scanTsFiles(explainedDir, explainedDir));

    // Merge file paths from both sides so missing files are also reported.
    const allFiles = new Set([...sourceFiles, ...explainedFiles]);

    if (allFiles.size === 0) {
      console.log("  (no .ts files, skipped)\n");
      continue;
    }

    // Sort alphabetically for stable, readable output.
    const sortedFiles = [...allFiles].sort();

    for (const relativePath of sortedFiles) {
      // Use forward slashes in output for Windows compatibility and readability.
      const displayPath = relativePath.replace(/\\/g, "/");

      const inSource = sourceFiles.has(relativePath);
      const inExplained = explainedFiles.has(relativePath);

      if (!inSource) {
        // Exists only in the explained copy.
        console.log(`[missing] ${displayPath} exists only in docs/code-explained/${label}/; missing from ${label}/`);
        hasError = true;
        continue;
      }

      if (!inExplained) {
        // Exists only in working code.
        console.log(`[missing] ${displayPath} exists only in ${label}/; missing from docs/code-explained/${label}/`);
        hasError = true;
        continue;
      }

      // Both sides have the file, so read and compare their code-only content.
      const sourceCode = fs.readFileSync(path.join(sourceDir, relativePath), "utf-8");
      const explainedCode = fs.readFileSync(path.join(explainedDir, relativePath), "utf-8");

      const isMatch = compareFiles(relativePath, sourceCode, explainedCode);

      if (isMatch) {
        console.log(`[match] ${displayPath}`);
      } else {
        console.log(`[diff] ${displayPath}`);
        hasError = true;
      }
    }

    console.log();
  }

  // Summary and process exit code.
  console.log("=== Check Complete ===");
  if (hasError) {
    console.log("Result: differences or missing files exist. Check the report above.");
    process.exit(1);
  } else {
    console.log("Result: all code matches.");
    process.exit(0);
  }
}

// Run the script.
main();
