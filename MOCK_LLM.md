# Mock LLM 使用指南

Mock LLM 提供模拟的 LLM 响应，无需真实 API 调用，不产生任何费用。适用于开发调试、单元测试和 CI/CD。

## 快速开始

### 1. 在 `models.mock.yaml` 中配置 mock 模型

```yaml
mock-translate:
  provider: mock
  api_url: ""
  api_key: "mock"
  model_name: mock-translate
  mock_mappings:
    "请将以下文本翻译为英文：你好": '{"translation": "Hello"}'
    "请将以下文本翻译为英文：再见": '{"translation": "Goodbye"}'
```

### 2. 在工作流 YAML 中使用 mock 模型

```yaml
steps:
  translate:
    action: llm_call
    model: mock-translate
    prompt_template: "请将以下文本翻译为英文：{text}"
    validate_json: true
```

运行工作流时，`{text}` 被替换为实际值后，如果最终 prompt 与 `mock_mappings` 中某个 key 完全一致，就返回对应的 value。

## 配置说明

### 文件位置

Mock 模型配置在项目根目录的 `models.mock.yaml` 中，与正式模型配置 `models.yaml` 分开管理。程序启动时自动加载合并，文件不存在则静默跳过。

### 必填字段

| 字段 | 值 | 说明 |
|------|------|------|
| `provider` | `mock` | 可省略——模型名以 `mock` 开头会自动检测 |
| `api_url` | `""` | 不使用，填空字符串即可 |
| `api_key` | `"mock"` | 不使用，填任意非空值即可 |
| `model_name` | 任意 | 模型标识，建议与模型简称保持一致 |
| `mock_mappings` | 映射表 | prompt → response 的精确映射 |

### 自动检测规则

满足以下任一条件，`callModel` 自动走 mock 路径：

- 模型简称以 `mock` 开头（如 `mock-translate`、`mock_ocr`）
- `provider` 字段为 `"mock"`

### 匹配规则

- prompt（占位符替换后的最终文本）必须与 `mock_mappings` 的某个 key **完全一致**
- 匹配成功：返回对应 value
- 匹配失败：抛出错误，并列出所有可用的 key，方便排查

## 使用场景

### 不同场景用不同的 mock 模型

每个 mock 模型有自己独立的 `mock_mappings`，互不干扰：

```yaml
# 翻译场景
mock-translate:
  provider: mock
  api_url: ""
  api_key: "mock"
  model_name: mock-translate
  mock_mappings:
    "翻译：你好": '{"translation": "Hello"}'

# 摘要场景
mock-summary:
  provider: mock
  api_url: ""
  api_key: "mock"
  model_name: mock-summary
  mock_mappings:
    "总结这篇文章的要点": '{"summary": "要点一、要点二、要点三"}'
```

工作流中 `model: mock-translate` 只查 `mock-translate` 的映射表，`model: mock-summary` 只查 `mock-summary` 的映射表。

### 测试 JSON 验证

mock 响应可以是 JSON 字符串，配合工作流的 `validate_json: true` 测试验证逻辑：

```yaml
mock-structured:
  provider: mock
  api_url: ""
  api_key: "mock"
  model_name: mock-structured
  mock_mappings:
    "提取标题和内容": '{"title": "测试标题", "content": "测试内容", "page_num": 1}'
```

### 调试提示词模板

当 prompt 匹配失败时，错误消息会完整展示收到的 prompt 文本，可以用来确认占位符替换是否正确：

```
[Mock] 模型 'mock-translate' 找不到匹配的 prompt

【收到的 prompt】
  "请将以下文本翻译为英文：你好世界"

【mock_mappings 中可用的 key】
  1. "请将以下文本翻译为英文：你好"
  2. "请将以下文本翻译为英文：再见"

提示：mock 模式要求 prompt 与 key 完全一致（包括空格和换行）
```

## 注意事项

- `mock_mappings` 的 key 是占位符替换**后**的最终 prompt，不是模板本身
- key 匹配区分大小写，且包括空格、换行等空白字符
- mock 调用的 token 用量为估算值（每 2 字符约 1 token），成本为 0
- `models.mock.yaml` 建议加入 `.gitignore`（各开发者的测试数据可能不同），或提交到仓库（作为团队共享的测试用例）

## 相关文件

- `src/mock_llm.ts` — mock 引擎实现
- `src/model_caller.ts` — mock 拦截与自动检测逻辑
- `models.mock.yaml` — mock 模型配置
