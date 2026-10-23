// Bounded, secret-redacted diagnostics. Secrets are registered once at
// config load; every log line and report goes through redact()/scrub().
const REDACTED = "[REDACTED]";
const secrets: string[] = [];

/** Register secret strings (tokens, webhook URLs) to scrub from logs. */
export function registerSecrets(...values: unknown[]): void {
  for (const value of values) {
    if (typeof value === "string" && value) {
      secrets.push(value);
    }
  }
}

/** Test seam: forget every registered secret (one run = one registry). */
export function resetSecrets(): void {
  secrets.length = 0;
}

/** Bounded diagnostic string with every registered secret replaced. */
export function redact(text: unknown, limit = 200): string {
  let scrubbed = String(text);
  for (const secret of secrets) {
    scrubbed = scrubbed.replaceAll(secret, REDACTED);
  }
  return scrubbed.slice(0, limit);
}

/** Redact every string leaf and key before emitting structured data. */
export function scrub(value: string): string;
export function scrub(value: null | undefined): null;
export function scrub<T>(value: readonly T[]): T[];
export function scrub(value: unknown): unknown;
export function scrub(value: unknown): unknown {
  if (typeof value === "string") {
    return redact(value, value.length);
  }
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(scrub);
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [scrub(k), scrub(v)]));
  }
  return value;
}

/** Bounded, redacted "Error: message" form of an exception for logs. */
export function describeException(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return redact(`${name}: ${message}`);
}
