import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEAM_FIELD, loadConfig, type Config } from "../src/config.ts";
import { JiraGateway } from "../src/gateway.ts";
import { normalizeIssue } from "../src/normalize.ts";
import { auditTicket, evaluate, triageTicket, type ModeContext } from "../src/modes.ts";
import {
  buildQuestions,
  buildState,
  cleanDescription,
  matchAssigneeTeam,
} from "../src/questions.ts";
import { registerSecrets, resetSecrets } from "../src/redact.ts";
import { summarize } from "../src/report.ts";
import { AuditHistory } from "../src/state.ts";
import {
  ALIASES,
  DESCRIPTIONS,
  FakeClassifier,
  FakeJiraClient,
  LIVE_COMPONENTS,
  TEAMS,
  choiceAnswer,
  makeTicket,
  rawIssue,
  type RawIssue,
  REQUIRED_YAML,
} from "./helpers.ts";

let workDir: string;
let oldCwd: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "triager-modes-"));
  oldCwd = process.cwd();
  process.chdir(workDir);
  resetSecrets();
});

afterEach(() => {
  if (oldCwd) {
    process.chdir(oldCwd);
  }
});

function gatewayFor(issues: Record<string, RawIssue[]> = {}): JiraGateway {
  return new JiraGateway(
    new FakeJiraClient({ issues, components: LIVE_COMPONENTS.map((name) => ({ name })) }),
    structuredClone(TEAMS),
  );
}

/** Gateway whose re-fetch queue mirrors the ticket's current fields. */
function seededGateway(ticket: ReturnType<typeof makeTicket>): JiraGateway {
  return gatewayFor({
    [ticket.key]: [
      rawIssue(ticket.key, {
        team: ticket.team === null ? null : { name: ticket.team },
        component: ticket.component,
      }),
    ],
  });
}

function ctx(
  gateway: JiraGateway,
  classifier: FakeClassifier,
  overrides: Partial<ModeContext> = {},
): ModeContext {
  return {
    teams: structuredClone(TEAMS),
    aliases: ALIASES,
    descriptions: DESCRIPTIONS,
    classifier,
    gateway,
    confidenceThreshold: 0.7,
    dryRun: true,
    descriptionMaxChars: 48000,
    assigneeRoute: true,
    ...overrides,
  };
}

function runTriage(
  ticket: ReturnType<typeof makeTicket>,
  classifier: FakeClassifier,
  gateway?: JiraGateway,
  overrides: Partial<ModeContext> = {},
) {
  return triageTicket(ticket, ctx(gateway ?? seededGateway(ticket), classifier, overrides));
}

