/**
 * 简单对话工作流启动器
 *
 * 使用方法：
 *   npx tsx workflows/chat/run.ts
 */

// dotenv：从 .env 文件加载环境变量（API 密钥等）
import "dotenv/config";

// path：Node.js 内置路径处理模块，用于定位同目录下的 workflow.yaml
import path from "path";

// fileURLToPath：将 import.meta.url（file:// 协议 URL）转换为普通文件路径
// 用法：fileURLToPath(import.meta.url) → 当前文件的绝对路径
import { fileURLToPath } from "url";

// WorkflowRunner：工作流一键启动器，封装了加载 YAML、创建引擎、执行、打印报告的完整流程
import { WorkflowRunner } from "../../src/core/workflow_runner.js";

// ============================================================
// 配置区：按需修改
// ============================================================

// MODEL：使用的模型简称，需与 models.yaml 中的 key 一致
const MODEL = "gpt35";

// USER_INPUT：发送给模型的提示词
const USER_INPUT = "你好，用一句话介绍一下你自己。";

// ============================================================
// 主函数
// ============================================================

async function main(): Promise<void> {
  // 第一步：定位当前文件所在目录，拼接 simple.yaml 的路径
  // import.meta.url 返回当前模块的 URL（如 file:///D:/xxx/run.ts）
  // fileURLToPath 将其转换为系统路径（如 D:/xxx/run.ts）
  // path.dirname 取其目录部分（如 D:/xxx/）
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const yamlPath = path.join(__dirname, "simple.yaml");

  // 第二步：从 YAML 创建 WorkflowRunner 实例
  const runner = await WorkflowRunner.fromYaml(yamlPath);

  // 第三步：执行工作流，传入初始数据
  // simple.yaml 中的 prompt 字段引用 {user_input}，model 字段引用 {model}
  // 这些变量通过 inputData 传入，引擎会自动替换模板占位符
  const result = await runner.run({
    inputData: {
      user_input: USER_INPUT,
      model: MODEL,
    },
  });

  // 第四步：根据结果退出
  if (result.status === "failed") {
    console.error(`工作流执行失败: ${result.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
