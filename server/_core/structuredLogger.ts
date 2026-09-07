type StructuredValue = string | number | boolean | null;

const SAFE_KEY = /^[A-Za-z0-9._-]{1,80}$/;

export function logStructuredEvent(event: string, fields: Record<string, StructuredValue>) {
  const entry: Record<string, StructuredValue> = {
    service: "switchos-operator-dashboard",
    event,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_KEY.test(key)) continue;
    if (typeof value === "string") {
      entry[key] = value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 256);
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      entry[key] = value;
    }
  }
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}
