# scripts/

调试脚本，手动运行用，不会被测试框架收集。

| 文件 | 用途 |
|------|------|
| `debug_llm.ts` | 调用 `callModel()` 测试普通 LLM，走框架封装层 |
| `debug_raw.ts` | 直接 `fetch()` 裸调 API，打印完整请求/响应体，支持附带图片 |

## 使用方式

修改文件顶部配置区，然后运行：

```bash
npx tsx scripts/debug_llm.ts
npx tsx scripts/debug_raw.ts
```

## debug_raw.ts 图片配置

```typescript
const IMAGE_PATH: string | string[] | null = null;                              // 不发图片（纯文本）
const IMAGE_PATH = "C:\\path\\to\\image.png";                                   // 单张图片
const IMAGE_PATH = ["C:\\path\\to\\img1.png", "C:\\path\\to\\img2.png"];        // 多张图片
```
