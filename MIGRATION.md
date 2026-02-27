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
│   ├── concurrent_utils.py              ✅ 已迁移 → src/concurrent_utils.ts
│   ├── cost_calculator.py               ✅ 已迁移 → src/cost_calculator.ts
│   ├── llm_client.py                    ✅ 已迁移 → src/llm_client.ts
│   ├── model_manager.py                 🔀 功能已被 model_caller.ts 完全覆盖；src/model_manager.ts 已删除（死代码）
│   ├── model_caller.py                  ✅ 已迁移 → src/model_caller.ts
│   ├── conversation_manager.py          🚫 不迁移（对话管理由 conductor workflow 框架自身实现）
│   ├── pdf_to_images.py                 🚫 TS 生态替代方案待定
│   ├── manage_test_headers.py           🚫 不迁移（pytest 辅助工具）
│   ├── workflow_engine.py               ✅ 已迁移 → src/workflow_engine.ts
│   ├── workflow_loader.py               ⏳ 待迁移
│   ├── workflow_parser.py               ✅ 已迁移 → src/workflow_parser.ts
│   ├── core/
│   │   ├── logging.py                   ✅ 已迁移 → src/core/logging.ts
│   │   └── workflow_runner.py           ⏳ 待迁移
│   ├── validators/
│   │   ├── base.py                      ✅ 已迁移 → src/validators/base.ts
│   │   ├── simple_json_validator.py     ✅ 已迁移 → src/validators/simple_json_validator.ts
│   │   └── pdf_page_validator.py        ⏳ 待迁移（依赖 pdf_to_images）
│   ├── workflow_actions/
│   │   ├── base.py                      ✅ 已迁移 → src/workflow_actions/base.ts
│   │   ├── llm_actions.py               ✅ 已迁移 → src/workflow_actions/llm_actions.ts
│   │   ├── concurrent_actions.py        ✅ 已迁移 → src/workflow_actions/concurrent_actions.ts
│   │   ├── data_actions.py              ✅ 已迁移 → src/workflow_actions/data_actions.ts
│   │   ├── io_actions.py                ✅ 已迁移 → src/workflow_actions/io_actions.ts
│   │   ├── utils.py                     ✅ 已迁移 → src/workflow_actions/utils.ts
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

## 迁移注意事项

### `workflow_actions/utils.py` → 工厂函数不迁移

`create_simple_action` / `create_llm_action` 两个工厂函数不迁移。
理由：仅是构造函数的薄包装，TS 有类型提示后直接 `new` 更清晰，无保留价值。

---

### `workflow_actions/concurrent_actions.py` → 使用函数式 API

Python 版调用 `ConcurrentProcessor` 类（`processor.process_batch(...)`），
TS 版已精简为单一函数 `concurrentProcess(...)`，迁移时需改写调用方式：

```python
# Python（旧）
processor = ConcurrentProcessor(max_concurrent=5)
stats = processor.process_batch(items, process_func)
```

```typescript
// TypeScript（新）
const stats = await concurrentProcess(items, processFunc, 5);
```

---

### `workflow_loader.py` → 改进 YAML 字段缺失时的报错

Python 版 loader 对必填字段缺失的处理不够清晰，例如 `data_process` 类型的步骤如果漏写 `processor` 字段：

```python
# 当前行为：config.get("processor") 返回 None，然后报"未注册"
处理器 'None' 未注册    # ← 误导，实际是字段没写

# 迁移时改为：先检查字段是否存在，再检查是否注册
步骤 'xxx' 缺少必填字段 'processor'   # ← 真正的原因
```

迁移时对所有 action 类型的必填字段都加上这种前置检查。

---

## 迁移后待重构事项

迁移完成后需要整理的结构问题（不影响当前迁移进度）：

### `src/model_caller.ts` 模型配置外置 ✅

`MODEL_MAPPINGS` 已抽取到项目根目录的 `models.yaml`：
- `api_key` 字段使用 `${ENV_VAR}` 占位符，启动时自动读取环境变量
- 修改模型配置或切换提供商只需编辑 `models.yaml` 并重启，无需重编译
- `reloadModels()` 支持运行时热重载
- `js-yaml` 已安装，`workflow_loader.ts` 迁移时可直接使用

---

### `src/llm_client.ts` 职责拆分

当前 `llm_client.ts` 混入了两个不太属于它的函数：

- **`estimateTokensFromText`** — token 估算逻辑，应移入 `cost_calculator.ts`（该文件本就负责成本/token相关计算）
- **`processMessagesWithImages`** — 图片预处理逻辑，可移入 `utils.ts`（`imageToBase64`、`getImageMimeType` 已在那里）

拆分后 `llm_client.ts` 只保留：核心 HTTP 调用（`callLlmApi`）、简单包装（`chat`）、熔断检查（`isLlmEnabled`）、`sleep`。

---

## 参考

- 原项目 YAML 语法文档：`../LLM_agent/docs/workflow_grammar/`
- 原项目完整工作流示例：`../LLM_agent/workflows/`
