/**
 * PDF 转图片模块
 *
 * 负责将 PDF 文件转换为高质量 JPEG 图片序列。
 * 使用 mupdf.js（PyMuPDF 的官方 JavaScript/WASM 版本）进行 PDF 渲染。
 *
 * 主要功能：
 * - 将 PDF 的每一页渲染为 JPEG 图片
 * - 支持自定义 DPI（分辨率）
 * - 支持指定页面范围（如 "1-5,10,15-20"）
 * - 支持断点续传（跳过已存在的有效图片）
 *
 * 依赖：mupdf（mupdf.js WASM 版，通过 npm install mupdf 安装）
 *
 * 示例用法：
 *   import { convertPdfToImages } from "./pdf_to_images.js";
 *   // 转换全部页面
 *   const outputDir = convertPdfToImages("input.pdf", "output/images", 150);
 *   // 只转换第1-10页
 *   const outputDir2 = convertPdfToImages("input.pdf", "output/images", 150, "1-10");
 */

// fs 是 Node.js 内置的文件系统模块
// 这里用到：readFileSync（读取 PDF 文件为二进制）、writeFileSync（写入 JPEG 图片）、
//   existsSync（检查文件/目录是否存在）、mkdirSync（创建目录）、
//   readdirSync（列出目录中的文件）、statSync（获取文件元信息如大小）
import fs from "fs";
// path 是 Node.js 内置的路径处理模块
// 这里用到：path.join（路径拼接，如 path.join("output", "page_0001.jpg")）
import path from "path";
// mupdf 是 MuPDF 的官方 JavaScript/WASM 绑定
// 提供 PDF 文档解析、页面渲染、图像生成等功能
// 它是 Python 版 PyMuPDF (fitz) 的 JS 对应物
// 这里用到：PDFDocument（打开 PDF 文件）、Matrix（缩放矩阵）、ColorSpace（颜色空间）
// 官方文档：https://mupdfjs.readthedocs.io/
import * as mupdf from "mupdf";

// ============================================================
// isImageValid — 图片有效性检查
// ============================================================

/**
 * 检查图片文件是否有效且完整。
 *
 * 简化版验证：只检查文件是否存在且大小合理（>= 512 字节）。
 * 因为图片是我们自己用 mupdf 渲染生成的，格式损坏的概率极低，
 * 所以不需要像 Python 版那样用 PIL 做完整性验证。
 *
 * Python 版对比：
 *   Python 版使用 PIL.Image.open().verify() 做完整的图片解码验证
 *   TS 版简化为仅检查文件大小，避免引入额外的图像处理库
 *
 * 示例：
 *   isImageValid("/output/page_0001.jpg")  → true（文件存在且 > 512 字节）
 *   isImageValid("/output/page_0001.jpg")  → false（文件不存在或太小）
 *
 * @param imagePath 图片文件的绝对或相对路径
 * @returns 文件有效返回 true，否则返回 false
 */
export function isImageValid(imagePath: string): boolean {
  try {
    // 用 statSync 获取文件元信息，如果文件不存在会抛出异常
    const stat = fs.statSync(imagePath);
    // 512 字节是一个经验阈值：
    // 正常的 JPEG 图片至少有文件头 + 少量像素数据，远大于 512 字节
    // 如果文件小于 512 字节，大概率是写入中断导致的损坏文件
    if (stat.size < 512) {
      return false;
    }
    return true;
  } catch {
    // 文件不存在或无法访问时，statSync 会抛出 ENOENT 等异常
    return false;
  }
}

// ============================================================
// parsePageRange — 页面范围解析
// ============================================================

