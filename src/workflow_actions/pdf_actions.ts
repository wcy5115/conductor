/**
 * PDF 处理动作
 *
 * 将 PDF 转图片功能封装为工作流步骤（BaseAction 子类），
 * 使得 YAML 工作流定义中可以直接使用 pdf_to_images 类型的步骤。
 *
 * 内部调用 src/pdf_to_images.ts 的 convertPdfToImages 函数完成实际转换，
 * 本模块只负责：
 *   1. 从 YAML 配置中读取参数（pdf_path、output_dir、dpi 等）
 *   2. 用 context.data 解析路径模板中的占位符
 *   3. 调用转换函数
 *   4. 将结果（图片目录、文件列表、数量）写入 context.data 供后续步骤使用
 *
 * 依赖关系：
 *   pdf_actions.ts → pdf_to_images.ts → mupdf（WASM）
 *
 * YAML 配置示例：
 *   steps:
 *     "1":
 *       type: "pdf_to_images"
 *       pdf_path: "{input_pdf}"
 *       output_dir: "./output/images"
 *       dpi: 150
 *       page_range: "1-10"
 *       output_key: "pdf_images_dir"
 *       next_step: "2"
 */

// fs 是 Node.js 内置的文件系统模块
// 这里用到：readdirSync（列出目录中的文件，用于获取生成的图片列表）
import fs from "fs";
// path 是 Node.js 内置的路径处理模块
// 这里用到：path.join（拼接目录和文件名，构建图片的完整路径）
import path from "path";
// WorkflowContext 是工作流的全局上下文，其中 context.data 是步骤间共享的数据容器
// StepResult 是每个步骤执行完毕后的返回值，包含：下一步名称、新数据、元数据
import { WorkflowContext, StepResult } from "../workflow_engine.js";
// BaseAction 是所有动作的基类，提供 run() 方法，内部会调用子类实现的 execute()
import { BaseAction } from "./base.js";
// convertPdfToImages 是 PDF 转图片的核心函数，负责调用 mupdf 渲染每一页
import { convertPdfToImages } from "../pdf_to_images.js";
// formatPathTemplate 将路径模板中的 {key} / {key:04d} 占位符替换为实际值
import { formatPathTemplate } from "./utils.js";

// ============================================================
// PDFToImagesAction — PDF 转图片动作
// ============================================================

/**
 * PDF 转图片动作
 *
 * 将 PDF 文件转换为 JPEG 图片序列，支持页面范围选择。
 * 是 convertPdfToImages 函数的工作流封装层。
 *
 * 执行流程：
 *   1. 用 context.data 解析 pdfPath 和 outputDir 中的模板变量
 *   2. 调用 convertPdfToImages 执行实际转换
 *   3. 扫描输出目录，收集生成的图片文件列表
 *   4. 将图片目录路径、文件列表、图片数量写入 context.data
 *
 * 写入 context.data 的键：
 *   - {outputKey}         → 输出目录路径（如 "./output/images"）
 *   - {outputKey}_files   → 图片文件完整路径数组（如 ["./output/images/page_0001.jpg", ...]）
 *   - {outputKey}_count   → 图片文件数量（如 20）
 *
 * 示例：
 *   假设 outputKey = "pdf_images_dir"，转换完成后 context.data 中会有：
 *     pdf_images_dir       = "./output/images"
 *     pdf_images_dir_files = ["./output/images/page_0001.jpg", "./output/images/page_0002.jpg", ...]
 *     pdf_images_dir_count = 20
 */