describe("triageTicket", () => {
  it("skips tickets with both fields set, without a model call", async () => {
    const classifier = new FakeClassifier();
    const result = await runTriage(
      makeTicket({ team: "Platform", component: "Catalog" }),
      classifier,
      gatewayFor(),
    );
    expect(result.outcome).toBe("skipped");
    expect(classifier.calls).toEqual([]);
  });

  it("assignee pre-route assigns without a model call", async () => {
    const classifier = new FakeClassifier();
    const result = await runTriage(
      makeTicket({ component: "Catalog", assignee: "  alex ash  " }),
      classifier,
    );
    expect(result.outcome).toBe("assigned");
    expect(classifier.calls).toEqual([]);
    expect(result.decisions[0]).toMatchObject({
      field: "team",
      action: "assigned",
      source: "assignee-route",
      value: "Platform",
      confidence: 1.0,
    });
    expect(result.writes[0]).toMatchObject({ status: "dry-run" });
  });

  it("route disabled or unmatched assignee asks the model", async () => {
    const asked = new FakeClassifier({ team: choiceAnswer("Install") });
    await runTriage(
      makeTicket({ component: "Catalog", assignee: "Alex Ash" }),
      asked,
      gatewayFor(),
      { assigneeRoute: false },
    );
    expect(Object.keys(asked.calls[0].questions)).toEqual(["team"]);

    const unmatched = new FakeClassifier({ team: choiceAnswer("Platform") });
    await runTriage(
      makeTicket({ component: "Catalog", assignee: "Nobody Here" }),
      unmatched,
      gatewayFor(),
    );
    expect(unmatched.calls[0].state).toMatchObject({ assignee: "Nobody Here", assignee_team: "" });
  });

  it("confidence gate: below abstains, at the threshold writes", async () => {
    const low = new FakeClassifier({ team: choiceAnswer("Platform", 0.5) });
    const result = await runTriage(makeTicket({ component: "Catalog" }), low, gatewayFor());
    expect(result.outcome).toBe("abstained");
    expect(result.decisions[0]).toMatchObject({
      action: "abstained",
      reason: "low-confidence",
      confidence: 0.5,
    });

    const at = new FakeClassifier({ team: choiceAnswer("Platform", 0.7) });
    const ok = await runTriage(makeTicket({ component: "Catalog" }), at, gatewayFor());
    expect(ok.decisions[0]).toMatchObject({ action: "assigned", value: "Platform" });
  });

  it("malformed answers abstain with precise reasons", async () => {
    for (const [answers, reason] of [
      [{}, "missing-answer"],
      [{ team: { type: "score", score: 1, confidence: 0.9 } }, "malformed-answer"],
      [{ team: choiceAnswer("Not A Team") }, "invalid-choice"],
      [{ team: { type: "choice", choice: "Platform", probabilities: {} } }, "invalid-confidence"],
    ] as const) {
      const classifier = new FakeClassifier(answers as never);
      const result = await runTriage(
        makeTicket({ component: "Catalog" }),
        classifier,
        gatewayFor(),
      );
      expect(result.decisions[0].reason).toBe(reason);
      expect(result.outcome).toBe("abstained");
    }
  });

  it("classifier failure abstains every asked field and suppresses the pre-route", async () => {
    const classifier = new FakeClassifier({}, { exc: new Error("connection refused") });
    const result = await runTriage(makeTicket({ assignee: "Alex Ash" }), classifier, gatewayFor(), {
      dryRun: false,
    });
    expect(result.outcome).toBe("abstained");
    const reasons = Object.fromEntries(result.decisions.map((d) => [d.field, d.reason]));
    expect(reasons).toEqual({ team: "classify-failed", component: "classify-failed" });
    expect(result.writes).toEqual([]);
  });

  it("component predictions are canonicalized and validated against the live list", async () => {
    const canonical = new FakeClassifier({ component: choiceAnswer("ArgoCD Plugin") });
    const result = await runTriage(makeTicket({ team: "Platform" }), canonical, gatewayFor());
    expect(result.decisions[0]).toMatchObject({ action: "assigned", value: "ArgoCD" });
    expect(result.writes[0]).toMatchObject({ value: "ArgoCD" });

    const notLive = new FakeClassifier({ component: choiceAnswer("Quay Plugin") });
    const gateway = new JiraGateway(
      new FakeJiraClient({ components: ["Quay Plugin", "Catalog"].map((name) => ({ name })) }),
      structuredClone(TEAMS),
    );
    const abstained = await runTriage(makeTicket({ team: "Platform" }), notLive, gateway);
    expect(abstained.decisions[0]).toMatchObject({
      action: "abstained",
      reason: "unknown-component",
    });

    const outside = new FakeClassifier({ component: choiceAnswer("Kafka") });
    const invalid = await runTriage(makeTicket({ team: "Platform" }), outside, gatewayFor());
    expect(invalid.decisions[0].reason).toBe("invalid-choice");
  });

  it("component lookup failure abstains and omits the question", async () => {
    const classifier = new FakeClassifier({ team: choiceAnswer("Platform") });
    const gateway = new JiraGateway(
      new FakeJiraClient({ components: null }),
      structuredClone(TEAMS),
    );
    const result = await runTriage(makeTicket(), classifier, gateway);
    const decisions = Object.fromEntries(result.decisions.map((d) => [d.field, d]));
    expect(decisions.component).toMatchObject({ reason: "component-lookup-failed" });
    expect(Object.keys(classifier.calls[0].questions)).toEqual(["team"]);
    expect(classifier.calls[0].state).toMatchObject({ allowed_components: [] });
  });

  it("live writes use the team UUID and component name; only missing fields write", async () => {
    const client = new FakeJiraClient({ issues: { "PROJ-1": [rawIssue()] } });
    const gateway = new JiraGateway(client, structuredClone(TEAMS));
    const classifier = new FakeClassifier({
      team: choiceAnswer("Platform"),
      component: choiceAnswer("Catalog"),
    });
    const result = await runTriage(makeTicket(), classifier, gateway, { dryRun: false });
    expect(result.outcome).toBe("assigned");
    expect(client.updates).toEqual([
      { key: "PROJ-1", fields: { [TEAM_FIELD]: "11111111-2222-3333-4444-555555555555" } },
      { key: "PROJ-1", fields: { components: [{ name: "Catalog" }] } },
    ]);
    expect(result.writes.map((write) => write.status)).toEqual(["written", "written"]);
  });

  it("a failed update marks the ticket errored per field", async () => {
    const raw = rawIssue();
    const broken = new FakeJiraClient({ issues: { "PROJ-1": [raw] } });
    broken.failUpdateOn = "components"; // the component PUT fails, the team PUT succeeds
    const classifier = new FakeClassifier({
      team: choiceAnswer("Platform"),
      component: choiceAnswer("Catalog"),
    });
    const result = await runTriage(
      makeTicket(),
      classifier,
      new JiraGateway(broken, structuredClone(TEAMS)),
      { dryRun: false },
    );
    expect(result.outcome).toBe("error");
    const statuses = Object.fromEntries(result.writes.map((write) => [write.field, write.status]));
    expect(statuses).toEqual({ team: "written", component: "error" });
  });

  it("state and questions shapes match the documented prompt contract", async () => {
    const classifier = new FakeClassifier({
      team: choiceAnswer("Platform"),
      component: choiceAnswer("Catalog"),
    });
    await runTriage(
      makeTicket({
        assignee: "Chris Chen",
        description: "{noformat}raw text{noformat}\r\nline2",
      }),
      classifier,
      gatewayFor(),
      { assigneeRoute: false },
    );
    const { state } = classifier.calls[0] as { state: Record<string, unknown> };
    expect(state.key).toBe("PROJ-1");
    expect(state.title).toBe("Catalog import fails");
    expect(state.cleaned_description).toBe("raw text\nline2");
    expect(state.existing_team).toBe("");
    expect(state.existing_component).toBe("");
    expect(state.assignee).toBe("Chris Chen");
    expect(state.assignee_team).toBe("Install");
    expect(state.allowed_components).toEqual(LIVE_COMPONENTS);

    const [{ questions }] = classifier.calls;
    expect(questions.team.type).toBe("choice");
    expect(questions.team.criteria).toMatchObject({
      Platform: "Frequently works on: Catalog, Build",
    });
    expect(questions.component.type).toBe("choice");
    expect(questions.component.criteria).toMatchObject({
      Catalog: "Backstage software catalog",
      "ArgoCD Plugin": "ArgoCD plugin integration",
      "Helm Chart": "Helm chart for deployment",
    });
  });
});

