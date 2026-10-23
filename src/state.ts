// Audit history: validated, atomically persisted single-runner audit state.

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
  fsyncSync,
  existsSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import type { Ticket } from "./normalize.ts";
import { describeException, scrub } from "./redact.ts";
import type { TicketResult } from "./records.ts";

interface AuditEntry {
  decision: string;
  timestamp: string;
  choice: { team: string | null; component: string | null };
  assigned_hash: string;
}

type AuditState = Partial<Record<string, AuditEntry>>;

function assignmentHash(ticket: Pick<Ticket, "team" | "component">): string {
  // Fixed key order makes the hash deterministic across runs.
  const payload = JSON.stringify({ component: ticket.component, team: ticket.team });
  return createHash("sha256").update(payload, "utf-8").digest("hex");
}

/** Atomic JSON write: scrubbed, indented, fsynced, rename over destination. */
export function atomicJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const json = JSON.stringify(
    scrub(data),
    (_key, value: unknown) => {
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new Error("Out of range float values are not JSON compliant");
      }
      return value;
    },
    2,
  );
  const temp = join(dirname(path), `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "w");
    writeSync(fd, `${json}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
    if (existsSync(temp)) {
      unlinkSync(temp);
    }
  }
}

const HEX64 = /^[0-9a-f]{64}$/u;
const TZ_TIMESTAMP = /(?:Z|[+-]\d{2}:?\d{2})$/u;

function loadState(path: string): AuditState {
  /** Missing file is first run; malformed/unreadable state aborts startup. */
  if (!existsSync(path)) {
    return {};
  }
  try {
    const state: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!isRecordState(state)) {
      throw new Error("expected object");
    }
    for (const entry of Object.values(state)) {
      if (
        !["ok", "corrected", "uncertain", "classify-failed"].includes(entry.decision) ||
        typeof entry.assigned_hash !== "string" ||
        !HEX64.test(entry.assigned_hash) ||
        !isChoice(entry.choice)
      ) {
        throw new Error("invalid audit entry");
      }
      if (!TZ_TIMESTAMP.test(entry.timestamp) || Number.isNaN(Date.parse(entry.timestamp))) {
        throw new Error("timestamp needs timezone");
      }
    }
    return state;
  } catch (error) {
    throw new Error(`audit state unreadable/corrupt: ${describeException(error)}`);
  }
}

function isChoice(value: unknown): value is { team: string | null; component: string | null } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const choice = value as Record<string, unknown>;
  return (
    Object.keys(choice).length === 2 &&
    Object.entries(choice).every(
      ([key, v]) =>
        (key === "team" || key === "component") && (v === null || typeof v === "string"),
    )
  );
}

function isRecordState(value: unknown): value is Record<string, AuditEntry> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class AuditHistory {
  private readonly path: string;
  private readonly recheckDays: number;
  private readonly state: AuditState;

  constructor(path: string, recheckDays: number) {
    this.path = path;
    this.recheckDays = recheckDays;
    this.state = loadState(path);
  }

  isDuplicate(
    snapshot: Ticket,
    choices: { team: string | null; component: string | null },
    now: Date,
  ): boolean {
    const previous: AuditEntry | undefined = this.state[snapshot.key];
    if (previous === undefined) {
      return false;
    }
    if (!["corrected", "ok"].includes(previous.decision)) {
      return false;
    }
    if (previous.choice.team !== choices.team || previous.choice.component !== choices.component) {
      return false;
    }
    if (previous.assigned_hash !== assignmentHash(snapshot)) {
      return false;
    }
    const ageMs = now.getTime() - Date.parse(previous.timestamp);
    return ageMs >= 0 && ageMs < this.recheckDays * 86_400_000;
  }

  record(snapshot: Ticket, result: TicketResult, now: Date): void {
    this.remember(snapshot, result, now);
    atomicJson(this.path, this.state);
  }

  private remember(ticket: Ticket, result: TicketResult, now: Date): void {
    // Do not extend the recheck interval on every run.
    if (result.deduplicated) {
      return;
    }
    const decision = result.outcome;
    const assigned = { ...ticket };
    if (decision === "corrected") {
      if (result.writes.length === 0 || result.writes.some((write) => write.status !== "written")) {
        return;
      }
      for (const write of result.writes) {
        (assigned as Record<string, unknown>)[write.field] = write.value;
      }
    }
    this.state[ticket.key] = {
      decision,
      timestamp: now.toISOString(),
      choice: result.choice ?? { team: null, component: null },
      assigned_hash: assignmentHash(assigned),
    };
  }
}
