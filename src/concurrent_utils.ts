/**
 * 通用并发处理工具模块
 *
 * 提供一个开箱即用的 concurrentProcess() 函数，用于批量并发执行异步任务。
 * 内置三大机制：
 *   1. 信号量（Semaphore）— 限制同时运行的任务数，防止资源耗尽
 *   2. 熔断器（Circuit Breaker）— 连续失败达到阈值时自动停止派发新任务
 *   3. 渐进式派发 — 前几个任务之间加延迟，避免瞬间并发冲击（如 API 限流）
 *
 * 典型使用场景：
 *   - 批量调用 LLM API（每次调用耗时数秒，需要并发加速）
 *   - 批量读写文件（需要控制 I/O 并发数）
 *   - 任何需要"失败自动停止"保护的批量操作
 */

// ============================================================
// 类型定义
// ============================================================

/**
 * 单个任务的处理状态，共四种取值：
 *   "success"         — 任务成功完成
 *   "retriable_error" — 可重试的错误（如网络超时、API 限流），当前版本不自动重试，但会计入熔断器
 *   "fatal_error"     — 致命错误（如参数错误、权限不足），不应重试，同样计入熔断器
 *   "skipped"         — 任务被跳过（如输出文件已存在，无需重复处理）
 *
 * 注意：retriable_error 和 fatal_error 在当前实现中行为相同（都算失败），
 * 区分它们是为了让调用方在结果中能区分错误类型，方便后续决策（如是否人工重试）。
 */
export type ProcessStatus = "success" | "retriable_error" | "fatal_error" | "skipped";

/**
 * 单个任务的处理结果记录
 *
 * 示例（成功）：{ status: "success", item: "page_1", result: { text: "..." } }
 * 示例（失败）：{ status: "fatal_error", item: "page_2", result: { error: "API 返回 500" } }
 * 示例（跳过）：{ status: "skipped", item: "page_3", result: null }
 */
export interface ItemResult {
  /** 任务的处理状态，取值见 ProcessStatus */
  status: ProcessStatus;
  /** 原始任务项的字符串表示，由 String(item) 生成，用于在结果中标识是哪个任务 */
  item: string;
  /**
   * 任务的返回值：
   *   - 成功/跳过时：processFunc 返回的原始 result 值（可以是任意类型）
   *   - 失败时：固定格式 { error: string }，包含错误描述信息
   */
  result: unknown;
}

/**
 * 批量处理的汇总统计
 *
 * concurrentProcess() 执行完毕后返回此对象，调用方可据此判断整体结果。
 *
 * 示例返回值：
 * {
 *   total: 100,
 *   success: 95,
 *   failed: 3,
 *   skipped: 2,
 *   circuitBreakerTriggered: false,
 *   items: [ { status: "success", item: "page_1", result: {...} }, ... ]
 * }
 */
