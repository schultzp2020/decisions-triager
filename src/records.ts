// The record dialects shared by the three modes: decisions (what the model
// chose), write results (what Jira did), and per-ticket results. One module
// owns the shapes so decision -> execution -> report translation has one
// home.
export type FieldName = "team" | "component";

export type DecisionAction = "assigned" | "abstained";

export interface Decision {
  field: FieldName;
  action: DecisionAction;
  source?: "model" | "assignee-route";
  value?: string | null;
  reason?: string | null;
  confidence?: number | null;
  probabilities?: [string, number][];
  write?: string;
  old?: string | null;
  new?: string | null;
}

export type WriteStatus =
  | "written"
  | "dry-run"
  | "skipped"
  | "skipped-race"
  | "abstained"
  | "error";

export interface WriteResult {
  key: string;
  field: FieldName;
  value: string;
  status: WriteStatus;
  reason?: string;
  current?: string;
}

export type Outcome =
  | "assigned"
  | "abstained"
  | "error"
  | "skipped"
  | "corrected"
  | "uncertain"
  | "ok"
  | "classify-failed";

export interface TicketResult {
  key: string | null;
  outcome: Outcome;
  decisions: Decision[];
  writes: WriteResult[];
  reason?: string;
  choice?: { team: string | null; component: string | null };
  deduplicated?: boolean;
}