export class PDFToImagesAction extends BaseAction {
  // pdfPath：PDF 文件路径模板，支持 {var} 占位符
  // 例如 "{input_pdf}" 会在执行时被替换为 context.data.input_pdf 的值
  private readonly pdfPath: string;
  // outputDir：输出目录路径模板，同样支持 {var} 占位符
  private readonly outputDir: string;
  // dpi：图像分辨率，默认 150
  // 72 是 PDF 原始 DPI，150 约为 2 倍放大，300 适合打印级质量
  private readonly dpi: number;
  // pageRange：页面范围字符串，如 "1-10" 或 "1-5,10,15-20"
  // undefined 表示转换全部页面
  private readonly pageRange: string | undefined;
  // outputKey：结果在 context.data 中的键名前缀
  // 默认 "pdf_images_dir"，会生成 pdf_images_dir、pdf_images_dir_files、pdf_images_dir_count 三个键
  private readonly outputKey: string;
  // nextStep：执行完毕后跳转到哪个步骤，默认 "END" 表示结束工作流
  private readonly nextStep: string;
  // stepId：步骤 ID，仅用于日志输出中的标识，不影响业务逻辑
  private readonly stepId: string;

  constructor(
    pdfPath: string,
    outputDir: string,
    dpi: number = 150,
    pageRange: string | undefined = undefined,
    outputKey: string = "pdf_images_dir",
    nextStep: string = "END",
    name: string = "PDF转图片",
    stepId: string = "unknown",
    config: Record<string, unknown> = {}
  ) {
    // 调用父类 BaseAction 的构造函数，初始化 name 和 config
    super(name, config);
    this.pdfPath = pdfPath;
    this.outputDir = outputDir;
    this.dpi = dpi;
    this.pageRange = pageRange;
    this.outputKey = outputKey;
    this.nextStep = nextStep;
    this.stepId = stepId;
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    // 第一步：解析路径模板中的占位符
    // 例如 pdfPath = "{input_pdf}"，context.data = { input_pdf: "test.pdf" }
    // 解析后 pdfPath = "test.pdf"
    let pdfPath: string;
    let outputDir: string;
    try {
      pdfPath = formatPathTemplate(this.pdfPath, context.data);
      outputDir = formatPathTemplate(this.outputDir, context.data);
    } catch (e) {
      throw new Error(`PDF路径模板缺少必要的上下文数据: ${e}`);
    }

    // 第二步：执行 PDF 转图片
    console.info(`[步骤${this.stepId}] 开始转换PDF: ${pdfPath} -> ${outputDir}`);
    const resultDir = convertPdfToImages(
      pdfPath,
      outputDir,
      this.dpi,
      this.pageRange
    );

    // 第三步：收集生成的图片文件列表
    // 使用严格的文件名匹配模式：page_0001.jpg 格式（"page_" + 4位数字 + ".jpg"）
    // 正则表达式拆解：
    //   ^page_    — 以 "page_" 开头
    //   \d{4}     — 恰好 4 位数字（0001, 0002, ...）
    //   \.jpg$    — 以 ".jpg" 结尾
    // 这种严格匹配避免误收录其他 .jpg 文件（如用户手动放入的文件）
    const resultPath = path.resolve(resultDir);
    const imageFiles = fs
      .readdirSync(resultPath)
      .filter((f) => /^page_\d{4}\.jpg$/.test(f))
      .sort()
      .map((f) => path.join(resultPath, f));

    console.info(
      `[步骤${this.stepId}] PDF转换完成，生成 ${imageFiles.length} 张图片`
    );

    // 第四步：返回结果
    // 向 context.data 写入三个键：
    //   outputKey         → 输出目录路径
    //   outputKey_files   → 图片完整路径数组（排序后的）
    //   outputKey_count   → 图片数量
    // 元数据记录详细参数，供日志/调试使用
    return new StepResult(
      this.nextStep,
      {
        [this.outputKey]: resultDir,
        [`${this.outputKey}_files`]: imageFiles,
        [`${this.outputKey}_count`]: imageFiles.length,
      },
      {
        pdf_path: pdfPath,
        output_dir: resultDir,
        dpi: this.dpi,
        page_range: this.pageRange,
        image_count: imageFiles.length,
      }
    );
  }
}
