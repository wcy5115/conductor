/**
 * 通用并发处理工具模块
 * 支持渐进式任务派发、熔断器、进度跟踪
 */

export type ProcessStatus = "success" | "retriable_error" | "fatal_error" | "skipped";

export interface ItemResult {
  status: ProcessStatus;
  /** 原始任务的字符串表示（String(item)） */
  item: string;
  /** 成功时为实际结果；失败时为 `{ error: string }` */
  result: unknown;
}

export interface ProcessStats {
  total: number;
  success: number;
  failed: number;
  skipped: number;
  /** 熔断器是否触发过（true 表示有部分任务因连续失败未被执行） */
  circuitBreakerTriggered: boolean;
  /** 所有已处理任务的结果列表（含成功、失败、跳过） */
  items: ItemResult[];
}

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
  const delay = taskDispatchDelay ?? parseFloat(process.env["TASK_DISPATCH_DELAY"] ?? "0.5");
  const total = items.length;
  const stats: ProcessStats = {
    total,
    success: 0,
    failed: 0,
    skipped: 0,
    circuitBreakerTriggered: false,
    items: [],
  };

  // 信号量：控制最大并发数
  let permits = maxConcurrent;
  const semQueue: Array<() => void> = [];
  const acquire = (): Promise<void> => {
    if (permits > 0) { permits--; return Promise.resolve(); }
    return new Promise<void>((resolve) => semQueue.push(resolve));
  };
  const release = (): void => {
    if (semQueue.length > 0) { semQueue.shift()!(); }
    else { permits++; }
  };

  // 熔断器：连续失败达到阈值时停止派发
  let failureCount = 0;
  let circuitOpen = false;
  const recordSuccess = () => { failureCount = 0; };
  const recordFailure = (): boolean => {
    failureCount++;
    if (failureCount >= circuitBreakerThreshold && !circuitOpen) {
      circuitOpen = true;
      return true;
    }
    return false;
  };

  console.info(
    `并发处理器初始化 - 最大并发:${maxConcurrent}, 派发延迟:${delay}秒, 熔断阈值:${circuitBreakerThreshold}`,
  );

  const promises: Promise<void>[] = [];

  for (const [i, item] of items.entries()) {
    if (circuitOpen) break;

    // 初始渐进式派发：前 maxConcurrent 个任务之间加延迟，平滑负载
    if (i > 0 && i < maxConcurrent && delay > 0) {
      await sleep(delay);
    }

    const p = (async () => {
      if (circuitOpen) return;

      await acquire();
      try {
        let status: ProcessStatus;
        let result: unknown;
        try {
          [status, result] = await processFunc(item);
        } catch (e) {
          console.error(`处理项目时发生异常: ${e}`);
          const name = e instanceof Error ? e.constructor.name : "Error";
          status = "fatal_error";
          result = `异常: ${name}: ${e}`;
        }

        // 更新统计（JS 单线程，await 边界之间无并发修改）
        stats.items.push({
          status,
          item: String(item),
          result: status === "success" ? result : { error: String(result) },
        });

        if (status === "success") {
          stats.success++;
          recordSuccess();
        } else if (status === "skipped") {
          stats.skipped++;
        } else {
          stats.failed++;
          if (recordFailure()) {
            console.error(`熔断器触发！连续失败 ${circuitBreakerThreshold} 次`);
            stats.circuitBreakerTriggered = true;
          }
        }

        // 进度输出（覆写同行）
        const done = stats.success + stats.failed + stats.skipped;
        const pct = ((done / total) * 100).toFixed(1);
        process.stdout.write(`\r${progressDesc}: ${done}/${total} (${pct}%) [${status}]  `);
        if (done === total) process.stdout.write("\n");
      } finally {
        release();
      }
    })();

    promises.push(p);
  }

  await Promise.all(promises);

  console.info(
    `批量处理完成 - 总数:${stats.total}, 成功:${stats.success}, 失败:${stats.failed}, 跳过:${stats.skipped}`,
  );
  if (stats.circuitBreakerTriggered) {
    console.warn("熔断器已触发，部分任务未执行");
  }

  return stats;
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
