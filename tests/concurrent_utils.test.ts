import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { concurrentProcess } from "../src/concurrent_utils";

describe("concurrentProcess", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not call queued handlers after the circuit breaker opens", async () => {
    let calls = 0;

    const stats = await concurrentProcess(
      [1, 2, 3],
      async (item): Promise<["fatal_error", string]> => {
        calls++;
        return ["fatal_error", `boom ${item}`];
      },
      1,
      0,
      "progress",
      1,
    );

    expect(calls).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.fatalFailed).toBe(1);
    expect(stats.retriableFailed).toBe(0);
    expect(stats.circuitBreakerTriggered).toBe(true);
    expect(stats.items).toHaveLength(1);
  });

  it("tracks retriable and fatal failure counts separately", async () => {
    const stats = await concurrentProcess(
      [1, 2, 3],
      async (item): Promise<["success" | "retriable_error" | "fatal_error", string]> => {
        if (item === 1) return ["retriable_error", "temporary"];
        if (item === 2) return ["fatal_error", "fatal"];
        return ["success", "ok"];
      },
      1,
      0,
      "progress",
      10,
    );

    expect(stats.success).toBe(1);
    expect(stats.failed).toBe(2);
    expect(stats.retriableFailed).toBe(1);
    expect(stats.fatalFailed).toBe(1);
  });
});
