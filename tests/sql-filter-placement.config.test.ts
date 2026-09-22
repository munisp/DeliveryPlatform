import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Regression guard for the funds/merchant/courier hub 500s:
// PostgreSQL's FILTER clause must attach to the aggregate call itself,
// not to a COALESCE wrapping it.
//   INVALID: COALESCE(SUM(x), 0) FILTER (WHERE ...)
//   VALID:   COALESCE(SUM(x) FILTER (WHERE ...), 0)
const INVALID_FILTER_PLACEMENT =
  /COALESCE\(\s*(?:SUM|AVG|COUNT|MIN|MAX)\s*\([^()]*\)\s*,\s*[^()]+\)\s*FILTER\s*\(/i;

function listServerTs(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => join(dir, entry));
}

describe("SQL FILTER placement (perf harness finding: hub 500s)", () => {
  it("no COALESCE-wrapped aggregate in server/ carries an outer FILTER clause", () => {
    const offenders = listServerTs(join(process.cwd(), "server")).filter((file) =>
      INVALID_FILTER_PLACEMENT.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("positive control: the detector catches the invalid shape", () => {
    expect(INVALID_FILTER_PLACEMENT.test("COALESCE(SUM(amount), 0) FILTER (WHERE status = 'paid')")).toBe(true);
    expect(INVALID_FILTER_PLACEMENT.test("COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0)")).toBe(false);
  });
});
