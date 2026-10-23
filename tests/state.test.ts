import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditHistory, atomicJson } from "../src/state.ts";
import { makeTicket } from "./helpers.ts";

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "triager-state-")), name);
}

const NOW = new Date("2026-01-15T12:00:00.000Z");

describe("atomicJson", () => {
  it("writes scrubbed, indented JSON and preserves the file on failure", () => {
    const path = tempFile("state.json");
    atomicJson(path, { a: 1 });
    expect(readFileSync(path, "utf-8")).toBe('{\n  "a": 1\n}\n');
    const original = readFileSync(path, "utf-8");
    expect(() => atomicJson(path, { b: Number.NaN })).toThrow(/not JSON compliant/);
    expect(readFileSync(path, "utf-8")).toBe(original);
  });
});

describe("AuditHistory", () => {
  it("missing file is a fresh start; malformed state aborts", () => {
    const path = tempFile("state.json");
    expect(
      new AuditHistory(path, 30).isDuplicate(makeTicket(), { team: null, component: null }, NOW),
    ).toBeFalsy();
    for (const content of ["{broken", "[]", '{"PROJ-1": {}}']) {
      writeFileSync(path, content, "utf-8");
      expect(() => new AuditHistory(path, 30)).toThrow(/unreadable\/corrupt/);
    }
  });

  it("rejects entries with bad hashes, choices, or timezone-less timestamps", () => {
    const path = tempFile("state.json");
    const base = {
      decision: "ok",
      choice: { team: null, component: null },
      assigned_hash: "0".repeat(64),
    };
    writeFileSync(path, JSON.stringify({ K: { ...base, assigned_hash: "xyz" } }), "utf-8");
    expect(() => new AuditHistory(path, 30)).toThrow(/invalid audit entry/);
    writeFileSync(path, JSON.stringify({ K: { ...base, choice: { team: "x" } } }), "utf-8");
    expect(() => new AuditHistory(path, 30)).toThrow(/invalid audit entry/);
    writeFileSync(
      path,
      JSON.stringify({ K: { ...base, timestamp: "2026-01-01T00:00:00" } }),
      "utf-8",
    );
    expect(() => new AuditHistory(path, 30)).toThrow(/timezone/);
  });

  it("deduplicates identical re-audits within the recheck window", () => {
    const path = tempFile("state.json");
    const history = new AuditHistory(path, 30);
    const ticket = makeTicket({ team: "Platform", component: "Catalog" });
    const choices = { team: "Platform", component: "Catalog" };
    history.record(
      ticket,
      { key: ticket.key, outcome: "ok", decisions: [], writes: [], choice: choices },
      NOW,
    );
    const reloaded = new AuditHistory(path, 30);
    expect(reloaded.isDuplicate(ticket, choices, NOW)).toBeTruthy();
    expect(
      reloaded.isDuplicate(ticket, choices, new Date(NOW.getTime() + 31 * 86_400_000)),
    ).toBeFalsy();
    // changed values are not duplicates
    expect(
      reloaded.isDuplicate(makeTicket({ team: "Install", component: "Catalog" }), choices, NOW),
    ).toBeFalsy();
  });

  it("only corrected-with-written and ok decisions deduplicate", () => {
    const path = tempFile("state.json");
    const history = new AuditHistory(path, 30);
    const ticket = makeTicket({ team: "A", component: "B" });
    const choices = { team: "A", component: "B" };
    for (const outcome of ["uncertain", "classify-failed"] as const) {
      history.record(
        ticket,
        { key: ticket.key, outcome, decisions: [], writes: [], choice: choices },
        NOW,
      );
      expect(new AuditHistory(path, 30).isDuplicate(ticket, choices, NOW)).toBeFalsy();
    }
    history.record(
      ticket,
      { key: ticket.key, outcome: "ok", decisions: [], writes: [], choice: choices },
      NOW,
    );
    expect(new AuditHistory(path, 30).isDuplicate(ticket, choices, NOW)).toBeTruthy();
  });

  it("corrected records the post-correction assignment; dry-run corrections are not remembered", () => {
    const path = tempFile("state.json");
    const history = new AuditHistory(path, 30);
    const ticket = makeTicket({ team: "Install", component: "Catalog" });
    const choices = { team: "Platform", component: "Catalog" };
    history.record(
      ticket,
      {
        key: ticket.key,
        outcome: "corrected",
        decisions: [],
        writes: [{ key: ticket.key, field: "team", value: "Platform", status: "dry-run" }],
        choice: choices,
      },
      NOW,
    );
    // dry-run correction: nothing remembered as corrected
    expect(new AuditHistory(path, 30).isDuplicate(ticket, choices, NOW)).toBeFalsy();

    history.record(
      ticket,
      {
        key: ticket.key,
        outcome: "corrected",
        decisions: [],
        writes: [{ key: ticket.key, field: "team", value: "Platform", status: "written" }],
        choice: choices,
      },
      NOW,
    );
    // the recorded hash covers the corrected assignment
    const correctedTicket = makeTicket({ team: "Platform", component: "Catalog" });
    expect(new AuditHistory(path, 30).isDuplicate(correctedTicket, choices, NOW)).toBeTruthy();
    expect(new AuditHistory(path, 30).isDuplicate(ticket, choices, NOW)).toBeFalsy();
  });

  it("deduplicated records do not extend the timestamp", () => {
    const path = tempFile("state.json");
    const history = new AuditHistory(path, 30);
    const ticket = makeTicket({ team: "A", component: "B" });
    const choices = { team: "A", component: "B" };
    history.record(
      ticket,
      { key: ticket.key, outcome: "ok", decisions: [], writes: [], choice: choices },
      NOW,
    );
    const original = readFileSync(path, "utf-8");
    history.record(
      ticket,
      {
        key: ticket.key,
        outcome: "ok",
        decisions: [],
        writes: [],
        choice: choices,
        deduplicated: true,
      },
      new Date(NOW.getTime() + 86_400_000),
    );
    expect(readFileSync(path, "utf-8")).toBe(original);
  });
});
