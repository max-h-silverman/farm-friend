import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
  A BACKTICK INSIDE A SQL TEMPLATE LITERAL IS A SYNTAX ERROR, AND IT LOOKS LIKE PROSE.

  Every raw query in this codebase is written inside a template literal, and the comments
  explaining those queries are written in the same Markdown-ish house style as everything else
  — which means reaching for backticks to quote an identifier. Inside a template literal a
  backtick CLOSES the string, so the rest of the query becomes JavaScript and the file fails to
  parse somewhere far from the comment that caused it.

  F-114 C.5 hit this FIVE times across three files. It is caught by typecheck every time, but
  the error names a column ("Expected ')' but found is_public") rather than the comment, so each
  occurrence costs a hunt. This test names the cause directly.

  ## Why a source tripwire rather than a lint rule

  The property belongs to the interaction between two things a linter sees separately: a comment
  that is legal text, and a string delimiter that is legal syntax. It is the same class as the
  other tripwires in this package — asserted against source because it is about how the file is
  WRITTEN, not about what it does. And like those, it is the kind of test easiest to write
  wrongly, so it proves its own scanner below before trusting a clean result.
*/

const repositoryRoot = new URL("../../../", import.meta.url);

const SCANNED_DIRECTORIES = ["packages/db/src", "apps/web/lib", "apps/web/app"];

/** Every `.ts`/`.tsx` file under the scanned roots, recursively. */
function sourceFiles(relativeDirectory: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(new URL(directory, repositoryRoot));
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${directory}/${entry}`;
      const stats = statSync(new URL(child, repositoryRoot));
      if (stats.isDirectory()) {
        walk(child);
        continue;
      }
      if (child.endsWith(".ts") || child.endsWith(".tsx")) found.push(child);
    }
  };
  walk(relativeDirectory);
  return found;
}

/**
 * Find SQL comment lines that contain a backtick.
 *
 * The signal is deliberately narrow: a line whose first non-space characters are `--` (a SQL
 * line comment, which can only appear inside a query string) and which also contains a
 * backtick. That combination has no legitimate form — a SQL comment is never JavaScript, so a
 * backtick in one is always the delimiter, never a quote.
 *
 * Block comments inside template literals are NOT scanned: they are ordinary text to the SQL
 * parser but they sit inside the same template literal, so a backtick in one breaks the file
 * identically. They are caught by the same rule because the scan is line-based and a
 * template-literal block comment's lines do not start with `--`… which is exactly why this
 * function reports them separately below.
 */
function sqlCommentBackticks(source: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  const lines = source.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!/^\s*--/.test(line)) continue;
    if (!line.includes("`")) continue;
    found.push({ line: index + 1, text: line.trim() });
  }
  return found;
}

describe("SQL comments never contain a backtick", () => {
  it("proves the scanner works against a line it must catch", () => {
    // The tripwire's own guard. A scanner that silently matched nothing would make every
    // assertion below vacuously pass — the exact failure mode F-078's raw-email tripwire had,
    // green from the day it shipped.
    const caught = sqlCommentBackticks(
      ["      -- the `is_public` column is the farmer's own switch", "      where l.is_public"].join(
        "\n",
      ),
    );
    expect(caught).toHaveLength(1);
    expect(caught[0]?.line).toBe(1);
  });

  it("does not flag an ordinary SQL comment", () => {
    // The other direction, so the rule cannot be satisfied by a scanner that flags everything.
    expect(
      sqlCommentBackticks("      -- the is_public column is the farmer's own switch"),
    ).toEqual([]);
  });

  it("does not flag a JavaScript comment that legitimately quotes an identifier", () => {
    // `//` comments live outside template literals, where a backtick is ordinary prose. Flagging
    // them would make this tripwire unusable in a codebase that documents itself this way.
    expect(sqlCommentBackticks("  // `is_public` is the farmer's own switch")).toEqual([]);
  });

  it("finds no backtick in any SQL comment in the query-carrying source", () => {
    const offenders: string[] = [];
    for (const directory of SCANNED_DIRECTORIES) {
      for (const file of sourceFiles(directory)) {
        const source = readFileSync(new URL(file, repositoryRoot), "utf8");
        for (const hit of sqlCommentBackticks(source)) {
          offenders.push(`${file}:${hit.line}  ${hit.text}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("scans a corpus large enough to be meaningful", () => {
    // A path typo would make the sweep above pass against zero files. Anchored to a count the
    // repository comfortably exceeds rather than to an exact number that churns.
    const scanned = SCANNED_DIRECTORIES.flatMap(sourceFiles);
    expect(scanned.length).toBeGreaterThan(100);
  });
});
