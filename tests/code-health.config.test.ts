import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * H-3 regression guards for the code-health wave (branch p3/code-health):
 *  (a) server/db.ts export count must not regress beyond the post-prune count
 *      (97 provably-dead exports were removed; see scripts/testing/dead-exports.mjs).
 *  (b) fabricated-default `.catch(() => ({...}))/[]./0` patterns must not return
 *      in the files cleaned by the H-2 zero-on-error sweep.
 */

function source(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

// Measured via scripts/testing/dead-exports.mjs at the prune commit:
// 162 exports at base (audit: 97 dead) -> 66 after pruning
// (95 removed: 91 full deletions + 4 unexported-keepalive; 2 test-pinned exports
// getFinancialAdminSnapshot/triggerJobManually restored, 2 borderline utilities kept).
const DB_EXPORTS_POST_PRUNE = 66;

describe("code-health: dead-export pruning (H-1)", () => {
  it("keeps server/db.ts export count at or below the post-prune baseline", () => {
    const db = source("server/db.ts");
    const exportCount = (db.match(/^export\s+(?:async\s+)?(?:function|const)\s/gm) || []).length;
    expect(exportCount).toBeLessThanOrEqual(DB_EXPORTS_POST_PRUNE);
  });
});

describe("code-health: zero-on-error sweep (H-2)", () => {
  const CLEANED_FILES = [
    "server/db.ts",
    "server/_core/commerceSummaries.ts",
    "server/_core/mobilityQueries.ts",
  ];

  // Patterns that fabricate zero/empty results and mask DB/query failures.
  const FABRICATED_DEFAULT_PATTERNS = [
    /\.catch\(\(\)\s*=>\s*\(\{/, // .catch(() => ({ ... }))
    /\.catch\(\(\)\s*=>\s*\[/, // .catch(() => [ ... ]
    /\.catch\(\(\)\s*=>\s*0\)/, // .catch(() => 0)
  ];

  // Legit best-effort catches allowlisted with justification comments:
  //  - db.ts: `.catch(() => undefined)` is used ONLY for best-effort ROLLBACK
  //    and best-effort idempotency-finalize writes where the real error is rethrown.
  const ALLOWLIST: Array<{ file: string; pattern: RegExp; reason: string }> = [
    {
      file: "server/db.ts",
      pattern: /\.catch\(\(\)\s*=>\s*undefined\)/,
      reason: "best-effort ROLLBACK / idempotency-finalize; original error is rethrown",
    },
  ];

  for (const file of CLEANED_FILES) {
    it(`has no fabricated-default .catch() patterns in ${file}`, () => {
      const text = source(file);
      for (const pattern of FABRICATED_DEFAULT_PATTERNS) {
        expect(pattern.test(text), `${file} must not contain ${pattern}`).toBe(false);
      }
    });
  }

  it("only allowlisted .catch() forms remain in cleaned files", () => {
    for (const file of CLEANED_FILES) {
      const text = source(file);
      const catches = text.match(/\.catch\([^=]*=>[^;]*\)?\)?;?/g) || [];
      for (const c of catches) {
        const allowed = ALLOWLIST.some((a) => a.file === file && a.pattern.test(c));
        expect(allowed, `${file} contains non-allowlisted catch: ${c}`).toBe(true);
      }
    }
  });
});