describe("question building and helpers", () => {
  it("omits unneeded fields; prefixes team descriptions", () => {
    expect(buildQuestions(false, false, TEAMS, LIVE_COMPONENTS, DESCRIPTIONS, ALIASES)).toEqual({});
    const onlyComponent = buildQuestions(false, true, TEAMS, ["Catalog"], DESCRIPTIONS, ALIASES);
    expect(Object.keys(onlyComponent)).toEqual(["component"]);

    const teams = {
      Platform: { ...TEAMS["Platform"], description: "Pipelines: ships release builds." },
    };
    const withDescription = buildQuestions(
      true,
      false,
      teams,
      LIVE_COMPONENTS,
      DESCRIPTIONS,
      ALIASES,
    );
    expect((withDescription.team.criteria as Record<string, string>)["Platform"]).toBe(
      "Pipelines: ships release builds. Frequently works on: Catalog, Build",
    );
  });

  it("cleanDescription and matchAssigneeTeam", () => {
    expect(cleanDescription("{noformat}a\r\nb{noformat}\n")).toBe("a\nb");
    expect(cleanDescription(null)).toBe("");
    expect(matchAssigneeTeam("  ALEX ASH ", TEAMS)).toBe("Platform");
    expect(matchAssigneeTeam("Chris Chen", TEAMS)).toBe("Install");
    expect(matchAssigneeTeam("Unknown Person", TEAMS)).toBe(null);
    expect(matchAssigneeTeam(null, TEAMS)).toBe(null);
  });

  it("truncates descriptions at the cap with a word boundary", () => {
    const long = "word ".repeat(300);
    const state = buildState(makeTicket({ description: long }), null, null, 500);
    expect(state.cleaned_description.length).toBeLessThanOrEqual(500);
    expect(state.description_truncated).toBeTruthy();
    const hard = buildState(makeTicket({ description: "x".repeat(600) }), null, null, 500);
    expect(hard.cleaned_description.length).toBe(500);
    const short = buildState(makeTicket({ description: "short" }), null, null, 500);
    expect(short.cleaned_description).toBe("short");
    expect("description_truncated" in short).toBeFalsy();
  });
});

