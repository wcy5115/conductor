// Vitest 配置文件
// defineConfig 是 Vitest 提供的类型安全配置函数
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 覆盖率配置
    coverage: {
      // 使用 V8 引擎内置的覆盖率收集器（Vitest 4 默认支持，无需额外安装）
      // V8 通过引擎层面的计数器追踪代码执行，比 Istanbul 的源码插桩更快
      provider: "v8",

      // 只统计 src/ 目录下的 .ts 文件（排除测试文件、配置文件、node_modules）
      include: ["src/**/*.ts"],

      // 报告格式：
      //   text — 终端表格输出，跑完测试直接看
      //   html — 生成 coverage/ 目录下的网页报告，可以逐行查看哪些代码未覆盖
      reporter: ["text", "html"],
    },
  },
});
