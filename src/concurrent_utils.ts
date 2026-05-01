/**
 * General-purpose concurrent processing utilities.
 *
 * Provides a ready-to-use concurrentProcess() function for running batches of
 * asynchronous tasks concurrently.
 * Built-in mechanisms:
 *   1. Semaphore - limits the number of simultaneously running tasks to avoid resource exhaustion.
 *   2. Circuit breaker - stops dispatching new tasks after consecutive failures reach the threshold.
 *   3. Gradual dispatch - adds a delay between the first few tasks to avoid sudden load spikes, such as API rate limits.
 *
 * Typical use cases:
 *   - Batch LLM API calls, where each call may take several seconds and concurrency improves throughput.
 *   - Batch file reads or writes that need controlled I/O concurrency.
 *   - Any batch operation that should stop automatically after repeated failures.
 */

// ============================================================
// Type definitions
// ============================================================

/**
 * Processing status for one task:
 *   "success"         - the task completed successfully.
 *   "retriable_error" - a retriable error, such as a network timeout or API rate limit.
 *                       This version does not retry automatically, but it still counts toward the circuit breaker.
 *   "fatal_error"     - a fatal error, such as invalid parameters or insufficient permissions.
 *                       It should not be retried and also counts toward the circuit breaker.
 *   "skipped"         - the task was skipped, such as when the output file already exists.
 *
 * Note: retriable_error and fatal_error behave the same in the current
 * implementation because both count as failures. They remain separate so
 * callers can distinguish error types in results and decide what to do next,
 * such as whether to retry manually.
 */
export type ProcessStatus = "success" | "retriable_error" | "fatal_error" | "skipped";

/**
 * Processing result record for one task.
 *
 * Success example: { status: "success", item: "page_1", result: { text: "..." } }
 * Failure example: { status: "fatal_error", item: "page_2", result: { error: "API returned 500" } }
 * Skipped example: { status: "skipped", item: "page_3", result: null }
 */
export interface ItemResult {
  /** Processing status for this task. See ProcessStatus. */
  status: ProcessStatus;
  /** String representation of the original item, generated with String(item), for identifying the task in results. */
  item: string;
  /**
   * Return value for the task:
   *   - On success or skip: the raw result value returned by processFunc, which may be any type.
   *   - On failure: a fixed { error: string } shape containing the error description.
   */
  result: unknown;
}

/**
 * Summary statistics for a batch run.
 *
 * concurrentProcess() returns this object after it finishes, so callers can
 * evaluate the overall result.
 *
 * Example return value:
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
  /** Total number of tasks, equal to items.length. */
  total: number;
  /** Number of successfully completed tasks. */
  success: number;
  /** Number of failed tasks, including retriable_error and fatal_error. */
  failed: number;
  /** Number of skipped tasks. */
  skipped: number;
  /** Whether the circuit breaker was triggered. True means some tasks were not executed after consecutive failures. */
  circuitBreakerTriggered: boolean;
  /** Results for all processed tasks, including success, failure, and skipped items, in completion order instead of input order. */
  items: ItemResult[];
}

// ============================================================
// Helper functions
// ============================================================

/**
 * Build a concise task label for log output.
 *
 * Extracts a readable label based on the item type:
 *   - Tuple [realItem, index]: unwraps the realItem part, which is the format passed by ConcurrentAction.
 *   - File path string: shows only the filename without the directory prefix.
 *   - Long string: truncates to 60 characters.
 *   - Dictionary object: shows the first three keys.
 *   - Other types: converts to string and truncates.
 *
 * @param item Original task item.
 * @returns Short label suitable for logs.
 *
 * Examples:
 *   formatItemLabel(["page_001.png", 0])  → "page_001.png"
 *   formatItemLabel("/data/output/page_001.json")  → "page_001.json"
 *   formatItemLabel({ text: "...", index: 1, lang: "zh" })  → "{text, index, lang}"
 */
