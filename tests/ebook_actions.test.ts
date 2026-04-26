import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as fs from "fs";
import * as path from "path";

import {
  EpubExtractAction,
  MergeToEpubAction,
} from "../src/workflow_actions/ebook_actions";

const TEMP_DIR = path.join(process.cwd(), "tests", "_tmp_ebook_actions");

function cleanup(): void {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
}

describe("EpubExtractAction", () => {
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

  it("restores cached chunks that use a custom filename template", async () => {
    const outputDir = path.join(TEMP_DIR, "chunks");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, "part_001.txt"), "First chunk", "utf-8");
    fs.writeFileSync(path.join(outputDir, "part_002.txt"), "Second chunk", "utf-8");

    const action = new EpubExtractAction(
      "input",
      "chunks",
      1000,
      1500,
      "NEXT",
      "Extract",
      {
        output_dir: outputDir,
        filename_template: "part_{index:03d}.txt",
      }
    );

    const result = await action.execute({
      data: { input: path.join(TEMP_DIR, "missing.txt") },
      history: [],
      metadata: {},
    } as any);

    expect(result.nextStep).toBe("NEXT");
    expect(result.data["chunks"]).toEqual([
      { index: 1, text: "First chunk" },
      { index: 2, text: "Second chunk" },
    ]);
    expect(result.metadata["source"]).toBe("cache");
    expect(result.metadata["chunk_count"]).toBe(2);
  });

  it("splits text on Arabic and Devanagari sentence-ending punctuation", async () => {
    const inputFile = path.join(TEMP_DIR, "global-punctuation.txt");
    fs.writeFileSync(inputFile, "Alpha؟Beta।Gamma॥Delta.", "utf-8");

    const action = new EpubExtractAction(
      "input",
      "chunks",
      4,
      100,
      "NEXT",
      "Extract"
    );

    const result = await action.execute({
      data: { input: inputFile },
      history: [],
      metadata: {},
    } as any);

    expect(result.data["chunks"]).toEqual([
      { index: 1, text: "Alpha؟" },
      { index: 2, text: "Beta।" },
      { index: 3, text: "Gamma॥" },
      { index: 4, text: "Delta." },
    ]);
  });
});

describe("MergeToEpubAction", () => {
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

  it("uses concurrent stats for resumed results and returns an existing ePub path", async () => {
    const alignedDir = path.join(TEMP_DIR, "polished");
    const outputDir = path.join(TEMP_DIR, "results");
    fs.mkdirSync(alignedDir, { recursive: true });
    fs.writeFileSync(
      path.join(alignedDir, "polished_0001.txt"),
      "Chinese sentence. English sentence.",
      "utf-8"
    );

    const action = new MergeToEpubAction(
      "4_response",
      alignedDir,
      outputDir,
      "book.epub",
      "Book",
      "output"
    );

    const result = await action.execute({
      data: {
        "4_response": [],
        "4_response_stats": {
          success: 0,
          skipped: 1,
        },
      },
      history: [],
      metadata: {},
    } as any);

    const output = result.data["output"] as Record<string, unknown>;
    const epubPath = output["output_epub"];
    const txtPath = output["output_txt"];

    expect(epubPath).toBe(path.join(outputDir, "book.epub"));
    expect(txtPath).toBe(path.join(outputDir, "book.txt"));
    expect(fs.existsSync(String(epubPath))).toBe(true);
    expect(fs.existsSync(String(txtPath))).toBe(true);
    expect(result.metadata["epub_created"]).toBe(true);
    expect(result.metadata["epub_error"]).toBeUndefined();
  });
});
