# Conductor — 迁移说明

conductor 是 [LLM_agent](../LLM_agent) 的 TypeScript 重写版本。

---

## 为什么重写

- 前后端统一（原项目已有 JS 前端）
- TypeScript 类型系统对 YAML schema、JSON 验证等场景更友好
- LLM/AI 生态的 npm 包增长迅速
- 开发体验更接近现代 Web 工程

---

## 迁移进度

### 图例

| 符号 | 含义 |
|------|------|
| `⏳` | 待迁移 |
| `✅` | 已迁移 |
| `🚫` | 无需迁移（archived / 测试辅助 / 低优先级） |
| `🔀` | 合并/重构（注明目标位置） |

### 原项目目录树

```
LLM_agent/
├── src/
│   ├── exceptions.py                    ✅ 已迁移 → src/exceptions.ts
│   ├── safety.py                        🚫 视需求决定
│   ├── utils.py                         ✅ 已迁移 → src/utils.ts
│   ├── concurrent_utils.py              ⏳ 待迁移
│   ├── cost_calculator.py               ✅ 已迁移 → src/cost_calculator.ts
│   ├── llm_client.py                    ✅ 已迁移 → src/llm_client.ts
│   ├── model_manager.py                 ✅ 已迁移 → src/model_manager.ts
│   ├── model_caller.py                  ⏳ 待迁移
│   ├── conversation_manager.py          ⏳ 待迁移
│   ├── pdf_to_images.py                 🚫 TS 生态替代方案待定
│   ├── manage_test_headers.py           🚫 不迁移（pytest 辅助工具）
│   ├── workflow_engine.py               ⏳ 待迁移
│   ├── workflow_loader.py               ⏳ 待迁移
│   ├── workflow_parser.py               ⏳ 待迁移
│   ├── core/
│   │   ├── logging.py                   ✅ 已迁移 → src/core/logging.ts
│   │   └── workflow_runner.py           ⏳ 待迁移
│   ├── validators/
│   │   ├── base.py                      ⏳ 待迁移
│   │   ├── simple_json_validator.py     ⏳ 待迁移
│   │   └── pdf_page_validator.py        ⏳ 待迁移（依赖 pdf_to_images）
│   ├── workflow_actions/
│   │   ├── base.py                      ⏳ 待迁移
│   │   ├── llm_actions.py               ⏳ 待迁移
│   │   ├── concurrent_actions.py        ⏳ 待迁移
│   │   ├── data_actions.py              ⏳ 待迁移
│   │   ├── io_actions.py                ⏳ 待迁移
│   │   ├── utils.py                     ⏳ 待迁移
│   │   ├── pdf_actions.py               🚫 低优先级（依赖 pdf_to_images）
│   │   └── ebook_actions.py             🚫 低优先级
│   └── cli/
│       └── clean.py                     ⏳ 待迁移
├── tests/                               ⏳ 随各模块迁移同步补充
│   ├── unit/                            （对应 src/ 各模块）
│   └── integration/                     （对应 src/ 各模块）
├── workflows/                           ⏳ YAML 语法保持兼容，待验证
│   ├── pdf_ocr_concurrent/
│   ├── pdf_to_json_20pages/
│   └── ebook_translation/
├── apps/
│   ├── api_server/                      ⏳ 待迁移（Express/Hono 重写）
│   └── chat_frontend/                   ⏳ 待适配（对接新 TS 后端 API）
├── docs/                                ⏳ 待重写（内容针对 Python，需改为 TS 版本）
├── examples/                            ⏳ 待重写（Python 示例替换为 TS 示例）
├── scripts/                             ⏳ 待评估（逐个确认是否需要重写）
└── archived/                            🚫 无需迁移
```

---

## 迁移后待重构事项

迁移完成后需要整理的结构问题（不影响当前迁移进度）：

### `src/llm_client.ts` 职责拆分

当前 `llm_client.ts` 混入了两个不太属于它的函数：

- **`estimateTokensFromText`** — token 估算逻辑，应移入 `cost_calculator.ts`（该文件本就负责成本/token相关计算）
- **`processMessagesWithImages`** — 图片预处理逻辑，可移入 `utils.ts`（`imageToBase64`、`getImageMimeType` 已在那里）

拆分后 `llm_client.ts` 只保留：核心 HTTP 调用（`callLlmApi`）、简单包装（`chat`）、熔断检查（`isLlmEnabled`）、`sleep`。

---

## 参考

- 原项目 YAML 语法文档：`../LLM_agent/docs/workflow_grammar/`
- 原项目完整工作流示例：`../LLM_agent/workflows/`
