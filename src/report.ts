// Run summary and JSON report artifacts.
import { appendFileSync, mkdirSync } from "node:fs";
import type { Config } from "./config.ts";
import { log } from "./log.ts";
import { scrub } from "./redact.ts";
import type { TicketResult } from "./records.ts";
import { atomicJson } from "./state.ts";

export interface Summary {
  total: number;
  counts: Record<string, number>;
  keys: Record<string, string[]>;
  writeErrors: number;
  metrics?: unknown;
  report?: string;
}

const OUTCOMES = [
  "assigned",
  "abstained",
  "error",
  "skipped",
  "corrected",
  "uncertain",
  "ok",
  "classify-failed",
] as const;

export function summarize(results: TicketResult[]): Summary {
  const counts = Object.fromEntries(OUTCOMES.map((name) => [name, 0]));
  const keys = Object.fromEntries(OUTCOMES.map((name) => [name, [] as string[]]));
  for (const result of results) {
    counts[result.outcome] += 1;
    keys[result.outcome].push(result.key ?? "");
  }
  const writeErrors = results.reduce(
    (sum, result) => sum + result.writes.filter((write) => write.status === "error").length,
    0,
  );
  return { total: results.length, counts, keys, writeErrors };
}

export function summaryText(summary: Summary): string {
  const lines = ["Jira triager run complete."];
  for (const [name, count] of Object.entries(summary.counts)) {
    const keys = summary.keys[name].join(", ") || "-";
    lines.push(`${name}: ${count} (${keys})`);
  }
  return lines.join("\n");
}

interface ReportField {
  field: string;
  old: string | null;
  new: string | null;
  confidence: number | null;
  probabilities: [string, number][] | unknown[];
  write?: string;
}

function reportRows(results: TicketResult[]): {
  key: string | null;
  decision: string;
  fields: ReportField[];
  writes: unknown[];
  deduplicated: boolean;
}[] {
  return results.map((result) => ({
    key: result.key,
    decision: result.outcome,
    fields: result.decisions.map((decision) => ({
      field: decision.field,
      old: decision.old ?? null,
      new: decision.new ?? decision.value ?? null,
      confidence: decision.confidence ?? null,
      probabilities: decision.probabilities ?? [],
      write: decision.write,
    })),
    writes: result.writes,
    deduplicated: result.deduplicated ?? false,
  }));
}

export function writeReport(
  config: Config,
  results: TicketResult[],
  summary: Summary,
  metrics?: unknown,
): string {
  const now = new Date();
  const path =
    config.reportFile ||
    `report-${now.toISOString().slice(0, 10).replaceAll("-", "")}-${now
      .toISOString()
      .slice(11, 19)
      .replaceAll(":", "")}.json`;
  const report = {
    mode: config.mode,
    timestamp: now.toISOString(),
    counts: summary.counts,
    tickets: reportRows(results),
    ...(metrics === undefined ? {} : { metrics }),
  };
  atomicJson(path, report);
  mkdirSync("reports", { recursive: true });
  appendFileSync(
    "reports/index.jsonl",
    `${JSON.stringify(
      scrub({
        report: path,
        mode: config.mode,
        timestamp: now.toISOString(),
        counts: summary.counts,
      }),
    )}\n`,
    "utf-8",
  );
  return path;
}

export function logTicketResult(result: TicketResult): void {
  log.info(JSON.stringify(scrub(result)));
}
