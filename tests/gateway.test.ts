import { describe, expect, it } from "vitest";
import { TEAM_FIELD, searchFields } from "../src/config.ts";
import { JiraGateway } from "../src/gateway.ts";
import { IssueValidationError, normalizeIssue } from "../src/normalize.ts";
import { registerSecrets } from "../src/redact.ts";
import {
  ALIASES,
  DESCRIPTIONS,
  FakeClassifier,
  FakeJiraClient,
  LIVE_COMPONENTS,
  OTHER_UUID,
  TEAMS,
  UUID,
  choiceAnswer,
  makeTicket,
  rawIssue,
} from "./helpers.ts";

function gateway(client: FakeJiraClient, prefixes: string[] = []): JiraGateway {
  return new JiraGateway(client, structuredClone(TEAMS), prefixes);
}

const EXAMPLE_JQL = "project in (PROJ)";

describe("JiraGateway.searchCandidates", () => {
  it("passes the quoted JQL and requested fields", async () => {
    const client = new FakeJiraClient({ searchResults: [rawIssue("PROJ-1")] });
    const tickets = await gateway(client).searchCandidates(5, EXAMPLE_JQL);
    expect(client.searchCalls[0]).toEqual({
      jql: EXAMPLE_JQL,
      maxResults: 5,
      fields: searchFields(TEAM_FIELD),
    });
    expect(tickets[0].key).toBe("PROJ-1");
  });

  it("rejects partial responses before any write can be authorized", async () => {
    const client = new FakeJiraClient({
      searchResults: [{ key: "PROJ-1", fields: { summary: "t" }, updates: [] }],
    });
    await expect(gateway(client).searchCandidates(100, EXAMPLE_JQL)).rejects.toThrow(
      IssueValidationError,
    );
  });

  it("bounds results and page size", async () => {
    const client = new FakeJiraClient({ searchResults: [rawIssue("PROJ-1")] });
    expect((await gateway(client).searchCandidates(1, EXAMPLE_JQL)).length).toBe(1);
    const big = new FakeJiraClient({ searchResults: [] });
    await gateway(big).searchCandidates(6000, EXAMPLE_JQL);
    expect(big.searchCalls[0].maxResults).toBe(5000);
  });

  it("rejects a mismatched re-fetch key", async () => {
    const client = new FakeJiraClient({ issues: { "PROJ-1": [rawIssue("PROJ-2")] } });
    await expect(gateway(client).getIssue("PROJ-1")).rejects.toThrow(/does not match/);
  });
});

