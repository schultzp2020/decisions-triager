import { existsSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.ts";
import { run } from "../src/run.ts";
import { registerSecrets, resetSecrets } from "../src/redact.ts";
import {
  ALIASES,
  DESCRIPTIONS,
  FakeClassifier,
  FakeJiraClient,
  TEAMS,
  choiceAnswer,
  rawIssue,
  REQUIRED_YAML,
} from "./helpers.ts";

let workDir: string;
let oldCwd: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "triager-run-"));
  oldCwd = process.cwd();
  process.chdir(workDir);
  resetSecrets();
});

afterEach(() => {
  if (oldCwd) {
    process.chdir(oldCwd);
  }
});

interface RunReport {
  mode: string;
  counts: Record<string, number>;
  tickets: {
    fields: {
      old: string | null;
      new: string | null;
      confidence: number | null;
      probabilities: unknown;
    }[];
    writes: { status: string; reason?: string }[];
  }[];
}

function readState(path: string): Record<string, { decision: string }> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, { decision: string }>;
}

function readReport(path: string | undefined): RunReport {
  if (!path) {
    throw new Error("no report path in summary");
  }
  return JSON.parse(readFileSync(path, "utf-8")) as RunReport;
}

function writeCatalogs(): void {
  const components: Record<string, { description: string; aliases: string[] }> = {};
  for (const [canonical, description] of Object.entries({
    ...DESCRIPTIONS,
    Quay: "Quay container registry",
  })) {
    components[canonical] = { description, aliases: [] };
  }
  for (const [alias, canonical] of Object.entries(ALIASES)) {
    components[canonical] ??= { description: "No description available.", aliases: [] };
    components[canonical].aliases.push(alias);
  }
  writeFileSync(join(workDir, "teams.json"), JSON.stringify(TEAMS), "utf-8");
  writeFileSync(join(workDir, "components.json"), JSON.stringify(components), "utf-8");
}

function baseConfig(mode: Config["mode"] = "triage"): Config {
  const yamlText = [
    REQUIRED_YAML,
    `mode: ${mode}`,
    "dry_run: false",
    `files:`,
    `  teams: ${JSON.stringify(join(workDir, "teams.json")).replaceAll("\\", "/")}`,
    `  components: ${JSON.stringify(join(workDir, "components.json")).replaceAll("\\", "/")}`,
    `audit:\n  state_file: ${JSON.stringify(join(workDir, "state.json")).replaceAll("\\", "/")}`,
    `report_file: ${JSON.stringify(join(workDir, "report.json")).replaceAll("\\", "/")}`,
  ].join("\n");
  return loadConfig({ JIRA_API_TOKEN: "user@example.com:test-token" }, { yamlText });
}

function auditFixture() {
  const raw = rawIssue("PROJ-1", { team: "Install", component: "Catalog" });
  const client = new FakeJiraClient({ issues: { "PROJ-1": [raw] }, searchResults: [raw] });
  const classifier = new FakeClassifier({
    team: choiceAnswer("Platform"),
    component: choiceAnswer("Catalog"),
  });
  return { raw, client, classifier };
}

