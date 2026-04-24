import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as fs from "fs";
import * as path from "path";

import { MergeJsonFilesAction } from "../src/workflow_actions/io_actions";

const TEMP_DIR = path.join(process.cwd(), "tests", "_tmp_io_actions");

function cleanup(): void {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
}

describe("MergeJsonFilesAction", () => {
  beforeEach(() => {
    cleanup();
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("returns stable output keys and writes an empty file when the input directory is missing", async () => {
    const inputDir = path.join(TEMP_DIR, "missing");
    const outputFile = path.join(TEMP_DIR, "out", "merged.json");
    const action = new MergeJsonFilesAction(
      inputDir,
      outputFile,
      "*.json",
      "filename",
      "pages"
    );

    const result = await action.execute({
      data: {},
      history: [],
      metadata: {},
    } as any);

    expect(result.data).toEqual({
      pages: [],
      pages_count: 0,
      pages_file: outputFile,
    });
    expect(result.metadata["error"]).toBe(
      `Input directory does not exist: ${inputDir}`
    );
    expect(result.metadata["output_file"]).toBe(outputFile);
    expect(result.metadata["merged_count"]).toBe(0);
    expect(JSON.parse(fs.readFileSync(outputFile, "utf-8"))).toEqual([]);
  });

  it("returns stable output keys and writes an empty file when no files match", async () => {
    const inputDir = path.join(TEMP_DIR, "input");
    const outputFile = path.join(TEMP_DIR, "out", "merged.json");
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(path.join(inputDir, "note.txt"), "hello", "utf-8");

    const action = new MergeJsonFilesAction(
      inputDir,
      outputFile,
      "*.json",
      "filename",
      "pages"
    );

    const result = await action.execute({
      data: {},
      history: [],
      metadata: {},
    } as any);

    expect(result.data).toEqual({
      pages: [],
      pages_count: 0,
      pages_file: outputFile,
    });
    expect(result.metadata["warning"]).toBe("No matching JSON files found");
    expect(result.metadata["output_file"]).toBe(outputFile);
    expect(result.metadata["merged_count"]).toBe(0);
    expect(JSON.parse(fs.readFileSync(outputFile, "utf-8"))).toEqual([]);
  });
});
