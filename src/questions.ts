// Classifier request construction: state and questions for one ticket.
// The state key names are the model's prompt contract (documented in
// README.md) — do not rename them.
import type { Question } from "./classifier.ts";
import type { TeamCatalog } from "./datafiles.ts";
import type { Ticket } from "./normalize.ts";
import { log } from "./log.ts";
import { redact } from "./redact.ts";

export const TEAM_INSTRUCTIONS =
  "Pick the single team that should own this ticket. Judge by the " +
  "ticket title, description, existing component, assignee, and each " +
  "team's component scope. Choose the team that owns the ticket's " +
  "primary deliverable. Component associations are indicative, not " +
  "exclusive; teams mentioned in passing are not the owner.";

function lookup(map: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

export const COMPONENT_INSTRUCTIONS =
  "Pick the single component from this ticket's project that best matches the ticket.";

// A type alias (not an interface) so it satisfies Record<string, unknown>.
export interface ClassifierState {
  key: string;
  title: string;
  cleaned_description: string;
  existing_team: string;
  existing_component: string;
  assignee: string;
  assignee_team: string;
  allowed_components: string[];
  description_truncated?: boolean;
}

/** Deterministic team for an assignee by member display name. */
export function matchAssigneeTeam(assignee: string | null, teams: TeamCatalog): string | null {
  // chisle: trimmed, case-insensitive display-name matching; a stable Jira
  // username would be better but is not reliably populated on these issues.
  if (!assignee) {
    return null;
  }
  const wanted = assignee.trim().toLowerCase();
  for (const [name, team] of Object.entries(teams)) {
    for (const member of team.members) {
      if (member.trim().toLowerCase() === wanted) {
        return name;
      }
    }
  }
  return null;
}

/** Normalize a Jira description: drop {noformat}, CRLF, edge whitespace. */
export function cleanDescription(text: string | null): string {
  if (!text) {
    return "";
  }
  return text.replaceAll("{noformat}", "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}

/** Map an old/informal component name to its canonical form. */
export function canonicalizeComponent(
  name: string | null,
  aliases: Record<string, string>,
): string | null {
  if (name === null) {
    return null;
  }
  return aliases[name] ?? name;
}

/** Cap a cleaned description at maxChars characters.

The System One router rejects classify inputs over 8192 tokens and Jira
descriptions are unbounded, so the state stays under the budget. Word-
boundary cut when one falls inside the tail, else a hard cut.
Returns [text, truncated]. */
export function truncateDescription(text: string, maxChars: number): [string, boolean] {
  if (text.length <= maxChars) {
    return [text, false];
  }
  let cut = text.slice(0, maxChars);
  const boundary = cut.lastIndexOf(" ");
  if (boundary >= Math.floor(maxChars / 2)) {
    cut = cut.slice(0, boundary);
  }
  return [cut.replace(/\s+$/u, ""), true];
}

export function buildState(
  ticket: Ticket,
  liveComponents: string[] | null,
  assigneeTeam: string | null,
  maxChars = 48_000,
): ClassifierState {
  const cleaned = cleanDescription(ticket.description);
  const [description, truncated] = truncateDescription(cleaned, maxChars);
  if (truncated) {
    log.warn(`description truncated to ${maxChars} chars for ${redact(ticket.key)}`);
  }
  const state: ClassifierState = {
    key: ticket.key,
    title: ticket.title,
    cleaned_description: description,
    existing_team: ticket.team ?? "",
    existing_component: ticket.component ?? "",
    assignee: ticket.assignee ?? "",
    assignee_team: assigneeTeam ?? "",
    allowed_components: [...(liveComponents ?? [])],
  };
  if (truncated) {
    state.description_truncated = true;
  }
  return state;
}

/** System One choice questions for the fields that still need a decision. */
export function buildQuestions(
  needTeam: boolean,
  needComponent: boolean,
  teams: TeamCatalog,
  liveComponents: string[],
  descriptions: Record<string, string>,
  aliases: Record<string, string>,
): Record<string, Question> {
  const questions: Record<string, Question> = {};
  if (needTeam) {
    questions.team = {
      type: "choice",
      instructions: TEAM_INSTRUCTIONS,
      criteria: Object.fromEntries(
        Object.entries(teams).map(([name, team]) => [
          name,
          `${team.description ? `${team.description} ` : ""}Frequently works on: ${team.components.join(", ")}`,
        ]),
      ),
    };
  }
  if (needComponent) {
    questions.component = {
      type: "choice",
      instructions: COMPONENT_INSTRUCTIONS,
      criteria: Object.fromEntries(
        liveComponents.map((label) => [
          label,
          lookup(descriptions, label) ??
            lookup(descriptions, lookup(aliases, label) ?? label) ??
            "No description available.",
        ]),
      ),
    };
  }
  return questions;
}