describe("run", () => {
  it("triage mode writes the report and never touches audit state", async () => {
    writeCatalogs();
    const config = baseConfig("triage");
    const raw = rawIssue("PROJ-1", { component: "Catalog" });
    const client = new FakeJiraClient({ issues: { "PROJ-1": [raw] }, searchResults: [raw] });
    const classifier = new FakeClassifier({ team: choiceAnswer("Platform") });
    const summary = await run(config, { jiraClient: client, classifier });
    expect(summary.counts.assigned).toBe(1);
    const report = readReport(summary.report);
    expect(report.mode).toBe("triage");
    expect(report.counts.assigned).toBe(1);
    const [field] = report.tickets[0].fields;
    expect(field).toMatchObject({ old: null, new: "Platform" });
    expect(existsSync(config.stateFile)).toBeFalsy();
    expect(existsSync(join("reports"))).toBeTruthy();
  });

  it("audit mode uses the audit JQL, records state, and reports corrections", async () => {
    writeCatalogs();
    const config = baseConfig("audit");
    const { client, classifier } = auditFixture();
    const summary = await run(config, { jiraClient: client, classifier });
    expect(summary.counts.corrected).toBe(1);
    expect(client.searchCalls[0].jql).toBe(config.auditJql);
    const report = readReport(summary.report);
    expect(report.mode).toBe("audit");
    const [field] = report.tickets[0].fields;
    expect(field).toMatchObject({ old: "Install", new: "Platform", confidence: 0.9 });
    expect(field.probabilities).toEqual([["Platform", 0.9]]);
    const state = readState(config.stateFile);
    expect(state["PROJ-1"].decision).toBe("corrected");
  });

  it("dry-run audit reports corrected but records no corrected state", async () => {
    writeCatalogs();
    const config = baseConfig("audit");
    config.dryRun = true;
    const { client, classifier } = auditFixture();
    const summary = await run(config, { jiraClient: client, classifier });
    expect(summary.counts.corrected).toBe(1);
    expect(client.updates).toEqual([]);
    expect(readState(config.stateFile)).toEqual({});
    const report = readReport(summary.report);
    expect(report.tickets[0].writes[0]?.status).toBe("dry-run");
  });

  it("corrupt audit state aborts the audit run before any Jira call", async () => {
    writeCatalogs();
    const config = baseConfig("audit");
    writeFileSync(config.stateFile, "{broken", "utf-8");
    await expect(
      run(config, {
        jiraClient: {
          searchJql: () => Promise.reject(new Error("Jira contacted")),
          issue: () => Promise.reject(new Error("Jira contacted")),
          updateIssue: () => Promise.reject(new Error("Jira contacted")),
          projectComponents: () => Promise.reject(new Error("Jira contacted")),
        },
        classifier: new FakeClassifier(),
      }),
    ).rejects.toThrow(/unreadable\/corrupt/);
  });

  it("triage mode is unaffected by corrupt audit state (audit owns it)", async () => {
    writeCatalogs();
    const config = baseConfig("triage");
    writeFileSync(config.stateFile, "{broken", "utf-8");
    const raw = rawIssue("PROJ-1", { component: "Catalog" });
    const client = new FakeJiraClient({ issues: { "PROJ-1": [raw] }, searchResults: [raw] });
    const summary = await run(config, {
      jiraClient: client,
      classifier: new FakeClassifier({ team: choiceAnswer("Platform") }),
    });
    expect(summary.counts.assigned).toBe(1);
  });

  it("one bad ticket never kills the run", async () => {
    writeCatalogs();
    const config = baseConfig("triage");
    const good = rawIssue("PROJ-2", { component: "Catalog" });
    const client = new FakeJiraClient({
      issues: { "PROJ-1": [], "PROJ-2": [good] },
      searchResults: [rawIssue("PROJ-1", { component: "Catalog" }), good],
    });
    // PROJ-1's issue queue is empty: its re-fetch rejects -> per-ticket error
    const summary = await run(config, {
      jiraClient: client,
      classifier: new FakeClassifier({ team: choiceAnswer("Platform") }),
    });
    expect(summary.counts.error).toBe(1);
    expect(summary.counts.assigned).toBe(1);
  });

  it("an audit write failure stays uncertain and is not recorded as success", async () => {
    writeCatalogs();
    const config = baseConfig("audit");
    const { client, classifier } = auditFixture();
    client.failUpdateOn = "customfield";
    const summary = await run(config, { jiraClient: client, classifier });
    expect(summary.counts.uncertain).toBe(1);
    expect(summary.writeErrors).toBe(1);
    const state = readState(config.stateFile);
    expect(state["PROJ-1"].decision).toBe("uncertain");
    const report = readReport(summary.report);
    expect(report.tickets[0].writes[0]?.status).toBe("error");
  });

  it("eval mode never constructs a Jira client", async () => {
    writeCatalogs();
    const config = baseConfig("eval");
    config.corpus = join(import.meta.dirname, "fixtures", "eval-corpus.json");
    const summary = await run(config, {
      classifier: new FakeClassifier({
        team: choiceAnswer("Platform"),
        component: choiceAnswer("Catalog"),
      }),
    });
    expect(summary.metrics).toBeDefined();
    expect(existsSync(config.stateFile)).toBeFalsy();
  });

  it("a malformed component catalog aborts before any work", async () => {
    writeCatalogs();
    writeFileSync(
      join(workDir, "components.json"),
      JSON.stringify({ Catalog: { description: 3, aliases: [] } }),
      "utf-8",
    );
    const config = baseConfig("triage");
    await expect(
      run(config, { jiraClient: new FakeJiraClient(), classifier: new FakeClassifier() }),
    ).rejects.toThrow("component");
  });

  it("reports redact registered secrets", async () => {
    registerSecrets("report-secret-value");
    writeCatalogs();
    const config = baseConfig("triage");
    const { writeReport, summarize } = await import("../src/report.ts");
    const result = {
      key: "report-secret-value",
      outcome: "abstained" as const,
      decisions: [
        {
          field: "team" as const,
          action: "abstained" as const,
          old: "report-secret-value",
          confidence: null,
        },
      ],
      writes: [],
    };
    const path = writeReport(config, [result], summarize([result]));
    const text = readFileSync(path, "utf-8");
    expect(text).not.toContain("report-secret-value");
    expect(text).toContain("[REDACTED]");
  });
});
