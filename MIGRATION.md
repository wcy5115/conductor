# Conductor — 迁移说明

conductor 是 [LLM_agent](../LLM_agent) 的 TypeScript 重写版本。

---

## 为什么重写

- 前后端统一（原项目已有 JS 前端）
- TypeScript 类型系统对 YAML schema、JSON 验证等场景更友好
- LLM/AI 生态的 npm 包增长迅速
- 开发体验更接近现代 Web 工程

---

## 原项目模块 → TS 迁移对照

| Python 模块 | 说明 | TS 迁移状态 |
|------------|------|------------|
| `model_caller.py` | 统一模型调用接口 | 待迁移 |
| `llm_client.py` | LLM 底层封装（OpenAI/OpenRouter） | 待迁移 |
| `model_manager.py` | 模型配置管理 | 待迁移 |
| `conversation_manager.py` | 多轮对话管理 | 待迁移 |
| `workflow_engine.py` | 基于状态机的工作流引擎 | 待迁移 |
| `workflow_loader.py` | YAML 加载，构建引擎实例 | 待迁移 |
| `workflow_parser.py` | 工作流图（DAG）解析器 | 待迁移 |
| `workflow_actions/llm_actions.py` | LLMCallAction、ConditionalLLMAction | 待迁移 |
| `workflow_actions/concurrent_actions.py` | 并发处理列表项 | 待迁移 |
| `workflow_actions/io_actions.py` | 文件读写、日志、合并 JSON | 待迁移 |
| `workflow_actions/data_actions.py` | 数据处理、条件分支 | 待迁移 |
| `workflow_actions/pdf_actions.py` | PDF 转图片 | 低优先级 |
| `workflow_actions/ebook_actions.py` | ePub 处理 | 低优先级 |
| `validators/` | JSON 格式与业务验证器 | 待迁移 |
| `core/logging.py` | 结构化日志 | 待迁移 |
| `core/workflow_runner.py` | 工作流高层运行器 | 待迁移 |
| `exceptions.py` | 自定义异常 | 待迁移 |
| `cost_calculator.py` | LLM 调用成本计算 | 待迁移 |
| `concurrent_utils.py` | 并发工具函数 | 待迁移 |
| `utils.py` | 通用工具（文件保存等） | 待迁移 |
| `cli/` | 命令行清理工具 | 待迁移 |

---

## 核心概念保留

以下原项目的核心设计在 TS 版本中保持不变：

- **YAML 驱动**：工作流通过 `workflow.yaml` 声明，不写代码
- **步骤类型系统**：`llm`、`concurrent`、`data_process` 等 type 映射到 Action 类
- **三层 JSON 验证**：格式验证 → required 字段 → 业务验证器
- **占位符系统**：`{text}`、`{item}`、`{index}`、`{1_response}` 等
- **并发处理**：对列表并发执行，支持跳过已有输出文件

---

## 计划不迁移 / 重新设计的部分

- `pdf_to_images.py`（依赖 Python 的 pdf2image）— TS 生态替代方案待定
- `manage_test_headers.py`（测试辅助工具）— 不迁移
- `safety.py`（内容安全检查）— 视需求决定

---

## 参考

- 原项目 YAML 语法文档：`../LLM_agent/docs/workflow_grammar/`
- 原项目完整工作流示例：`../LLM_agent/workflows/`