export function formatItemLabel(item: unknown): string {
  // Step 1: unwrap [realItem, index] tuples passed by ConcurrentAction.
  // Array.isArray checks that the value is an array, and length === 2 confirms the tuple shape.
  let realItem = item;
  if (Array.isArray(item) && item.length === 2) {
    realItem = item[0];
  }

  // Step 2: build the label based on the value type.
  if (typeof realItem === "string") {
    // If the string contains a path separator, treat it as a file path and keep only the filename.
    // Supports both / and \ separators for Linux and Windows.
    if (realItem.includes("/") || realItem.includes("\\")) {
      // Take the portion after the last separator.
      const parts = realItem.replace(/\\/g, "/").split("/");
      return parts[parts.length - 1] || realItem.slice(0, 60);
    }
    // Regular string: truncate to 60 characters.
    return realItem.length > 60 ? realItem.slice(0, 60) + "..." : realItem;
  }

  if (realItem !== null && typeof realItem === "object" && !Array.isArray(realItem)) {
    // Dictionary object: show the first three keys and add a "+N" suffix when more keys exist.
    const keys = Object.keys(realItem as Record<string, unknown>).slice(0, 3);
    const extra = Object.keys(realItem as Record<string, unknown>).length - 3;
    const suffix = extra > 0 ? ` +${extra}` : "";
    return `{${keys.join(", ")}${suffix}}`;
  }

  // Other types: convert to string and truncate.
  const s = String(realItem);
  return s.length > 60 ? s.slice(0, 60) + "..." : s;
}

// ============================================================
// Core function: concurrentProcess
// ============================================================

