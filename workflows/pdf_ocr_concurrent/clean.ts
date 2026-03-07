/**
 * PDF OCR 并发处理工作流清理脚本
 *
 * 清理此工作流产生的中间文件（图片、OCR 文本等）。
 *
 * 使用方法：
 *   npx tsx workflows/pdf_ocr_concurrent/clean.ts
 */

// cleanDirectory：清理工作流输出目录的工具函数
// 支持删除 artifacts、results、logs 子目录，支持 dry-run 模式
import { cleanDirectory } from "../../src/cli/clean.js";

// ============================================================
// 主逻辑
// ============================================================

// 清理 data/pdf_ocr_concurrent/ 下的 artifacts 目录
// 保留 results/ 和 logs/
cleanDirectory("data/pdf_ocr_concurrent", {
  targets: ["artifacts"],
  deleteResults: false,
  deleteLogs: false,
});
