// Jira reads and guarded, independently reported domain-field writes.
// Catalog UUIDs are the authoritative source for Team writes; live
// customfield_10001 observations only cross-check them.
import { SEARCH_FIELDS, TEAM_FIELD } from "./config.ts";
import type { JiraClient } from "./jira.ts";
import {
  IssueValidationError,
  isRecord,
  isTeamUuid,
  normalizeIssue,
  teamNameKey,
  type Ticket,
} from "./normalize.ts";
import { describeException, redact } from "./redact.ts";
import type { WriteResult } from "./records.ts";
import { log } from "./log.ts";
import type { TeamCatalog } from "./datafiles.ts";

export class JiraGateway {
  private readonly client: JiraClient;
  private readonly prefixes: string[];
  private readonly teamNames: Map<string, string>;
  private readonly teamIds: Map<string, string>;
  private readonly teamConflicts = new Set<string>();
  private readonly componentCache = new Map<string, string[] | null>();

  constructor(client: JiraClient, teams: TeamCatalog, teamNamePrefixes: string[] = []) {
    this.client = client;
    this.prefixes = teamNamePrefixes;
    this.teamNames = new Map(
      Object.keys(teams).map((name) => [teamNameKey(name, teamNamePrefixes), name]),
    );
    if (this.teamNames.size !== Object.keys(teams).length) {
      throw new Error("ambiguous normalized team names");
    }
    this.teamIds = new Map([...this.teamNames.values()].map((name) => [name, teams[name].id]));
  }

  private normalize(issue: unknown, expectedKey: string | null = null): Ticket {
    const ticket = normalizeIssue(issue, expectedKey);
    if (ticket.team !== null) {
      this.observeTeamUuid(issue, ticket.team);
      ticket.team = this.teamNames.get(teamNameKey(ticket.team, this.prefixes)) ?? ticket.team;
    }
    return ticket;
  }

  private observeTeamUuid(issue: unknown, teamName: string): void {
    /** Cross-check one fetched Team UUID against the catalog.

    A live UUID that disagrees with the catalog UUID for the same normalized
    team name marks that team conflicted for this run: the catalog stays
    authoritative, so Team writes targeting it abstain
    (team-uuid-conflict). Agreement needs no action. */
    const canonical = this.teamNames.get(teamNameKey(teamName, this.prefixes));
    if (canonical === undefined) {
      return;
    }
    // normalizeIssue already validated the Team object's shape; only
    // the id is re-read here (same raw/fields extraction).
    const raw = isRecord(issue) ? issue.raw : undefined;
    const fields = isRecord(raw) ? raw.fields : isRecord(issue) ? issue.fields : undefined;
    const teamField = isRecord(fields) ? fields[TEAM_FIELD] : undefined;
    const observed = isRecord(teamField) ? teamField.id : undefined;
    if (!isTeamUuid(observed)) {
      return;
    } // unset or non-UUID shape: no usable observation
    if (observed !== this.teamIds.get(canonical) && !this.teamConflicts.has(canonical)) {
      this.teamConflicts.add(canonical);
      log.warn(
        `team UUID conflict for ${redact(canonical)}: Jira observes ${redact(observed)} ` +
          `but the catalog has ${redact(this.teamIds.get(canonical) ?? "")}; ` +
          "Team writes for it abstain this run (team-uuid-conflict)",
      );
    }
  }

  private async searchPage(
    jql: string,
    fields: string[],
    size: number,
    token?: string,
  ): Promise<{ issues: unknown[]; isLast: boolean; nextPageToken?: string }> {
    const page = await this.client.searchJql(jql, size, fields, token);
    if (!isRecord(page) || !Array.isArray(page.issues) || typeof page.isLast !== "boolean") {
      throw new IssueValidationError("unreadable search response");
    }
    const nextToken = page.nextPageToken;
    if (!page.isLast && (typeof nextToken !== "string" || !nextToken)) {
      throw new IssueValidationError("search omitted nextPageToken");
    }
    return page as { issues: unknown[]; isLast: boolean; nextPageToken?: string };
  }

  async searchCandidates(limit: number, jql: string): Promise<Ticket[]> {
    const tickets: Ticket[] = [];
    const seen = new Set<string>();
    let token: string | undefined;
    while (tickets.length < limit) {
      const page = await this.searchPage(
        jql,
        SEARCH_FIELDS,
        Math.min(5000, limit - tickets.length),
        token,
      );
      const wanted = page.issues.slice(0, limit - tickets.length);
      for (const issue of wanted) {
        tickets.push(this.normalize(issue));
      }
      if (page.isLast) {
        break;
      }
      const nextToken = page.nextPageToken;
      if (typeof nextToken !== "string" || seen.has(nextToken)) {
        throw new IssueValidationError("search repeated nextPageToken");
      }
      seen.add(nextToken);
      token = nextToken;
    }
    return tickets;
  }