describe("auditTicket", () => {
  function auditSetup(
    opts: { team?: string; component?: string; confidence?: number; exc?: Error } = {},
  ) {
    const raw = rawIssue("PROJ-1", {
      team: opts.team ?? "Install",
      component: opts.component ?? "Catalog",
    });
    const client = new FakeJiraClient({ issues: { "PROJ-1": [raw] } });
    const classifier = new FakeClassifier(
      {
        team: choiceAnswer("Platform", opts.confidence ?? 0.9),
        component: choiceAnswer("Catalog", opts.confidence ?? 0.9),
      },
      { exc: opts.exc },
    );
    return { raw, client, classifier };
  }

  it("corrected / uncertain / ok / classify-failed decision matrix", async () => {
    for (const [setup, expected] of [
      [{}, "corrected"],
      [{ confidence: 0.6 }, "uncertain"],
      [{ team: "Platform" }, "ok"],
      [{ exc: new Error("classifier down") }, "classify-failed"],
    ] as const) {
      const { raw, client, classifier } = auditSetup(setup);
      const result = await auditTicket(
        normalizeIssue(raw),
        ctx(new JiraGateway(client, structuredClone(TEAMS)), classifier, { dryRun: false }),
        new Date(),
      );
      expect(result.outcome).toBe(expected);
      const asked = classifier.exc ? [] : Object.keys(classifier.calls[0]?.questions ?? {});
      expect(asked).toEqual(setup.exc ? [] : ["team", "component"]);
      expect(client.updates).toEqual(
        expected === "corrected"
          ? [
              {
                key: "PROJ-1",
                fields: { [TEAM_FIELD]: "11111111-2222-3333-4444-555555555555" },
              },
            ]
          : [],
      );
    }
  });

  it("alias-agreeing components are ok", async () => {
    const raw = rawIssue("PROJ-1", { team: "Platform", component: "ArgoCD Plugin" });
    const client = new FakeJiraClient({ issues: { "PROJ-1": [raw] } });
    const classifier = new FakeClassifier({
      team: choiceAnswer("Platform"),
      component: choiceAnswer("ArgoCD"),
    });
    const result = await auditTicket(
      normalizeIssue(raw),
      ctx(new JiraGateway(client, structuredClone(TEAMS)), classifier, { dryRun: false }),
      new Date(),
    );
    expect(result.outcome).toBe("ok");
    expect(result.writes).toEqual([]);
  });

  it("concurrent changes stay uncertain at every race stage", async () => {
    for (const raceStage of [0, 1, 2]) {
      const raw = rawIssue("PROJ-1", { team: "Install", component: "Catalog" });
      const changed = rawIssue("PROJ-1", { team: "Human Team", component: "Catalog" });
      const queue = [...Array.from({ length: raceStage }, () => raw), changed];
      const client = new FakeJiraClient({ issues: { "PROJ-1": queue } });
      const classifier = new FakeClassifier({
        team: choiceAnswer("Platform"),
        component: choiceAnswer("Catalog"),
      });
      const result = await auditTicket(
        normalizeIssue(raw),
        ctx(new JiraGateway(client, structuredClone(TEAMS)), classifier, { dryRun: false }),
        new Date(),
      );
      expect(result.outcome).toBe("uncertain");
      expect(client.updates).toEqual([]);
    }
  });

  it("one invalid or low-confidence field suppresses the other's correction", async () => {
    const raw = rawIssue("PROJ-1", { team: "Install", component: "Catalog" });
    for (const answers of [
      { team: choiceAnswer("not-allowed"), component: choiceAnswer("ArgoCD") },
      { team: choiceAnswer("Platform", 0.6), component: choiceAnswer("ArgoCD") },
    ]) {
      const client = new FakeJiraClient({ issues: { "PROJ-1": [raw] } });
      const classifier = new FakeClassifier(answers);
      const result = await auditTicket(
        normalizeIssue(raw),
        ctx(new JiraGateway(client, structuredClone(TEAMS)), classifier, { dryRun: false }),
        new Date(),
      );
      expect(result.outcome).toBe("uncertain");
      expect(result.writes).toEqual([]);
      expect(client.updates).toEqual([]);
    }
  });

  it("mixed confidence: only the high-confidence field corrects", async () => {
    const raw = rawIssue("PROJ-1", { team: "Install", component: "Catalog" });
    const client = new FakeJiraClient({ issues: { "PROJ-1": [raw] } });
    const classifier = new FakeClassifier({
      team: choiceAnswer("Platform", 0.9),
      component: choiceAnswer("Catalog", 0.6), // agrees, below threshold
    });
    const result = await auditTicket(
      normalizeIssue(raw),
      ctx(new JiraGateway(client, structuredClone(TEAMS)), classifier, { dryRun: false }),
      new Date(),
    );
    expect(result.outcome).toBe("corrected");
    expect(result.writes.map((write) => write.field)).toEqual(["team"]);
    const lowDecision = result.decisions.find((decision) => decision.field === "component");
    expect(lowDecision).toMatchObject({ action: "abstained", reason: "low-confidence" });
  });

  it("deduplicates identical re-audits and expires after the window", async () => {
    const { raw, client, classifier } = auditSetup();
    const ticket = normalizeIssue(raw);
    const now = new Date("2026-01-15T12:00:00Z");
    const gateway = new JiraGateway(client, structuredClone(TEAMS));
    const history = new AuditHistory(join(workDir, "state.json"), 30);
    const base = ctx(gateway, classifier, { dryRun: false, history });
    const first = await auditTicket(ticket, base, now);
    history.record(ticket, first, now);

    const assigned = { ...ticket, team: "Platform" };
    const again = await auditTicket(assigned, base, now);
    expect(again).toMatchObject({ deduplicated: true, outcome: "ok" });

    const changed = await auditTicket(ticket, base, now);
    expect(changed.outcome).toBe("corrected");
    expect(changed.deduplicated).toBeUndefined();

    const expired = await auditTicket(assigned, base, new Date(now.getTime() + 31 * 86_400_000));
    expect(expired.deduplicated).toBeUndefined();
  });
});

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