describe("JiraGateway guarded writes", () => {
  it("honors a configured team_field for reads and writes", async () => {
    const other = "customfield_99999";
    const issue = rawIssue("PROJ-1");
    delete issue.fields[TEAM_FIELD];
    issue.fields[other] = { name: "Platform", id: UUID };
    const client = new FakeJiraClient({ searchResults: [structuredClone(issue)] });
    const g = new JiraGateway(client, structuredClone(TEAMS), [], other);
    const tickets = await g.searchCandidates(5, EXAMPLE_JQL);
    expect(tickets[0]?.team).toBe("Platform");
    expect(client.searchCalls[0]).toEqual({
      jql: EXAMPLE_JQL,
      maxResults: 5,
      fields: searchFields(other),
    });

    issue.fields[other] = null; // team now missing
    const writeClient = new FakeJiraClient({ issues: { "PROJ-1": [issue] } });
    const gw = new JiraGateway(writeClient, structuredClone(TEAMS), [], other);
    const result = await gw.fillMissing("PROJ-1", "team", "Platform", false);
    expect(result.status).toBe("written");
    expect(writeClient.updates).toEqual([{ key: "PROJ-1", fields: { [other]: UUID } }]);
  });

  it("writes the catalog team UUID and component name when still missing", async () => {
    const client = new FakeJiraClient({ issues: { "PROJ-1": [rawIssue()] } });
    const result = await gateway(client).fillMissing("PROJ-1", "team", "Platform", false);
    expect(result.status).toBe("written");
    expect(client.updates).toEqual([{ key: "PROJ-1", fields: { [TEAM_FIELD]: UUID } }]);

    const client2 = new FakeJiraClient({ issues: { "PROJ-1": [rawIssue()] } });
    const result2 = await gateway(client2).fillMissing("PROJ-1", "component", "Catalog", false);
    expect(result2.status).toBe("written");
    expect(client2.updates).toEqual([
      { key: "PROJ-1", fields: { components: [{ name: "Catalog" }] } },
    ]);
  });

  it("skips when the pre-write re-fetch shows the field filled", async () => {
    const filled = rawIssue("PROJ-1", { team: "Install", component: "Catalog" });
    const client = new FakeJiraClient({ issues: { "PROJ-1": [filled] } });
    const result = await gateway(client).fillMissing("PROJ-1", "team", "Platform", false);
    expect(result).toMatchObject({ status: "skipped", reason: "already-set" });
    expect(client.updates).toEqual([]);
  });

  it("update-path re-fetch skips a field filled after the first check", async () => {
    const first = rawIssue("PROJ-1");
    const second = rawIssue("PROJ-1", { team: "Install" });
    const client = new FakeJiraClient({ issues: { "PROJ-1": [first, second] } });
    const result = await gateway(client).fillMissing("PROJ-1", "team", "Platform", false);
    expect(result.status).toBe("skipped-race");
    expect(client.updates).toEqual([]);
  });

  it("the second update-path fetch also skips races", async () => {
    const first = rawIssue("PROJ-1");
    const second = rawIssue("PROJ-1");
    const third = rawIssue("PROJ-1", { team: "Install" });
    const client = new FakeJiraClient({ issues: { "PROJ-1": [first, second, third] } });
    const result = await gateway(client).fillMissing("PROJ-1", "team", "Platform", false);
    expect(result.status).toBe("skipped-race");
    expect(client.updates).toEqual([]);
  });

  it("validates both update-path fetches: a malformed one is an error, not a write", async () => {
    for (const operation of ["fill", "correct"] as const) {
      for (const badStage of [1, 2]) {
        const team = operation === "fill" ? null : "Install";
        const raw = rawIssue("PROJ-1", { team, component: "Catalog" });
        const malformed = rawIssue("PROJ-1", { team, component: "Catalog" });
        delete malformed.fields.description;
        const client = new FakeJiraClient({
          issues: { "PROJ-1": [...Array.from({ length: badStage }, () => raw), malformed] },
        });
        const g = gateway(client);
        const result =
          operation === "fill"
            ? await g.fillMissing("PROJ-1", "team", "Platform", false)
            : await g.correctUnchanged(normalizeIssue(raw), "team", "Platform", false);
        expect(result.status).toBe("error");
        expect(result.reason).toMatch(/omitted/);
        expect(client.updates).toEqual([]);
      }
    }
  });

  it("correctUnchanged compares the raw snapshot, not the canonicalized one", async () => {
    const raw = rawIssue("PROJ-1", { team: "Platform", component: "ArgoCD Plugin" });
    const changed = rawIssue("PROJ-1", { team: "Platform", component: "ArgoCD" });
    const client = new FakeJiraClient({ issues: { "PROJ-1": [changed] } });
    const result = await gateway(client).correctUnchanged(
      normalizeIssue(raw),
      "component",
      "Catalog",
      false,
    );
    expect(result).toMatchObject({ status: "skipped-race", reason: "changed-since-search" });
    expect(client.updates).toEqual([]);
  });

  it("unknown team targets abstain", async () => {
    const client = new FakeJiraClient({ issues: { "PROJ-1": [rawIssue()] } });
    const result = await gateway(client).fillMissing("PROJ-1", "team", "Not A Team", false);
    expect(result).toMatchObject({ status: "abstained", reason: "unknown-team" });
    expect(client.updates).toEqual([]);
  });

  it("error reasons are redacted", async () => {
    registerSecrets("tok-xyz");
    const client = new FakeJiraClient({ issues: {} });
    const result = await gateway(client).fillMissing("PROJ-1", "team", "Platform", false);
    expect(result.status).toBe("error");
  });

  it("component lookups cache per project and fail closed to null", async () => {
    const good = new FakeJiraClient({});
    const g = gateway(good);
    expect(await g.getProjectComponents("PROJECT")).toEqual([...LIVE_COMPONENTS].sort());
    expect(await g.getProjectComponents("PROJECT")).toEqual([...LIVE_COMPONENTS].sort());
    expect(good.searchCalls.length).toBe(0);
    expect(good.componentsCalls).toBe(1);

    const broken = new FakeJiraClient({ components: [{ bad: "shape" }] });
    expect(await gateway(broken).getProjectComponents("PROJECT")).toBe(null);
  });
});