/**
 * 解析页面范围字符串，返回 0-indexed 的页码数组。
 *
 * 这是一个纯逻辑函数，将用户友好的页码描述（1-indexed）转换为程序内部使用的索引（0-indexed）。
 *
 * 支持的格式：
 *   - 单页:    "5"          → [4]              （第5页，0-indexed = 4）
 *   - 范围:    "1-10"       → [0,1,2,...,9]    （第1到10页）
 *   - 混合:    "1-5,10,15-20" → [0,1,2,3,4,9,14,15,16,17,18,19]
 *   - 全部:    undefined / "" → [0,1,2,...,totalPages-1]
 *
 * 注意事项：
 *   - 用户输入的页码是 1-indexed（第1页 = 人类理解的第一页）
 *   - 返回值是 0-indexed（第1页 = 索引0），与 mupdf 的 loadPage(n) 一致
 *   - 如果结束页超出总页数，会自动调整为最后一页（不报错）
 *   - 单页超出范围时会抛出 ValueError
 *
 * @param pageRange 页面范围字符串，如 "1-5,10"；undefined 或空字符串表示全部页面
 * @param totalPages PDF 的总页数
 * @returns 排序后的 0-indexed 页码数组（已去重）
 * @throws Error 页面范围格式错误或单页超出范围时抛出
 */
export function parsePageRange(
  pageRange: string | undefined,
  totalPages: number
): number[] {
  // 第一步：处理空值情况——未指定页面范围时，返回所有页面
  if (!pageRange || pageRange.trim() === "") {
    // Array.from({ length: N }, (_, i) => i) 是生成 [0, 1, 2, ..., N-1] 的惯用写法
    // 等价于 Python 的 list(range(totalPages))
    return Array.from({ length: totalPages }, (_, i) => i);
  }

  // 第二步：用 Set 收集页码，自动去重
  // 例如 "1-5,3-7" 中页码 3、4、5 会出现两次，Set 只保留一份
  const pages = new Set<number>();

  // 第三步：按逗号分割，逐段解析
  // 先去除所有空格，然后按逗号分割
  // 例如 "1-5, 10, 15-20" → ["1-5", "10", "15-20"]
  const parts = pageRange.replace(/ /g, "").split(",");

  for (const part of parts) {
    if (part.includes("-")) {
      // ---- 范围格式: "1-10" ----
      const segments = part.split("-");
      // split("-") 对 "1-10" 返回 ["1", "10"]，长度应为 2
      if (segments.length !== 2) {
        throw new Error(`无效的页面范围格式: ${part}`);
      }

      // 用 ! 断言 segments[0] 和 segments[1] 不为 undefined
      // 因为 split("-") 对 "1-10" 一定返回两个元素
      const start = parseInt(segments[0]!, 10);
      const end = parseInt(segments[1]!, 10);

      // parseInt 对非数字字符串返回 NaN
      if (isNaN(start) || isNaN(end)) {
        throw new Error(`无效的页面范围格式: ${part}`);
      }

      // 起始页必须 >= 1（用户视角的页码从 1 开始）
      if (start < 1) {
        throw new Error(`页面范围 ${part} 起始页必须 >= 1`);
      }

      if (start > end) {
        throw new Error(
          `无效的页面范围: ${part}，起始页 ${start} 大于结束页 ${end}`
        );
      }

      // 结束页超出总页数时，自动调整为实际总页数（宽容处理）
      let adjustedEnd = end;
      if (end > totalPages) {
        console.log(
          `⚠ 页面范围 ${part} 结束页超出实际页数，自动调整: ${end} -> ${totalPages}`
        );
        adjustedEnd = totalPages;
      }

      // 将用户页码（1-indexed）转换为程序索引（0-indexed）
      // 例如用户输入 "1-3" → 索引 0, 1, 2
      for (let i = start - 1; i < adjustedEnd; i++) {
        pages.add(i);
      }
    } else {
      // ---- 单页格式: "5" ----
      const page = parseInt(part, 10);

      if (isNaN(page)) {
        throw new Error(`无效的页码: ${part}`);
      }

      // 单页必须在有效范围内 [1, totalPages]
      if (page < 1 || page > totalPages) {
        throw new Error(`页码 ${page} 超出范围 (1-${totalPages})`);
      }

      // 转换为 0-indexed
      pages.add(page - 1);
    }
  }

  // 第四步：将 Set 转为数组并排序
  // 排序确保页面按顺序处理，输出文件名与页码一致
  return [...pages].sort((a, b) => a - b);
}

// ============================================================
// convertPdfToImages — PDF 转图片核心函数
// ============================================================