function catalogConfig(): Config {
  const yamlText = [
    REQUIRED_YAML,
    "files:",
    `  teams: ${JSON.stringify(join(workDir, "teams.json")).replaceAll("\\", "/")}`,
    `  components: ${JSON.stringify(join(workDir, "components.json")).replaceAll("\\", "/")}`,
  ].join("\n");
  return loadConfig({}, { yamlText });
}

describe("evaluate", () => {
  it("replays the fixture corpus with agreement math and no Jira", async () => {
    writeCatalogs();
    const config = catalogConfig();
    config.mode = "eval";
    config.corpus = join(import.meta.dirname, "fixtures", "eval-corpus.json");
    const classifier = new FakeClassifier({
      team: choiceAnswer("Platform"),
      component: choiceAnswer("Catalog"),
    });
    const summary = await evaluate(config, classifier);
    expect(summary.metrics).toMatchObject({
      agreement_rate: { team: 0.5, component: 0.5 },
      overall_agreement_rate: 0.5,
      would_write_count: 2,
      would_write_ticket_count: 1,
    });
    const metrics = summary.metrics as {
      confusion: Record<string, Record<string, Record<string, number>>>;
      confidence_distribution: { count: number };
    };
    expect(metrics.confusion.team["Install"]).toEqual({ Platform: 1 });
    expect(metrics.confidence_distribution.count).toBe(4);
    const reportText = readFileSync(summary.report ?? "", "utf-8");
    expect(reportText).toContain('"mode": "eval"');

    config.sample = 1;
    const sampled = await evaluate(config, classifier);
    expect((sampled.metrics as { overall_agreement_rate: number }).overall_agreement_rate).toBe(
      1.0,
    );
  });

  it("classifier failures count against agreement and land in confusion", async () => {
    writeCatalogs();
    const config = catalogConfig();
    config.mode = "eval";
    config.corpus = join(import.meta.dirname, "fixtures", "eval-corpus.json");
    const summary = await evaluate(config, new FakeClassifier({}, { exc: new Error("offline") }));
    expect(summary.counts["classify-failed"]).toBe(2);
    const metrics = summary.metrics as {
      overall_agreement_rate: number;
      confusion: Record<string, Record<string, Record<string, number>>>;
      would_write_ticket_count: number;
    };
    expect(metrics.overall_agreement_rate).toBe(0);
    expect(metrics.confusion.component.Catalog).toEqual({ "<classify-failed>": 1 });
    expect(metrics.would_write_ticket_count).toBe(0);
  });
});

