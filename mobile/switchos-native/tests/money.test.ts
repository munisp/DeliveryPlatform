import { describe, expect, it } from "vitest";

import { formatBpsPercent, formatMinor, toNumber } from "../lib/money";

describe("toNumber", () => {
  it("passes numbers through", () => {
    expect(toNumber(150)).toBe(150);
  });
  it("parses string-encoded bigint columns", () => {
    expect(toNumber("153050")).toBe(153050);
  });
  it("returns 0 for nullish and non-numeric input", () => {
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber("not-a-number")).toBe(0);
  });
});

describe("formatMinor (kobo -> naira)", () => {
  it("divides minor units by 100 and prefixes the naira symbol", () => {
    expect(formatMinor(153050)).toBe("₦1,530.50");
  });
  it("groups thousands", () => {
    expect(formatMinor(123456789)).toBe("₦1,234,567.89");
  });
  it("zero-pads kobo", () => {
    expect(formatMinor(100005)).toBe("₦1,000.05");
  });
  it("handles string input from bigint columns", () => {
    expect(formatMinor("250000")).toBe("₦2,500.00");
  });
  it("renders negative amounts with a leading minus", () => {
    expect(formatMinor(-45050)).toBe("-₦450.50");
  });
  it("renders zero", () => {
    expect(formatMinor(0)).toBe("₦0.00");
  });
  it("uses a currency prefix for non-NGN currencies", () => {
    expect(formatMinor(10000, "USD")).toBe("USD 100.00");
  });
});

describe("formatBpsPercent", () => {
  it("converts basis points to a percentage", () => {
    expect(formatBpsPercent(1200)).toBe("12.00%");
  });
  it("handles fractional basis points", () => {
    expect(formatBpsPercent(55)).toBe("0.55%");
  });
  it("parses string input", () => {
    expect(formatBpsPercent("2500")).toBe("25.00%");
  });
});