/**
 * 将 PDF 文件转换为 JPEG 图片序列。
 *
 * 详细流程：
 *   1. 检查输入 PDF 文件是否存在
 *   2. 创建输出目录（如果不存在）
 *   3. 用 mupdf 打开 PDF 文件
 *   4. 解析页面范围，确定要转换的页面
 *   5. 遍历每一页，渲染为指定 DPI 的 Pixmap，再导出为 JPEG
 *   6. 支持断点续传——跳过已存在的有效图片
 *
 * API 映射（Python fitz → TypeScript mupdf.js）：
 *   fitz.open(path)             → mupdf.PDFDocument.openDocument(buffer, "application/pdf")
 *   doc.page_count              → doc.countPages()
 *   doc.load_page(n)            → doc.loadPage(n)
 *   fitz.Matrix(zoom, zoom)     → mupdf.Matrix.scale(zoom, zoom)
 *   page.get_pixmap(matrix=m)   → page.toPixmap(matrix, colorSpace, alpha)
 *   pix.save(path, "jpeg", 90)  → pixmap.asJPEG(90) + fs.writeFileSync(path, data)
 *
 * 注意：mupdf.js 的 asJPEG() 返回 Uint8Array 而不是直接保存文件，
 * 所以需要额外调用 fs.writeFileSync 写入磁盘。
 *
 * 示例：
 *   // 转换全部页面，DPI=150
 *   convertPdfToImages("input.pdf", "output/images");
 *
 *   // 转换全部页面，DPI=300（更高清晰度，文件更大）
 *   convertPdfToImages("input.pdf", "output/images", 300);
 *
 *   // 只转换第 1-10 页
 *   convertPdfToImages("input.pdf", "output/images", 150, "1-10");
 *
 *   // 转换指定页面
 *   convertPdfToImages("input.pdf", "output/images", 150, "1-5,10,20-25");
 *
 * @param pdfPath    输入 PDF 文件路径
 * @param outputDir  输出图片目录路径
 * @param dpi        图像分辨率，默认 150（72 是 PDF 原始 DPI，150 约为 2 倍放大）
 * @param pageRange  页面范围字符串，undefined 表示全部页面
 * @returns 输出目录路径字符串
 * @throws Error 文件不存在、PDF 损坏或保存失败时抛出
 */