describe("summarize", () => {
  it("counts outcomes and write errors", () => {
    const summary = summarize([
      {
        key: "A",
        outcome: "assigned",
        decisions: [],
        writes: [{ key: "A", field: "team", value: "x", status: "written" }],
      },
      {
        key: "B",
        outcome: "error",
        decisions: [],
        writes: [{ key: "B", field: "team", value: "x", status: "error" }],
      },
    ]);
    expect(summary.counts).toMatchObject({ assigned: 1, error: 1 });
    expect(summary.writeErrors).toBe(1);
    expect(summary.keys.assigned).toEqual(["A"]);
  });
});

describe("redaction through the pipeline", () => {
  it("logs and reports never contain registered secrets", async () => {
    registerSecrets("registered-secret-review");
    const raw = rawIssue("registered-secret-review");
    const client = new FakeJiraClient({ issues: { "registered-secret-review": [raw] } });
    const classifier = new FakeClassifier(
      {},
      { exc: new Error("failed registered-secret-review") },
    );
    const gateway = new JiraGateway(client, structuredClone(TEAMS));

    const chunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      const result = await triageTicket(normalizeIssue(raw), ctx(gateway, classifier));
      const { writeReport } = await import("../src/report.ts");
      const config = loadConfig({}, { yamlText: REQUIRED_YAML });
      config.reportFile = join(workDir, "report.json");
      const path = writeReport(config, [result], summarize([result]));
      const logged = chunks.join("");
      expect(logged).not.toContain("registered-secret-review");
      expect(logged).toContain("[REDACTED]");
      const reportText = readFileSync(path, "utf-8");
      expect(reportText).not.toContain("registered-secret-review");
      expect(reportText).toContain("[REDACTED]");
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});
