/**
 * PDF 转 JSON 工作流清理脚本
 *
 * 清理此工作流产生的中间文件（图片、单页 JSON 等）。
 *
 * 使用方法：
 *   npx tsx workflows/pdf_to_json_20pages/clean.ts
 */

// cleanDirectory：清理工作流输出目录的工具函数
// 支持删除 artifacts、results、logs 子目录，支持 dry-run 模式
import { cleanDirectory } from "../../src/cli/clean.js";

// ============================================================
// 主逻辑
// ============================================================

// 清理 data/pdf_to_json_20pages/ 下的 artifacts 目录
// 同时删除 results 和 logs（与 Python 版行为一致）
cleanDirectory("data/pdf_to_json_20pages", {
  targets: ["artifacts"],
  deleteResults: true,
  deleteLogs: true,
});
