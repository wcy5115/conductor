import { describe, expect, it } from "vitest";

import { parsePageRange } from "../src/pdf_to_images";

describe("parsePageRange", () => {
  it("rejects a range that starts beyond the PDF page count", () => {
    expect(() => parsePageRange("11-20", 10)).toThrow(
      "Page range 11-20 starts beyond the PDF page count (1-10)"
    );
  });
});
