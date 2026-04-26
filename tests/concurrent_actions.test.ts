import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as fs from "fs";
import * as path from "path";

import { ConcurrentAction } from "../src/workflow_actions/concurrent_actions";

const TEMP_DIR = path.join(process.cwd(), "tests", "_tmp_concurrent_actions");

function cleanup(): void {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
}

describe("ConcurrentAction", () => {
  beforeEach(() => {
    cleanup();
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("keeps cached save-to-file outputs in the resumed result list", async () => {
    const inputDir = path.join(TEMP_DIR, "input");
    const outputDir = path.join(TEMP_DIR, "output");
    fs.mkdirSync(inputDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });

    const cachedInput = path.join(inputDir, "cached.txt");
    const newInput = path.join(inputDir, "new.txt");
    const cachedOutput = path.join(outputDir, "result_01.txt");
    const newOutput = path.join(outputDir, "result_02.txt");

    fs.writeFileSync(cachedOutput, "already done", "utf-8");
    fs.writeFileSync(newInput, "new content", "utf-8");

    const action = new ConcurrentAction(
      "items",
      [
        {
          type: "read_file",
          path_template: "{item}",
          output_key: "file_content",
        },
      ],
      1,
      0,
      10,
      "outputs",
      {
        output_dir: outputDir,
        filename_template: "result_{index:02d}.txt",
        data_key: "file_content",
      },
      true,
      "NEXT",
      "Concurrent",
      "parallel"
    );

    const result = await action.execute({
      data: { items: [cachedInput, newInput] },
      history: [],
      metadata: {},
    } as any);

    expect(result.nextStep).toBe("NEXT");
    expect(result.data["outputs"]).toEqual([
      { saved_file: cachedOutput, item: cachedInput },
      { saved_file: newOutput, item: newInput },
    ]);
    expect(result.data["outputs_stats"]).toMatchObject({
      total: 2,
      success: 1,
      skipped: 1,
      failed: 0,
    });
    expect(fs.readFileSync(newOutput, "utf-8")).toBe("new content");
  });
});
