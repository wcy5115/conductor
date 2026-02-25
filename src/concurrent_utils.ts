/**
 * 通用并发处理工具模块
 * 提供可复用的并发处理能力，支持进度跟踪、错误处理、熔断器等特性
 * 可被多个模块复用：OCR、文本翻译、批量API调用等
 */

const logger = {
  info: (msg: string) => console.info(msg),
  warning: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
  debug: (msg: string) => console.debug(msg),
};

// ============================================================
// 类型定义
// ============================================================

export type ProcessStatus = "success" | "retriable_error" | "fatal_error" | "skipped";

export interface ItemResult {
  status: ProcessStatus;
  item: string;
  result: unknown;
}

export interface ProcessStats {
  total: number;
  success: number;
  failed: number;
  skipped: number;
  circuitBreakerTriggered: boolean;
  items: ItemResult[];
}

// ============================================================
// AsyncSemaphore（模块内部工具）
// ============================================================

class AsyncSemaphore {
  private permits: number;
  private readonly queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    if (this.queue.length > 0) {
      this.queue.shift()!();
    } else {
      this.permits++;
    }
  }
}

// ============================================================
// CircuitBreaker
// ============================================================

/**
 * 熔断器 - 防止连续失败导致的资源浪费
 *
 * 当连续失败次数达到阈值时，自动触发熔断，停止后续处理
 */
export class CircuitBreaker {
  private failureCount = 0;
  private _isOpen = false;

  constructor(readonly threshold: number = 10) {}

  /** 记录成功，重置失败计数 */
  recordSuccess(): void {
    this.failureCount = 0;
  }

  /**
   * 记录失败，返回是否触发熔断
   * @returns true 表示触发了熔断，false 表示未触发
   */
  recordFailure(): boolean {
    this.failureCount++;
    if (this.failureCount >= this.threshold && !this._isOpen) {
      this._isOpen = true;
      return true;
    }
    return false;
  }

  /** 检查熔断器是否已触发 */
  isCircuitOpen(): boolean {
    return this._isOpen;
  }

  /** 重置熔断器 */
  reset(): void {
    this.failureCount = 0;
    this._isOpen = false;
  }
}

// ============================================================
// RateLimiter
// ============================================================

/**
 * 速率限制器 - 控制 API 并发数，避免触发速率限制
 *
 * 使用 Promise 信号量机制，确保同时进行的 API 请求不超过限制
 */
export class RateLimiter {
  private readonly semaphore: AsyncSemaphore;

  constructor(readonly maxConcurrent: number = 3) {
    this.semaphore = new AsyncSemaphore(maxConcurrent);
  }

  /** 获取许可 */
  acquire(): Promise<void> {
    return this.semaphore.acquire();
  }

  /** 释放许可 */
  release(): void {
    this.semaphore.release();
  }

  /**
   * 在速率限制下执行函数（自动获取和释放许可）
   * 等价于 Python 的 `with rate_limiter:` 上下文管理器
   */
  async withLimit<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// ============================================================
// ConcurrentProcessor
// ============================================================

/**
 * 通用并发处理器（渐进式并发控制）
 *
 * 提供统一的并发处理能力，包括：
 * - 渐进式任务派发（避免瞬间大量请求）
 * - 进度跟踪
 * - 错误处理
 * - 熔断器机制
 * - 断点续传支持（由 processFunc 自行实现）
 *
 * 工作机制：
 * 1. 第 1 个任务立即派出
 * 2. 延迟 taskDispatchDelay 秒
 * 3. 第 2 个任务派出
 * 4. ...直到达到 maxConcurrent
 * 5. 之后，每完成 1 个任务，立即派出下一个任务（信号量控制）
 */
export class ConcurrentProcessor {
  private readonly circuitBreaker: CircuitBreaker;
  private readonly taskDispatchDelay: number;

  /**
   * @param maxConcurrent 最大并发任务数
   * @param taskDispatchDelay 初始派发延迟（秒），undefined 时读取环境变量 TASK_DISPATCH_DELAY（默认 0.5）
   * @param circuitBreakerThreshold 熔断器阈值
   * @param enableProgressBar 是否显示进度
   */
  constructor(
    private readonly maxConcurrent: number = 5,
    taskDispatchDelay: number | undefined = undefined,
    circuitBreakerThreshold: number = 10,
    private readonly enableProgressBar: boolean = true,
  ) {
    this.taskDispatchDelay =
      taskDispatchDelay ?? parseFloat(process.env["TASK_DISPATCH_DELAY"] ?? "0.5");
    this.circuitBreaker = new CircuitBreaker(circuitBreakerThreshold);

    logger.info(
      `并发处理器初始化 - 最大并发:${maxConcurrent}, ` +
        `派发延迟:${this.taskDispatchDelay}秒, 熔断阈值:${circuitBreakerThreshold}`,
    );
  }

