import { timingSafeEqual } from "crypto";

// Constant-time token comparison. A length mismatch still burns a
// timingSafeEqual against a same-length buffer so the early return does not
// leak the expected token length.
export function tokensEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}
