import { describe, expect, it } from "vitest";
import { describeException, redact, registerSecrets, resetSecrets, scrub } from "../src/redact.ts";

describe("redact", () => {
  it("replaces registered secrets and bounds output", () => {
    resetSecrets();
    registerSecrets("tok-123", "", 42, null);
    expect(redact("failed: tok-123 and tok-123")).toBe("failed: [REDACTED] and [REDACTED]");
    expect(redact("x".repeat(10_000))).toHaveLength(200);
  });

  it("keeps non-string and empty registrations out", () => {
    resetSecrets();
    registerSecrets("", null, 42);
    expect(redact("plain")).toBe("plain");
  });

  it("scrubs every string leaf and key in structured data", () => {
    resetSecrets();
    registerSecrets("sekrit");
    const scrubbed = scrub({ "sekrit-key": ["value sekrit", 1, null] });
    expect(JSON.stringify(scrubbed)).not.toContain("sekrit");
    expect(JSON.stringify(scrubbed)).toContain("[REDACTED]");
  });

  it("describeException is bounded and redacted", () => {
    resetSecrets();
    registerSecrets("tok-xyz");
    expect(describeException(new Error("boom tok-xyz"))).toBe("Error: boom [REDACTED]");
    expect(describeException(new Error("boom".repeat(1000)))).toHaveLength(200);
  });
});