  /**
   * 批量并发处理（渐进式派发）
   *
   * ⭐ 断点续存已内置：processFunc 应自行判断是否跳过已处理项目
   *
   * @param items 待处理项目列表
   * @param processFunc 处理函数，返回 [status, result]
   *   - status: "success" | "retriable_error" | "fatal_error" | "skipped"
   *   - 应自行实现断点续存逻辑（例如检查输出文件是否已存在）
   * @param progressDesc 进度描述文字
   *
   * @example
   * ```typescript
   * async function processItem(item: string): Promise<[ProcessStatus, unknown]> {
   *   if (fs.existsSync(outputFile)) return ["skipped", { reason: "file_exists" }];
   *   const result = await doWork(item);
   *   return ["success", result];
   * }
   * const stats = await processor.processBatch(items, processItem);
   * ```
   */
  async processBatch<T>(
    items: T[],
    processFunc: (item: T) => Promise<[ProcessStatus, unknown]> | [ProcessStatus, unknown],
    progressDesc = "处理进度",
  ): Promise<ProcessStats> {
    const total = items.length;
    const stats: ProcessStats = {
      total,
      success: 0,
      failed: 0,
      skipped: 0,
      circuitBreakerTriggered: false,
      items: [],
    };

    const sem = new AsyncSemaphore(this.maxConcurrent);
    const promises: Promise<void>[] = [];

    for (let i = 0; i < items.length; i++) {
      // 熔断器触发后停止派发新任务
      if (this.circuitBreaker.isCircuitOpen()) break;

      // 初始渐进式派发：前 maxConcurrent 个任务之间加延迟，平滑负载
      if (i > 0 && i < this.maxConcurrent && this.taskDispatchDelay > 0) {
        await sleep(this.taskDispatchDelay);
      }

      const item = items[i];
      const p = (async () => {
        if (this.circuitBreaker.isCircuitOpen()) return;

        await sem.acquire();
        try {
          const [status, result] = await this._safeProcessItem(item, processFunc);

          // 更新统计（JS 单线程，await 边界之间无并发修改）
          stats.items.push({
            status,
            item: String(item),
            result: status === "success" ? result : { error: String(result) },
          });

          if (status === "success") {
            stats.success++;
            this.circuitBreaker.recordSuccess();
          } else if (status === "skipped") {
            stats.skipped++;
          } else {
            stats.failed++;
            if (this.circuitBreaker.recordFailure()) {
              logger.error(`熔断器触发！连续失败 ${this.circuitBreaker.threshold} 次`);
              stats.circuitBreakerTriggered = true;
            }
          }

          // 进度输出（覆写同行）
          if (this.enableProgressBar) {
            const done = stats.success + stats.failed + stats.skipped;
            const pct = ((done / total) * 100).toFixed(1);
            process.stdout.write(`\r${progressDesc}: ${done}/${total} (${pct}%) [${status}]  `);
            if (done === total) process.stdout.write("\n");
          }
        } finally {
          sem.release();
        }
      })();

      promises.push(p);
    }

    await Promise.all(promises);

    logger.info(
      `批量处理完成 - 总数:${stats.total}, ` +
        `成功:${stats.success}, 失败:${stats.failed}, 跳过:${stats.skipped}`,
    );

    if (stats.circuitBreakerTriggered) {
      logger.warning("熔断器已触发，部分任务未执行");
    }

    return stats;
  }

  private async _safeProcessItem<T>(
    item: T,
    processFunc: (item: T) => Promise<[ProcessStatus, unknown]> | [ProcessStatus, unknown],
  ): Promise<[ProcessStatus, unknown]> {
    try {
      return await processFunc(item);
    } catch (e) {
      logger.error(`处理项目时发生异常: ${e}`);
      const name = e instanceof Error ? e.constructor.name : "Error";
      return ["fatal_error", `异常: ${name}: ${e}`];
    }
  }
}

// ============================================================
// 便捷函数
// ============================================================

/**
 * 便捷函数：并发处理（渐进式派发）
 *
 * ⭐ 断点续存已内置：processFunc 应自行判断是否跳过已处理项目
 *
 * @param items 待处理项目列表
 * @param processFunc 处理函数，应自行实现断点续存逻辑
 * @param maxConcurrent 最大并发任务数
 * @param taskDispatchDelay 任务派发延迟（秒），undefined 时读取环境变量
 * @param progressDesc 进度描述文字
 */
export async function concurrentProcess<T>(
  items: T[],
  processFunc: (item: T) => Promise<[ProcessStatus, unknown]> | [ProcessStatus, unknown],
  maxConcurrent = 5,
  taskDispatchDelay?: number,
  progressDesc = "处理进度",
): Promise<ProcessStats> {
  const processor = new ConcurrentProcessor(maxConcurrent, taskDispatchDelay);
  return processor.processBatch(items, processFunc, progressDesc);
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
