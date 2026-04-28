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
    expect(stats.circuitBreakerTriggered).toBe(true);
    expect(stats.items).toHaveLength(1);
  });
});