export function convertPdfToImages(
  pdfPath: string,
  outputDir: string,
  dpi: number = 150,
  pageRange?: string
): string {
  // ---- 第一步：检查输入文件是否存在 ----
  if (!fs.existsSync(pdfPath)) {
    const errorMsg = `错误：找不到指定的PDF文件！路径: ${pdfPath}`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  // ---- 第二步：创建输出目录 ----
  // recursive: true 等价于 Python 的 mkdir(parents=True, exist_ok=True)
  // 即使父目录不存在也会一并创建，目录已存在也不报错
  fs.mkdirSync(outputDir, { recursive: true });
  console.log(`图片将保存在: ${outputDir}`);

  // ---- 第三步：读取 PDF 文件并用 mupdf 打开 ----
  console.log("开始将PDF转换为图片...");

  // mupdf.js 不直接接受文件路径，需要先读取为二进制数据
  // readFileSync 返回 Node.js Buffer，可以直接传给 mupdf（兼容 Uint8Array 接口）
  const pdfData = fs.readFileSync(pdfPath);

  // PDFDocument.openDocument 打开 PDF 文件，返回 PDFDocument 实例
  // 使用 PDFDocument（而非基类 Document）是因为我们明确处理 PDF 格式，
  // 这样 loadPage() 直接返回 PDFPage 类型，不需要类型断言
  // 第二个参数 magic 指定文件 MIME 类型，帮助 mupdf 识别格式
  // 参考：https://mupdfjs.readthedocs.io/en/latest/how-to-guide/files.html
  const doc = mupdf.PDFDocument.openDocument(pdfData, "application/pdf");

  try {
    // ---- 第四步：获取总页数并解析页面范围 ----
    const totalPages = doc.countPages();

    const pagesToConvert = parsePageRange(pageRange, totalPages);

    if (pageRange) {
      console.log(`将转换 ${pagesToConvert.length}/${totalPages} 页`);
    } else {
      console.log(`将转换全部 ${totalPages} 页`);
    }

    // ---- 第五步：检测已存在的图片（断点续传） ----
    // 扫描输出目录，找出所有已有的 page_XXXX.jpg 文件
    // 如果之前的转换中途中断，下次运行时可以跳过已完成的页面
    const existingImages = new Set<string>();
    if (fs.existsSync(outputDir)) {
      const files = fs.readdirSync(outputDir);
      for (const file of files) {
        // 只收集符合命名规则的文件：以 "page_" 开头、".jpg" 结尾
        if (file.startsWith("page_") && file.endsWith(".jpg")) {
          existingImages.add(file);
        }
      }
    }
    console.log(`检测到 ${existingImages.size} 个已存在的图片文件`);

    // ---- 第六步：遍历页面，逐页渲染并保存 ----
    // 计算缩放比例：PDF 基础 DPI 为 72，zoom = dpi / 72
    // 例如 dpi=150 → zoom≈2.08，即页面放大约 2 倍渲染
    const zoom = dpi / 72;
    let convertedCount = 0;

    for (const pageNum of pagesToConvert) {
      // 生成输出文件名：page_0001.jpg, page_0002.jpg, ...
      // padStart(4, "0") 将数字填充为 4 位，如 1 → "0001"
      // pageNum 是 0-indexed，文件名用 1-indexed（+1），与用户视角一致
      const imageName = `page_${String(pageNum + 1).padStart(4, "0")}.jpg`;
      const imagePath = path.join(outputDir, imageName);

      // ---- 断点续传：检查图片是否已存在且有效 ----
      if (existingImages.has(imageName) && isImageValid(imagePath)) {
        console.log(`跳过已存在的有效图片: ${imageName}`);
        continue;
      } else if (existingImages.has(imageName) && !isImageValid(imagePath)) {
        console.log(`检测到损坏的图片文件，重新生成: ${imageName}`);
      }

      // ---- 加载页面并渲染为 Pixmap ----
      // loadPage(n) 接受 0-indexed 页码
      const page = doc.loadPage(pageNum);

      // Matrix.scale(zoom, zoom) 创建等比缩放矩阵
      // 等价于 Python 的 fitz.Matrix(zoom, zoom)
      const matrix = mupdf.Matrix.scale(zoom, zoom);

      // toPixmap 将页面渲染为像素图
      // 参数说明（参考 https://mupdfjs.readthedocs.io/en/latest/how-to-guide/page.html）：
      //   matrix     — 缩放矩阵，控制输出分辨率
      //   colorspace — 颜色空间，DeviceRGB 适合 JPEG 输出
      //   alpha      — 是否包含透明通道，false 因为 JPEG 不支持透明
      //   showExtras — 是否渲染页面上的注释/标注，true 保留完整页面内容
      const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);

      // ---- 导出为 JPEG 并写入文件 ----
      // asJPEG(quality) 返回 Uint8Array（JPEG 二进制数据）
      // quality=90 表示 JPEG 压缩质量为 90%，在画质和文件大小之间取平衡
      // 与 Python 版的 pix.save(path, "jpeg", jpg_quality=90) 效果一致
      const jpegData = pixmap.asJPEG(90);
      fs.writeFileSync(imagePath, jpegData);

      // 释放 Page 和 Pixmap 占用的 WASM 内存
      // mupdf.js 中的对象存在于 WASM 堆上，不受 JS 垃圾回收管理
      // 必须手动调用 destroy() 释放，否则会导致内存泄漏
      // 官方文档明确建议销毁所有不再使用的对象
      // 参考：https://mupdfjs.readthedocs.io/en/latest/how-to-guide/destroy.html
      pixmap.destroy();
      page.destroy();

      convertedCount++;
    }

    console.log(
      `转换完成！共转换 ${pagesToConvert.length} 页` +
        `（实际处理 ${convertedCount} 页，跳过已存在的有效图片）`
    );
    return outputDir;
  } finally {
    // ---- 资源清理 ----
    // try/finally 确保即使渲染过程中抛出异常，也会释放 Document 对象
    // 等价于 Python 的 with fitz.open(pdf_path) as doc: 上下文管理器
    doc.destroy();
  }
}
