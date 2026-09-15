/**
 * Money formatting for the trust/economics screens (Wave E1, R6–R9).
 *
 * All platform money is stored in integer minor units (kobo). These helpers
 * convert to a ₦ naira display string (divide by 100) without relying on
 * `Intl.NumberFormat`, which is not guaranteed inside the Hermes runtime.
 * Postgres bigint columns can arrive as strings over the wire, so every
 * helper accepts `number | string`.
 */

export function toNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function groupThousands(integerPart: string): string {
  return integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Format minor units (kobo) as a naira string, e.g. 153050 -> "₦1,530.50".
 * Negative amounts render with a leading minus before the symbol.
 */
export function formatMinor(
  amountMinor: number | string | null | undefined,
  currency = "NGN",
): string {
  const minor = toNumber(amountMinor);
  const sign = minor < 0 ? "-" : "";
  const absolute = Math.abs(Math.round(minor));
  const naira = Math.floor(absolute / 100);
  const kobo = absolute % 100;
  const symbol = currency === "NGN" ? "₦" : `${currency} `;
  return `${sign}${symbol}${groupThousands(String(naira))}.${String(kobo).padStart(2, "0")}`;
}

/** Format basis points as a percentage, e.g. 1200 -> "12.00%". */
export function formatBpsPercent(bps: number | string | null | undefined): string {
  return `${(toNumber(bps) / 100).toFixed(2)}%`;
}

/** Format a wire timestamp (ISO string or Date) for display. */
export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}
