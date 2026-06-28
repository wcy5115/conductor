# TODO: Prevent Windows Alternate Data Stream Output Bugs

## Background

The English-to-Chinese ebook workflow recently produced a result that looked corrupted on Windows. Explorer showed a visible file named `The WoW Diary` with a size of `0` bytes, even though the workflow log said that an EPUB and TXT file had been generated successfully.

The real cause was not that the EPUB generator destroyed the output. The workflow passed a book title directly into the output filename, and the title contained a colon:

```text
The WoW Diary: A Journal of Computer Game Development (John Staats)
```

The workflow output template expanded this into a filename like:

```text
The WoW Diary: A Journal of Computer Game Development (John Staats)_en_to_zh.epub
```

On NTFS, Windows treats a colon inside a path as alternate data stream syntax:

```text
host-file:stream-name
```

So Windows interpreted the intended output path as:

```text
Visible host file:
The WoW Diary

Hidden stream attached to that file:
A Journal of Computer Game Development (John Staats)_en_to_zh.epub
```

That is why the visible file appeared empty. The EPUB bytes were written into a hidden NTFS alternate data stream instead of a normal visible `.epub` file.

## Root Cause

`MergeToEpubAction` builds output paths from the configured `output_filename` after context placeholder replacement. It does not sanitize the filename before passing it to `path.join`, `nodepub.writeEPUB`, or `fs.writeFileSync`.

Current vulnerable path flow:

```text
book_name contains ":"
        |
        v
output_filename: "{book_name}_en_to_zh.epub"
        |
        v
outputPath = path.join(outputDir, outputFilename)
        |
        v
Windows interprets colon as alternate data stream syntax
```

This is especially risky because book titles, article titles, web page titles, and user-provided names commonly contain punctuation that is unsafe for filenames.

## Goals

- Never write workflow output files using raw user-facing titles as filenames.
- Preserve readable output filenames where possible.
- Avoid Windows alternate data stream creation through `:` in filenames.
- Keep behavior cross-platform and predictable.
- Add tests so this bug cannot return quietly.

## Proposed Fix

Add a filename sanitization helper and apply it inside `MergeToEpubAction` before writing EPUB and TXT outputs.

The helper should handle at least these Windows-invalid filename characters:

```text
< > : " / \ | ? *
```

Recommended replacements:

- Replace `:` with ` - ` because it reads naturally in titles.
- Replace `/` and `\` with ` - ` or `_` because they are path separators.
- Replace `<`, `>`, `"`, `|`, `?`, `*` with `_`.
- Collapse repeated spaces.
- Trim leading/trailing whitespace.
- Remove or replace trailing dots and trailing spaces.
- Protect Windows reserved device names such as `CON`, `PRN`, `AUX`, `NUL`, `COM1`, and `LPT1`.

Example:

```text
Input:
The WoW Diary: A Journal of Computer Game Development (John Staats)_en_to_zh.epub

Output:
The WoW Diary - A Journal of Computer Game Development (John Staats)_en_to_zh.epub
```

## Implementation Tasks

1. Add a small filename sanitizer.

   Suggested location:

   ```text
   src/workflow_actions/ebook_actions.ts
   ```

   A local helper is acceptable for the first fix because the bug currently happens inside ebook merging. If other actions later need safe filenames too, move the helper into a shared utility module.

2. Apply the sanitizer only to the filename portion, not the whole path.

   Important distinction:

   ```text
   Safe:
   outputDir + sanitizeFilename(outputFilename)

   Unsafe:
   sanitize the entire output path
   ```

   Sanitizing the entire path could accidentally modify drive letters such as `D:` or path separators.

3. Keep the configured output directory unchanged.

   `output_dir` should still support valid workflow paths such as:

   ```text
   data/english_to_chinese_translation/results
   ```

4. Use the sanitized filename consistently for both EPUB and TXT.

   The EPUB path and TXT path should share the same sanitized basename:

   ```text
   Book - Subtitle_en_to_zh.epub
   Book - Subtitle_en_to_zh.txt
   ```

5. Log when a filename is changed.

   Example log message:

   ```text
   Sanitized output filename: "The WoW Diary: A Journal..._en_to_zh.epub" -> "The WoW Diary - A Journal..._en_to_zh.epub"
   ```

   This helps users understand why the final filename differs from the book title.

6. Add tests for Windows-unsafe output filenames.

   Suggested test cases:

   - `Book: Subtitle.epub` becomes `Book - Subtitle.epub`.
   - `Book / Subtitle.epub` does not create nested directories.
   - `Book?Name*.epub` becomes a normal visible file.
   - `CON.epub` does not produce a reserved device-name path.
   - EPUB and TXT outputs use matching sanitized basenames.

7. Add a regression test for the exact bug.

   Test input:

   ```text
   book_name = "The WoW Diary: A Journal of Computer Game Development (John Staats)"
   output_filename = "{book_name}_en_to_zh.epub"
   ```

   Expected visible output:

   ```text
   The WoW Diary - A Journal of Computer Game Development (John Staats)_en_to_zh.epub
   The WoW Diary - A Journal of Computer Game Development (John Staats)_en_to_zh.txt
   ```

   Expected behavior:

   - No zero-byte host file named `The WoW Diary`.
   - No alternate data stream output.
   - Workflow metadata points to the sanitized visible paths.

## Acceptance Criteria

- Running an ebook workflow with a colon in `book_name` creates normal visible `.epub` and `.txt` files.
- The workflow no longer creates NTFS alternate data streams accidentally.
- Existing workflows with safe filenames keep working.
- Output metadata reports the actual sanitized output paths.
- Tests cover the colon bug and other unsafe filename characters.

## Recovery Notes For Existing Broken Outputs

If this bug has already happened on Windows, do not delete the visible zero-byte host file immediately. The real data may be stored in an alternate data stream attached to that file.

Use PowerShell to inspect streams:

```powershell
Get-Item -Path "path\to\host-file" -Stream *
```

If streams are present, recover them by reading the stream and writing it to a normal filename. After recovery is verified, the zero-byte host file can be removed.

## Design Note

Do not try to disable NTFS alternate data streams globally. They are a filesystem feature and are used by Windows for legitimate metadata, such as downloaded-file zone information. The application-level fix is to avoid sending unsafe filenames to the filesystem in the first place.