describe("team UUID cross-check", () => {
  function conflictedGateway(): { g: JiraGateway; client: FakeJiraClient } {
    const client = new FakeJiraClient({
      searchResults: [rawIssue("PROJ-1", { team: { id: OTHER_UUID, name: "Platform" } })],
      issues: { "PROJ-1": [rawIssue()] },
    });
    return { g: gateway(client), client };
  }

  it("a conflicting observation abstains team writes for that team only", async () => {
    const { g, client } = conflictedGateway();
    await g.searchCandidates(100, EXAMPLE_JQL);
    const conflicted = await g.fillMissing("PROJ-1", "team", "Platform", false);
    expect(conflicted).toMatchObject({ status: "abstained", reason: "team-uuid-conflict" });
    expect(client.updates).toEqual([]);
    const unconflicted = await g.fillMissing("PROJ-1", "team", "Install", false);
    expect(unconflicted.status).toBe("written");
    expect(client.updates).toEqual([
      { key: "PROJ-1", fields: { [TEAM_FIELD]: TEAMS["Install"].id } },
    ]);
  });

  it("prefix/case-mangled team names still map to the catalog label", async () => {
    const client = new FakeJiraClient({
      searchResults: [rawIssue("PROJ-1", { team: { id: UUID, name: "  acme PLATFORM  " } })],
    });
    const tickets = await gateway(client, ["ACME "]).searchCandidates(100, EXAMPLE_JQL);
    expect(tickets[0].team).toBe("Platform");
  });

  it("an agreeing observation records no conflict", async () => {
    const client = new FakeJiraClient({
      searchResults: [rawIssue("PROJ-1", { team: { id: UUID, name: "AcMe PlAtFoRm" } })],
      issues: { "PROJ-1": [rawIssue()] },
    });
    const g = gateway(client);
    await g.searchCandidates(100, EXAMPLE_JQL);
    const result = await g.fillMissing("PROJ-1", "team", "Platform", false);
    expect(result.status).toBe("written");
  });
});

describe("gateway pipeline integration (triage through the real gateway)", () => {
  function ctx(g: JiraGateway, classifier: FakeClassifier) {
    return {
      teams: structuredClone(TEAMS),
      aliases: ALIASES,
      descriptions: DESCRIPTIONS,
      classifier,
      gateway: g,
      confidenceThreshold: 0.7,
      dryRun: false,
      descriptionMaxChars: 48000,
      assigneeRoute: true,
    };
  }

  it("a conflicted team abstains while the component still writes", async () => {
    const { triageTicket } = await import("../src/modes.ts");
    const client = new FakeJiraClient({
      searchResults: [rawIssue("PROJ-1", { team: { id: OTHER_UUID, name: "Platform" } })],
      issues: { "PROJ-1": [rawIssue()] },
    });
    const g = gateway(client);
    await g.searchCandidates(100, EXAMPLE_JQL); // records the UUID conflict from the search page
    const classifier = new FakeClassifier({
      team: choiceAnswer("Platform"),
      component: choiceAnswer("Catalog"),
    });
    const result = await triageTicket(makeTicket(), ctx(g, classifier));
    expect(result.writes[0]).toMatchObject({ status: "abstained", reason: "team-uuid-conflict" });
    expect(result.writes[1]).toMatchObject({ status: "written" });
    expect(client.updates).toEqual([
      { key: "PROJ-1", fields: { components: [{ name: "Catalog" }] } },
    ]);
  });
});