export interface ProcessStats {
  /** 任务总数（等于传入的 items.length） */
  total: number;
  /** 成功完成的任务数 */
  success: number;
  /** 失败的任务数（含 retriable_error 和 fatal_error） */
  failed: number;
  /** 被跳过的任务数 */
  skipped: number;
  /** 熔断器是否触发过（true 表示有部分任务因连续失败未被执行） */
  circuitBreakerTriggered: boolean;
  /** 所有已处理任务的结果列表（含成功、失败、跳过），顺序为完成顺序而非输入顺序 */
  items: ItemResult[];
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 生成简洁的任务标签，用于日志输出
 *
 * 根据 item 的类型智能提取可读标签：
 *   - 元组 [index, realItem]：解包后取 realItem 部分（ConcurrentAction 传入的格式）
 *   - 文件路径字符串：只显示文件名（去掉目录前缀）
 *   - 长字符串：截断到 60 字符
 *   - 字典对象：显示前 3 个 key
 *   - 其他类型：转字符串后截断
 *
 * @param item 原始任务项
 * @returns 适合放在日志中的简短标签
 *
 * 使用示例：
 *   formatItemLabel(["page_001.png", 0])  → "page_001.png"
 *   formatItemLabel("/data/output/page_001.json")  → "page_001.json"
 *   formatItemLabel({ text: "...", index: 1, lang: "zh" })  → "{text, index, lang}"
 */
export function formatItemLabel(item: unknown): string {
  // 第一步：如果是 [realItem, index] 元组（ConcurrentAction 传入的格式），解包取 realItem
  // Array.isArray 检查是否是数组，length === 2 确认是二元组
  let realItem = item;
  if (Array.isArray(item) && item.length === 2) {
    realItem = item[0];
  }

  // 第二步：根据类型生成标签
  if (typeof realItem === "string") {
    // 如果字符串包含路径分隔符，说明是文件路径，只取文件名部分
    // 同时兼容 / 和 \ 两种分隔符（Linux / Windows）
    if (realItem.includes("/") || realItem.includes("\\")) {
      // 取最后一个分隔符之后的部分
      const parts = realItem.replace(/\\/g, "/").split("/");
      return parts[parts.length - 1] || realItem.slice(0, 60);
    }
    // 普通字符串：截断到 60 字符
    return realItem.length > 60 ? realItem.slice(0, 60) + "..." : realItem;
  }

  if (realItem !== null && typeof realItem === "object" && !Array.isArray(realItem)) {
    // 字典对象：显示前 3 个 key，超过 3 个时加 "+N" 后缀
    const keys = Object.keys(realItem as Record<string, unknown>).slice(0, 3);
    const extra = Object.keys(realItem as Record<string, unknown>).length - 3;
    const suffix = extra > 0 ? ` +${extra}` : "";
    return `{${keys.join(", ")}${suffix}}`;
  }

  // 其他类型：转字符串后截断
  const s = String(realItem);
  return s.length > 60 ? s.slice(0, 60) + "..." : s;
}

// ============================================================
// 核心函数：concurrentProcess
// ============================================================

/**
 * 并发处理批量任务（渐进式派发）
 *
 * ⭐ 断点续存已内置：processFunc 应自行判断是否跳过已处理项目
 *
 * @param items 待处理项目列表
 * @param processFunc 处理函数，返回 `[status, result]`。
 *   - `"success"` / `"skipped"` — result 为实际结果
 *   - `"retriable_error"` / `"fatal_error"` — result 为错误描述，存入 `{ error: string }`
 *   - 抛出异常等同于返回 `"fatal_error"`
 * @param maxConcurrent 最大并发任务数（默认 5）
 * @param taskDispatchDelay 初始派发延迟秒数，undefined 时读取环境变量 TASK_DISPATCH_DELAY（默认 0.5）
 * @param progressDesc 进度描述文字
 * @param circuitBreakerThreshold 连续失败多少次触发熔断（默认 10）
 * @returns 所有任务的汇总统计，含成功/失败/跳过数量及每个任务的详细结果
 *
 * @example
 * ```typescript
 * const stats = await concurrentProcess(items, async (item) => {
 *   if (fs.existsSync(outputPath)) return ["skipped", null];
 *   const result = await callLlmApi(item);
 *   return ["success", result];
 * });
 * ```
 */
export async function concurrentProcess<T>(
  items: T[],
  processFunc: (item: T) => Promise<[ProcessStatus, unknown]> | [ProcessStatus, unknown],
  maxConcurrent = 5,
  taskDispatchDelay?: number,
  progressDesc = "处理进度",
  circuitBreakerThreshold = 10,
): Promise<ProcessStats> {
  // 确定派发延迟：优先使用显式传入的值，否则读环境变量，最终兜底 0.5 秒
  // 环境变量 TASK_DISPATCH_DELAY 允许运维人员在不改代码的情况下调整延迟
  // ?? 是 nullish coalescing 运算符，仅在左侧为 null/undefined 时取右侧值
  const delay = taskDispatchDelay ?? parseFloat(process.env["TASK_DISPATCH_DELAY"] ?? "0.5");

  const total = items.length;

  // 初始化统计对象，所有计数器从 0 开始
  const stats: ProcessStats = {
    total,
    success: 0,
    failed: 0,
    skipped: 0,
    circuitBreakerTriggered: false,
    items: [],
  };

  // ──────────────────────────────────────────────
  // 信号量（Semaphore）：控制最大并发数
  // ──────────────────────────────────────────────
  // 工作原理：
  //   permits 表示当前可用的"许可证"数量，初始值等于 maxConcurrent。
  //   每个任务执行前必须 acquire() 获取一个许可证（permits--），
  //   执行完毕后 release() 归还许可证（permits++）。
  //   当 permits 降为 0 时，后续任务的 acquire() 会排队等待（进入 semQueue），
  //   直到有其他任务 release() 归还许可证后才被唤醒。
  //
  // 为什么不用第三方信号量库：
  //   实现只需十行代码，引入额外依赖反而增加维护成本。
  //
  // 示例（maxConcurrent=2）：
  //   任务A acquire → permits=1 → 开始执行
  //   任务B acquire → permits=0 → 开始执行
  //   任务C acquire → permits=0 → 进入等待队列
  //   任务A release → 从队列唤醒任务C → 任务C开始执行
  let permits = maxConcurrent;
  // semQueue 是等待队列，存放被阻塞的 acquire() 调用的 resolve 函数
  // 当有许可证归还时，从队首取出一个 resolve 调用，唤醒对应的任务
  const semQueue: Array<() => void> = [];

  /**
   * 获取一个许可证。如果有剩余许可（permits > 0），立即返回；
   * 否则返回一个 Promise，该 Promise 会在其他任务 release() 时被 resolve。
   */
  const acquire = (): Promise<void> => {
    if (permits > 0) { permits--; return Promise.resolve(); }
    // 没有剩余许可，创建一个 Promise 并把它的 resolve 函数存入队列
    // 当其他任务调用 release() 时，会从队列中取出这个 resolve 并调用，Promise 就被解决了
    return new Promise<void>((resolve) => semQueue.push(resolve));
  };

  /**
   * 归还一个许可证。如果有任务在等待（semQueue 非空），直接唤醒队首任务；
   * 否则将 permits 加回。
   *
   * 注意：唤醒队首任务时不增加 permits，因为许可证直接"转让"给了被唤醒的任务。
   * 这是信号量的标准实现模式，避免了 permits 短暂增加后又被减少的竞态问题。
   * （虽然 JS 是单线程的不存在真正的竞态，但这种写法更规范且高效。）
   */
  const release = (): void => {
    if (semQueue.length > 0) { semQueue.shift()!(); }  // shift() 取出队首，!() 立即调用
    else { permits++; }
  };

  // ──────────────────────────────────────────────
  // 熔断器（Circuit Breaker）：连续失败时自动停止
  // ──────────────────────────────────────────────
  // 工作原理：
  //   failureCount 记录连续失败的次数。
  //   每次任务成功时重置为 0（recordSuccess），说明系统恢复正常。
  //   每次任务失败时加 1（recordFailure），达到阈值时将 circuitOpen 设为 true。
  //   circuitOpen=true 后，for 循环中的 break 会停止派发新任务，
  //   已经在执行的任务会提前 return（不做实际处理）。
  //
  // 典型场景：API 密钥失效导致所有请求都会失败，
  //   此时熔断器能快速停止，避免浪费时间和金钱继续发送注定失败的请求。
  let failureCount = 0;
  let circuitOpen = false;

  /** 记录一次成功，将连续失败计数器归零 */
  const recordSuccess = () => { failureCount = 0; };

  /**
   * 记录一次失败，连续失败计数器加 1。
   * 如果达到阈值且熔断器尚未触发，则触发熔断，返回 true；否则返回 false。
   */
  const recordFailure = (): boolean => {
    failureCount++;
    if (failureCount >= circuitBreakerThreshold && !circuitOpen) {
      circuitOpen = true;
      return true;  // 返回 true 表示"刚刚触发了熔断"
    }
    return false;  // 返回 false 表示"还没达到熔断阈值"
  };

  console.info(
    `并发处理器初始化 - 最大并发:${maxConcurrent}, 派发延迟:${delay}秒, 熔断阈值:${circuitBreakerThreshold}`,
  );

  // ──────────────────────────────────────────────
  // 任务派发与执行
  // ──────────────────────────────────────────────
  // promises 数组收集所有任务的 Promise，最后用 Promise.all 等待全部完成
  const promises: Promise<void>[] = [];

  // items.entries() 返回 [index, item] 的迭代器，类似 Python 的 enumerate()
  for (const [i, item] of items.entries()) {
    // 熔断器已触发 → 停止派发新任务，跳出循环
    // 注意：已经派发但尚未完成的任务不受影响，它们会在 acquire() 后检查 circuitOpen
    if (circuitOpen) break;

    // 渐进式派发（Ramp-up）：前 maxConcurrent 个任务之间加延迟
    // 目的：避免瞬间并发冲击外部服务（如 LLM API 可能有限流策略）
    // 条件解释：
    //   i > 0        → 第一个任务不需要延迟
    //   i < maxConcurrent → 只在填满并发池的过程中加延迟，之后由信号量自然调控
    //   delay > 0    → 延迟为 0 时无需等待
    // 示例（maxConcurrent=3, delay=0.5s）：
    //   t=0.0s: 派发任务0
    //   t=0.5s: 派发任务1
    //   t=1.0s: 派发任务2（并发池已满）
    //   之后的任务由信号量控制，某个任务完成后立即派发下一个
    if (i > 0 && i < maxConcurrent && delay > 0) {
      await sleep(delay);
    }

    // 为当前任务创建一个异步执行体（立即执行的 async IIFE）
    // 使用 IIFE（立即调用函数表达式）是为了让每个任务独立运行而不阻塞 for 循环
    const p = (async () => {
      // 在等待信号量之前再次检查熔断状态
      // 可能在排队等待信号量的过程中，其他任务触发了熔断器
      if (circuitOpen) return;

      // 获取信号量许可，如果并发数已满则等待其他任务完成
      await acquire();
      try {
        let status: ProcessStatus;
        let result: unknown;
        try {
          // 调用用户提供的处理函数，解构返回值为 [状态, 结果]
          [status, result] = await processFunc(item);
        } catch (e) {
          // processFunc 抛出异常时，视为 fatal_error
          // 捕获异常而不是让它传播，这样一个任务的失败不会中断整个批处理
          console.error(`处理项目时发生异常: ${e}`);
          // 提取异常类名（如 "TypeError"、"NetworkError"），便于调试
          const name = e instanceof Error ? e.constructor.name : "Error";
          status = "fatal_error";
          result = `异常: ${name}: ${e}`;
        }

        // 更新统计数据
        // 为什么这里不需要锁？因为 JS 是单线程事件循环模型，
        // 在两个 await 之间的同步代码不会被其他任务打断。
        // 下面的 push 和 ++ 操作都是同步的，所以不存在并发修改问题。
        stats.items.push({
          status,
          item: String(item),
          // 成功/跳过时保留原始结果；失败时统一包装为 { error: string } 格式
          result: status === "success" || status === "skipped" ? result : { error: String(result) },
        });

        // ---- 逐任务日志：成功/失败/跳过都记录 ----
        // 生成简洁的任务标签（文件名、截断字符串、字典 key 列表等）
        const itemLabel = formatItemLabel(item);
        const idx = stats.success + stats.failed + stats.skipped; // 即将 +1
        if (status === "success") {
          console.info(`✓ [${idx + 1}/${total}] ${itemLabel} 成功`);
        } else if (status === "skipped") {
          // 跳过时尝试提取原因（ConcurrentAction 会在 result 中附带 reason 字段）
          let reason = "";
          if (result !== null && typeof result === "object" && !Array.isArray(result)) {
            reason = String((result as Record<string, unknown>)["reason"] ?? "");
          }
          console.info(`⏭ [${idx + 1}/${total}] ${itemLabel} 跳过${reason ? ` (${reason})` : ""}`);
        } else {
          // retriable_error 或 fatal_error
          let errorBrief = "";
          if (result !== null && typeof result === "object" && !Array.isArray(result)) {
            errorBrief = String((result as Record<string, unknown>)["error"] ?? "");
          } else if (typeof result === "string") {
            errorBrief = result;
          }
          // 截断过长的错误信息，避免日志刷屏
          if (errorBrief.length > 150) errorBrief = errorBrief.slice(0, 150) + "...";
          console.error(`✗ [${idx + 1}/${total}] ${itemLabel} 失败: ${errorBrief}`);
        }

        // 根据状态更新对应的计数器，并通知熔断器
        if (status === "success") {
          stats.success++;
          recordSuccess();  // 成功 → 重置连续失败计数
        } else if (status === "skipped") {
          stats.skipped++;
          // 跳过的任务不影响熔断器计数（跳过不算失败）
        } else {
          // retriable_error 或 fatal_error
          stats.failed++;
          if (recordFailure()) {
            // recordFailure() 返回 true 表示刚触发熔断
            console.error(`熔断器触发！连续失败 ${circuitBreakerThreshold} 次`);
            stats.circuitBreakerTriggered = true;
          }
        }

        // 进度输出（单行覆写模式）
        // \r 是回车符（carriage return），将光标移回行首但不换行，
        // 下次 write 会覆盖当前行的内容，从而实现"原地更新"的进度显示效果。
        // 末尾的两个空格用于覆盖上一次输出可能更长的残留字符。
        // 示例输出：\r处理进度: 42/100 (42.0%) [success]
        const done = stats.success + stats.failed + stats.skipped;
        const pct = ((done / total) * 100).toFixed(1);  // toFixed(1) 保留一位小数
        process.stdout.write(`\r${progressDesc}: ${done}/${total} (${pct}%) [${status}]  `);
        // 所有任务完成后输出换行符，防止后续 console 输出粘在进度行后面
        if (done === total) process.stdout.write("\n");
      } finally {
        // finally 确保无论成功还是异常都会归还信号量许可
        // 如果不归还，其他等待中的任务将永远无法获得许可，导致死锁
        release();
      }
    })();

    // 将任务的 Promise 加入数组，后续用 Promise.all 等待全部完成
    promises.push(p);
  }

  // 等待所有已派发的任务完成（包括熔断前已派发但尚未完成的任务）
  await Promise.all(promises);

  // 输出最终统计摘要
  console.info(
    `批量处理完成 - 总数:${stats.total}, 成功:${stats.success}, 失败:${stats.failed}, 跳过:${stats.skipped}`,
  );
  if (stats.circuitBreakerTriggered) {
    console.warn("熔断器已触发，部分任务未执行");
  }

  return stats;
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 异步等待指定秒数
 *
 * setTimeout 接受毫秒数，所以需要 seconds * 1000 转换。
 * 包装成 Promise 是为了支持 await sleep(0.5) 的写法。
 *
 * @param seconds 等待的秒数（支持小数，如 0.5 表示 500ms）
 */
function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
