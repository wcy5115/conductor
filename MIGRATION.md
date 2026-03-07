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
│   ├── safety.py                        🔀 功能已合并到 llm_client.ts 的 isLlmEnabled()
│   ├── utils.py                         ✅ 已迁移 → src/utils.ts
│   ├── concurrent_utils.py              ✅ 已迁移 → src/concurrent_utils.ts
│   ├── cost_calculator.py               ✅ 已迁移 → src/cost_calculator.ts
│   ├── llm_client.py                    ✅ 已迁移 → src/llm_client.ts
│   ├── model_manager.py                 🔀 功能已被 model_caller.ts 完全覆盖；src/model_manager.ts 已删除（死代码）
│   ├── model_caller.py                  ✅ 已迁移 → src/model_caller.ts
│   ├── conversation_manager.py          🚫 不迁移（对话管理由 conductor workflow 框架自身实现）
│   ├── pdf_to_images.py                 ✅ 已迁移 → src/pdf_to_images.ts
│   ├── manage_test_headers.py           🚫 不迁移（pytest 辅助工具）
│   ├── workflow_engine.py               ✅ 已迁移 → src/workflow_engine.ts
│   ├── workflow_loader.py               ✅ 已迁移 → src/workflow_loader.ts
│   ├── workflow_parser.py               ✅ 已迁移 → src/workflow_parser.ts
│   ├── core/
│   │   ├── logging.py                   ✅ 已迁移 → src/core/logging.ts
│   │   └── workflow_runner.py           ✅ 已迁移 → src/core/workflow_runner.ts
│   ├── validators/
│   │   ├── base.py                      ✅ 已迁移 → src/validators/base.ts
│   │   ├── simple_json_validator.py     ✅ 已迁移 → src/validators/simple_json_validator.ts
│   │   └── pdf_page_validator.py        ✅ 已迁移 → src/validators/pdf_page_validator.ts
│   ├── workflow_actions/
│   │   ├── base.py                      ✅ 已迁移 → src/workflow_actions/base.ts
│   │   ├── llm_actions.py               ✅ 已迁移 → src/workflow_actions/llm_actions.ts
│   │   ├── concurrent_actions.py        ✅ 已迁移 → src/workflow_actions/concurrent_actions.ts
│   │   ├── data_actions.py              ✅ 已迁移 → src/workflow_actions/data_actions.ts
│   │   ├── io_actions.py                ✅ 已迁移 → src/workflow_actions/io_actions.ts
│   │   ├── utils.py                     ✅ 已迁移 → src/workflow_actions/utils.ts
│   │   ├── pdf_actions.py               ✅ 已迁移 → src/workflow_actions/pdf_actions.ts
│   │   └── ebook_actions.py             ✅ 已迁移 → src/workflow_actions/ebook_actions.ts
│   └── cli/
│       └── clean.py                     ✅ 已迁移 → src/cli/clean.ts
├── tests/                               ⏳ 随各模块迁移同步补充
│   ├── unit/                            （对应 src/ 各模块）
│   └── integration/                     （对应 src/ 各模块）
├── workflows/                           ⏳ YAML 语法保持兼容，待验证
│   ├── pdf_ocr_concurrent/
│   ├── pdf_to_json_20pages/
│   └── ebook_translation/
├── apps/
│   ├── api_server/                      🚫 不迁移（薄壳应用层代码，不属于框架核心；需要时直接 import conductor 几行即可搭建）
│   └── chat_frontend/                   ✅ 已迁移 → apps/chat_frontend/
├── docs/                                ⏳ 待重写（内容针对 Python，需改为 TS 版本）
├── examples/                            ⏳ 待重写（Python 示例替换为 TS 示例）
├── scripts/                             ✅ 已迁移 → scripts/
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

### `src/llm_client.ts` 职责拆分 ✅

已完成拆分：

- **`estimateTokensFromText`** → 移入 `cost_calculator.ts`（token/成本计算集中管理）
- **`processMessagesWithImages`** → 移入 `utils.ts`（与 `imageToBase64`、`getImageMimeType` 放在一起）

拆分后 `llm_client.ts` 只保留：核心 HTTP 调用（`callLlmApi`）、简单包装（`chat`）、熔断检查（`isLlmEnabled`）、`sleep`。

---

### `ConditionalLLMAction` 继承 `LLMCallAction` ✅

已完成重构：`ConditionalLLMAction` 现在继承自 `LLMCallAction`，复用验证/重试/成本统计逻辑。

```
BaseAction                → 计时、日志、错误处理
  └─ LLMCallAction        → 模型调用、验证、重试、成本统计
       └─ ConditionalLLMAction  → 在此基础上加动态路由
```

---

### 新增外部通信 Action 类型 ⏳

当前工作流只能通过 `data_process` 注册自定义函数与外部通信，不够声明式。
需新增两个 Action 类型，让 YAML 直接声明外部调用：

| Action 类 | type 名称 | 用途 | 实现要点 |
|-----------|-----------|------|----------|
| `HttpRequestAction` | `http_request` | 发 HTTP 请求（调外部 API） | 用 `fetch` 发请求，响应写入 `context.data` |
| `SubprocessAction` | `subprocess` | 执行本地命令/脚本 | 用 `child_process.execFile` 执行，stdout 写入 `context.data` |

YAML 用法示例：

```yaml
# HTTP 请求
steps:
  2:
    type: http_request
    url: "https://api.example.com/process"
    method: POST
    body:
      text: "{1_response}"
    headers:
      Authorization: "Bearer {api_key}"

# 本地命令
steps:
  3:
    type: subprocess
    command: "python"
    args: ["scripts/postprocess.py", "--input", "{1_response_file}"]
```

实现步骤：
1. 在 `src/workflow_actions/` 新建 `external_actions.ts`，包含两个类
2. 在 `workflow_loader.ts` 的 switch 中各加一个 case
3. 补充单元测试

---

### 库化导出入口 ⏳

当前 `src/index.ts` 只有 `console.log("conductor")`，需改为统一 re-export：

```ts
export { WorkflowEngine, WorkflowContext, StepResult } from "./workflow_engine.js";
export { WorkflowLoader, loadWorkflowFromYaml } from "./workflow_loader.js";
// ... 其他公共 API
```

完成后即可作为 npm 库被外部项目 `import` 使用。

---

## 参考

- 原项目 YAML 语法文档：`../LLM_agent/docs/workflow_grammar/`
- 原项目完整工作流示例：`../LLM_agent/workflows/`
