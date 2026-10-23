// Raw Jira Cloud adaptation: one boundary turns untrusted REST payloads
// into validated Tickets, or fails closed (IssueValidationError). Callers
// must fail the ticket, never treat an unreadable shape as a missing
// (writable) field.
import { TEAM_FIELD, searchFields } from "./config.ts";

export class IssueValidationError extends Error {}

export interface Ticket {
  key: string;
  title: string;
  description: string;
  component: string | null;
  team: string | null;
  assignee: string | null;
  projectKey: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function fieldOf(value: unknown, name: string): unknown {
  return isRecord(value) ? value[name] : undefined;
}

export function normalizeIssue(
  issue: unknown,
  expectedKey: string | null = null,
  teamField: string = TEAM_FIELD,
): Ticket {
  const key = isRecord(issue) ? issue.key : undefined;
  if (typeof key !== "string" || !key) {
    throw new IssueValidationError("fetched issue has no readable key");
  }
  if (expectedKey !== null && key !== expectedKey) {
    throw new IssueValidationError(
      `fetched issue key '${key}' does not match requested '${expectedKey}'`,
    );
  }
  const raw = isRecord(issue) ? issue.raw : undefined;
  const fields = isRecord(raw) ? raw.fields : isRecord(issue) ? issue.fields : undefined;
  if (!isRecord(fields)) {
    throw new IssueValidationError(`${key}: response has no fields object`);
  }
  const missing = searchFields(teamField).filter((name) => !(name in fields));
  if (missing.length > 0) {
    throw new IssueValidationError(`${key}: response omitted fields: ${missing.join(", ")}`);
  }

  if (fields.summary !== null && typeof fields.summary !== "string") {
    throw new IssueValidationError(`${key}: unreadable summary value`);
  }
  const description = descriptionText(fields.description);

  let component: string | null = null;
  const { components } = fields;
  if (components !== null && !Array.isArray(components)) {
    throw new IssueValidationError(`${key}: components must be a list or null`);
  }
  if (components && components.length > 0) {
    const name = fieldOf(components[0], "name");
    if (typeof name !== "string" || !name) {
      throw new IssueValidationError(`${key}: unreadable components value (no component name)`);
    }
    component = name;
  }

  const teamRaw = fields[teamField];
  let team: string | null = null;
  if (teamRaw === null || teamRaw === undefined) {
    team = null;
  } else if (isRecord(teamRaw)) {
    team = (teamRaw.name ?? null) as string | null;
    if (team !== null && (typeof team !== "string" || !team.trim())) {
      throw new IssueValidationError(`${key}: unreadable Team name`);
    }
  } else {
    throw new IssueValidationError(`${key}: unreadable Team value`);
  }

  let assignee: string | null = null;
  const assigneeRaw = fields.assignee;
  if (assigneeRaw !== null && assigneeRaw !== undefined) {
    const name = fieldOf(assigneeRaw, "displayName") ?? fieldOf(assigneeRaw, "name");
    assignee = typeof name === "string" && name ? name : null;
  }

  const projectKey =
    fields.project !== null && fields.project !== undefined ? fieldOf(fields.project, "key") : null;
  if (typeof projectKey !== "string" || !projectKey) {
    throw new IssueValidationError(`${key}: missing or unreadable project (no default is assumed)`);
  }

  return {
    key,
    title: fields.summary ?? "",
    description,
    component,
    team,
    assignee,
    projectKey,
  };
}

const ADF_CONTAINERS = new Set([
  "doc",
  "paragraph",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "codeBlock",
  "panel",
  "table",
  "tableRow",
  "tableCell",
  "tableHeader",
  "expand",
  "nestedExpand",
  "mediaSingle",
  "mediaGroup",
  "taskList",
  "taskItem",
]);
const ADF_LEAVES = new Set([
  "hardBreak",
  "rule",
  "mention",
  "emoji",
  "inlineCard",
  "date",
  "status",
  "media",
]);

/** Cloud ADF -> bounded plain text; malformed documents fail closed. */
export function descriptionText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value) || value.type !== "doc") {
    throw new IssueValidationError("unreadable description value");
  }
  const texts: string[] = [];
  let count = 0;
  const visit = (node: unknown, depth: number): void => {
    count += 1;
    if (depth > 10 || count > 10_000 || !isRecord(node)) {
      throw new IssueValidationError("malformed description ADF (bounds/node)");
    }
    const kind = node.type;
    if (typeof kind !== "string") {
      throw new IssueValidationError("malformed description ADF type");
    }
    if (kind === "text") {
      if (typeof node.text !== "string" || "content" in node) {
        throw new IssueValidationError("malformed description ADF text");
      }
      texts.push(node.text);
    } else if (ADF_CONTAINERS.has(kind) || ADF_LEAVES.has(kind)) {
      if (ADF_LEAVES.has(kind) && "content" in node) {
        throw new IssueValidationError("malformed description ADF leaf");
      }
      const content = node.content ?? [];
      if (!Array.isArray(content)) {
        throw new IssueValidationError("malformed description ADF content");
      }
      for (const child of content) {
        visit(child, depth + 1);
      }
    } else {
      throw new IssueValidationError("unknown description ADF node");
    }
  };
  visit(value, 0);
  return texts.join(" ");
}

/** Case-insensitive name key with configurable prefixes stripped
 * (a site whose Jira team names carry a product prefix matches its catalog
 * entries either way). */
export function teamNameKey(name: string, prefixes: readonly string[] = []): string {
  let folded = name.trim().toLowerCase();
  for (const prefix of prefixes) {
    const normalized = prefix.trim().toLowerCase();
    if (normalized && folded.startsWith(normalized)) {
      folded = folded.slice(normalized.length).trim();
    }
  }
  return folded;
}

/** Atlassian team identifiers can append a numeric tenant suffix. */
export const TEAM_UUID_PATTERN =
  "^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}(?:-[0-9]+)?$";
const TEAM_UUID = new RegExp(TEAM_UUID_PATTERN, "u");

export function isTeamUuid(value: unknown): value is string {
  return typeof value === "string" && TEAM_UUID.test(value);
}