  /** Re-fetch, validate identity and normalize fresh state before writing. */
  async getIssue(key: string): Promise<Ticket> {
    return this.normalize(await this.client.issue(key, SEARCH_FIELDS), key);
  }

  /** Live component names for a project, or null if the lookup fails. */
  async getProjectComponents(projectKey: string): Promise<string[] | null> {
    if (!this.componentCache.has(projectKey)) {
      try {
        const comps = await this.client.projectComponents(projectKey);
        if (!Array.isArray(comps)) {
          // null (lookup failure) or garbage shape: fail closed to null
          throw new IssueValidationError("unreadable component list");
        }
        const names = comps.map((c) => (isRecord(c) ? c.name : undefined));
        const valid: string[] = [];
        for (const name of names) {
          if (typeof name !== "string") {
            throw new IssueValidationError("unreadable component name");
          }
          valid.push(name);
        }
        this.componentCache.set(projectKey, [...valid].sort());
      } catch (error) {
        // chisle: broad on purpose; any lookup failure must abstain,
        // never authorize writing an unvalidated component label.
        log.warn(`component lookup failed for ${redact(projectKey)}: ${describeException(error)}`);
        this.componentCache.set(projectKey, null);
      }
    }
    return this.componentCache.get(projectKey) ?? null;
  }

  async fillMissing(
    key: string,
    field: "team" | "component",
    value: string,
    dryRun = true,
  ): Promise<WriteResult> {
    return this.write(key, field, value, dryRun, null);
  }

  async correctUnchanged(
    snapshot: Ticket,
    field: "team" | "component",
    value: string,
    dryRun = true,
  ): Promise<WriteResult> {
    return this.write(snapshot.key, field, value, dryRun, snapshot);
  }

  private async write(
    key: string,
    field: "team" | "component",
    value: string,
    dryRun: boolean,
    snapshot: Ticket | null,
  ): Promise<WriteResult> {
    const record: WriteResult = { key, field, value, status: "error" };
    try {
      const current = await this.getIssue(key);
      if (snapshot !== null && current[field] !== snapshot[field]) {
        return { ...record, status: "skipped-race", reason: "changed-since-search" };
      }
      if (snapshot === null && current[field]) {
        return {
          ...record,
          status: "skipped",
          reason: "already-set",
          current: current[field] ?? undefined,
        };
      }
      let jiraFields: Record<string, unknown>;
      if (field === "team") {
        const canonical = this.teamNames.get(teamNameKey(value, this.prefixes));
        if (
          snapshot !== null &&
          current.team !== null &&
          !this.teamNames.has(teamNameKey(current.team, this.prefixes))
        ) {
          return { ...record, status: "abstained", reason: "unknown-team" };
        }
        if (canonical === undefined) {
          return { ...record, status: "abstained", reason: "unknown-team" };
        }
        if (this.teamConflicts.has(canonical)) {
          return { ...record, status: "abstained", reason: "team-uuid-conflict" };
        }
        jiraFields = { [TEAM_FIELD]: this.teamIds.get(canonical) };
      } else {
        jiraFields = { components: [{ name: value }] };
      }
      if (dryRun) {
        return { ...record, status: "dry-run" };
      }
      const written = await this.updateUnchanged(key, field, jiraFields, snapshot);
      return { ...record, status: written ? "written" : "skipped-race" };
    } catch (error) {
      return { ...record, status: "error", reason: describeException(error) };
    }
  }

  private async updateUnchanged(
    key: string,
    field: "team" | "component",
    jiraFields: Record<string, unknown>,
    snapshot: Ticket | null,
  ): Promise<boolean> {
    // Both update-path fetches are contractual. REST has no conditional
    // update; the window after the final fetch remains explicitly accepted.
    for (let i = 0; i < 2; i++) {
      const current = this.normalize(await this.client.issue(key, SEARCH_FIELDS), key);
      if (
        (snapshot !== null && current[field] !== snapshot[field]) ||
        (snapshot === null && current[field])
      ) {
        return false;
      }
    }
    await this.client.updateIssue(key, jiraFields);
    return true;
  }
}