/**
 * Process a batch of tasks concurrently with gradual dispatch.
 *
 * Resume support is built in: processFunc should decide whether to skip already processed items.
 *
 * @param items Items to process.
 * @param processFunc Processing function that returns `[status, result]`.
 *   - `"success"` / `"skipped"` - result is the actual result.
 *   - `"retriable_error"` / `"fatal_error"` - result is an error description stored as `{ error: string }`.
 *   - Throwing an exception is equivalent to returning `"fatal_error"`.
 * @param maxConcurrent Maximum number of concurrent tasks. Defaults to 5.
 * @param taskDispatchDelay Initial dispatch delay in seconds. When undefined, reads TASK_DISPATCH_DELAY and falls back to 0.5.
 * @param progressDesc Progress description text.
 * @param circuitBreakerThreshold Number of consecutive failures that triggers the circuit breaker. Defaults to 10.
 * @returns Summary statistics for all tasks, including success/failure/skipped counts and per-task details.
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
  progressDesc = "Processing progress",
  circuitBreakerThreshold = 10,
): Promise<ProcessStats> {
  // Determine the dispatch delay: prefer the explicit argument, then the environment variable, then 0.5 seconds.
  // TASK_DISPATCH_DELAY lets operators adjust the delay without changing code.
  // ?? is the nullish coalescing operator; it uses the right side only when the left side is null or undefined.
  const delay = taskDispatchDelay ?? parseFloat(process.env["TASK_DISPATCH_DELAY"] ?? "0.5");

  const total = items.length;

  // Initialize statistics; all counters start from 0.
  const stats: ProcessStats = {
    total,
    success: 0,
    failed: 0,
    skipped: 0,
    circuitBreakerTriggered: false,
    items: [],
  };

  // ──────────────────────────────────────────────
  // Semaphore: controls maximum concurrency.
  // ──────────────────────────────────────────────
  // How it works:
  //   permits is the number of currently available permits and starts at maxConcurrent.
  //   Each task must call acquire() before running to take one permit (permits--).
  //   After the task finishes, release() returns the permit (permits++).
  //   When permits reaches 0, later acquire() calls wait in semQueue until another task calls release().
  //
  // Why not use a third-party semaphore library:
  //   The implementation only needs a few lines, and an extra dependency would increase maintenance cost.
  //
  // Example with maxConcurrent=2:
  //   Task A acquire -> permits=1 -> starts running
  //   Task B acquire -> permits=0 -> starts running
  //   Task C acquire -> permits=0 -> enters the wait queue
  //   Task A release -> wakes Task C from the queue -> Task C starts running
  let permits = maxConcurrent;
  // semQueue is the wait queue. It stores resolve functions for blocked acquire() calls.
  // When a permit is returned, the first resolve is called to wake the corresponding task.
  const semQueue: Array<() => void> = [];

  /**
   * Acquire one permit. If permits remain, return immediately.
   * Otherwise, return a Promise that resolves when another task calls release().
   */
  const acquire = (): Promise<void> => {
    if (permits > 0) { permits--; return Promise.resolve(); }
    // No permits remain, so create a Promise and store its resolve function in the queue.
    // When another task calls release(), this resolve is removed from the queue and called.
    return new Promise<void>((resolve) => semQueue.push(resolve));
  };

  /**
   * Release one permit. If any task is waiting, wake the first queued task directly.
   * Otherwise, add the permit back.
   *
   * Note: when waking the first queued task, permits is not incremented because the
   * permit is transferred directly to that task. This is the standard semaphore
   * pattern and avoids a brief increment-then-decrement window.
   */
  const release = (): void => {
    if (semQueue.length > 0) { semQueue.shift()!(); }  // shift() removes the first queued resolver; !() calls it immediately.
    else { permits++; }
  };

  // ──────────────────────────────────────────────
  // Circuit breaker: stops automatically after consecutive failures.
  // ──────────────────────────────────────────────
  // How it works:
  //   failureCount records the number of consecutive failures.
  //   Each successful task resets it to 0 with recordSuccess(), indicating the system recovered.
  //   Each failed task increments it with recordFailure(); reaching the threshold sets circuitOpen to true.
  //   Once circuitOpen=true, the break in the for loop stops dispatching new tasks.
  //   Tasks that are already running return early before doing real work.
  //
  // Typical case: an invalid API key makes every request fail. The circuit breaker
  // stops quickly so the process does not keep sending requests that are doomed to fail.
  let failureCount = 0;
  let circuitOpen = false;

  /** Record one success and reset the consecutive failure counter. */
  const recordSuccess = () => { failureCount = 0; };

  /**
   * Record one failure and increment the consecutive failure counter.
   * If the threshold is reached and the circuit has not opened yet, open it and return true.
   * Otherwise, return false.
   */
  const recordFailure = (): boolean => {
    failureCount++;
    if (failureCount >= circuitBreakerThreshold && !circuitOpen) {
      circuitOpen = true;
      return true;  // true means the circuit breaker was just triggered.
    }
    return false;  // false means the failure threshold has not been reached yet.
  };

  console.info(
    `Concurrent processor initialized - max concurrency:${maxConcurrent}, dispatch delay:${delay}s, circuit breaker threshold:${circuitBreakerThreshold}`,
  );

  // ──────────────────────────────────────────────
  // Task dispatch and execution
  // ──────────────────────────────────────────────
  // The promises array collects all task Promises, then Promise.all waits for them to finish.
  const promises: Promise<void>[] = [];

  // items.entries() returns an [index, item] iterator, similar to Python's enumerate().
  for (const [i, item] of items.entries()) {
    // If the circuit breaker has opened, stop dispatching new tasks and exit the loop.
    // Already-dispatched tasks are unaffected; they check circuitOpen after acquire().
    if (circuitOpen) break;

    // Gradual dispatch (ramp-up): add a delay between the first maxConcurrent tasks.
    // Purpose: avoid an instant load spike against external services, such as LLM APIs with rate limits.
    // Conditions:
    //   i > 0             -> the first task does not need a delay
    //   i < maxConcurrent -> delay only while filling the concurrency pool; the semaphore controls later tasks
    //   delay > 0         -> no wait is needed when the delay is 0
    // Example with maxConcurrent=3 and delay=0.5s:
    //   t=0.0s: dispatch task 0
    //   t=0.5s: dispatch task 1
    //   t=1.0s: dispatch task 2; the concurrency pool is full
    //   Later tasks are controlled by the semaphore and start as soon as a task finishes.
    if (i > 0 && i < maxConcurrent && delay > 0) {
      await sleep(delay);
      if (circuitOpen) break;
    }

    // Create an async execution body for the current task with an immediately invoked async function.
    // The IIFE lets each task run independently without blocking the for loop.
    const p = (async () => {
      // Check the circuit state again before waiting for the semaphore.
      // Another task may have triggered the circuit breaker while this task was queued.
      if (circuitOpen) return;

      // Acquire a semaphore permit, or wait for another task to finish if concurrency is full.
      await acquire();
      try {
        if (circuitOpen) return;

        let status: ProcessStatus;
        let result: unknown;
        try {
          // Call the user-provided processing function and destructure [status, result].
          [status, result] = await processFunc(item);
        } catch (e) {
          // Treat exceptions from processFunc as fatal_error.
          // Catching them here keeps one task failure from interrupting the whole batch.
          console.error(`Exception while processing item: ${e}`);
          // Extract the exception class name, such as "TypeError" or "NetworkError", for debugging.
          const name = e instanceof Error ? e.constructor.name : "Error";
          status = "fatal_error";
          result = `Exception: ${name}: ${e}`;
        }

        // Update statistics.
        // No lock is needed here because JavaScript uses a single-threaded event loop.
        // Synchronous code between two await points cannot be interrupted by another task.
        // The push and ++ operations below are synchronous, so concurrent mutation is not an issue.
        stats.items.push({
          status,
          item: String(item),
          // Keep the raw result for success or skipped tasks; wrap failures as { error: string }.
          result: status === "success" || status === "skipped" ? result : { error: String(result) },
        });

        // ---- Per-task logs: record success, failure, and skipped tasks. ----
        // Build a concise task label, such as a filename, truncated string, or object key list.
        const itemLabel = formatItemLabel(item);
        const idx = stats.success + stats.failed + stats.skipped; // About to add 1.
        if (status === "success") {
          console.info(`✓ [${idx + 1}/${total}] ${itemLabel} succeeded`);
        } else if (status === "skipped") {
          // Try to extract the reason for skipped tasks. ConcurrentAction includes a reason field in result.
          let reason = "";
          if (result !== null && typeof result === "object" && !Array.isArray(result)) {
            reason = String((result as Record<string, unknown>)["reason"] ?? "");
          }
          console.info(`⏭ [${idx + 1}/${total}] ${itemLabel} skipped${reason ? ` (${reason})` : ""}`);
        } else {
          // retriable_error or fatal_error
          let errorBrief = "";
          if (result !== null && typeof result === "object" && !Array.isArray(result)) {
            errorBrief = String((result as Record<string, unknown>)["error"] ?? "");
          } else if (typeof result === "string") {
            errorBrief = result;
          }
          // Truncate overly long errors to avoid noisy logs.
          if (errorBrief.length > 150) errorBrief = errorBrief.slice(0, 150) + "...";
          console.error(`✗ [${idx + 1}/${total}] ${itemLabel} failed: ${errorBrief}`);
        }

        // Update the matching counter based on status and notify the circuit breaker.
        if (status === "success") {
          stats.success++;
          recordSuccess();  // Success resets the consecutive failure count.
        } else if (status === "skipped") {
          stats.skipped++;
          // Skipped tasks do not affect the circuit breaker because they are not failures.
        } else {
          // retriable_error or fatal_error
          stats.failed++;
          if (recordFailure()) {
            // recordFailure() returns true when it just triggered the circuit breaker.
            console.error(`Circuit breaker triggered after ${circuitBreakerThreshold} consecutive failures`);
            stats.circuitBreakerTriggered = true;
          }
        }

        // Progress output using single-line overwrite mode.
        // \r is carriage return: it moves the cursor back to the line start without adding a newline.
        // The next write overwrites the current line, producing an in-place progress display.
        // The two trailing spaces cover any leftover characters from a longer previous output.
        // Example output: \rProcessing progress: 42/100 (42.0%) [success]
        const done = stats.success + stats.failed + stats.skipped;
        const pct = ((done / total) * 100).toFixed(1);  // toFixed(1) keeps one decimal place.
        process.stdout.write(`\r${progressDesc}: ${done}/${total} (${pct}%) [${status}]  `);
        // Print a newline after all tasks finish so later console output does not stick to the progress line.
        if (done === total) process.stdout.write("\n");
      } finally {
        // finally ensures the semaphore permit is returned whether the task succeeds or throws.
        // Without release(), waiting tasks could never acquire a permit, causing a deadlock.
        release();
      }
    })();

    // Add this task Promise so Promise.all can wait for all dispatched tasks later.
    promises.push(p);
  }

  // Wait for all dispatched tasks, including tasks dispatched before the circuit breaker opened.
  await Promise.all(promises);

  // Output the final summary.
  console.info(
    `Batch processing complete - total:${stats.total}, succeeded:${stats.success}, failed:${stats.failed}, skipped:${stats.skipped}`,
  );
  if (stats.circuitBreakerTriggered) {
    console.warn("Circuit breaker was triggered; some tasks were not executed");
  }

  return stats;
}

// ============================================================
// Utility functions
// ============================================================

/**
 * Wait asynchronously for the specified number of seconds.
 *
 * setTimeout accepts milliseconds, so seconds must be converted with seconds * 1000.
 * Wrapping it in a Promise allows await sleep(0.5).
 *
 * @param seconds Number of seconds to wait. Decimals are supported, such as 0.5 for 500ms.
 */
function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
