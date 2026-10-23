// The three modes: triage (fill missing fields), audit (correct stale
// ones), eval (replay a labeled corpus, classifier only). Ticket-level
// orchestration lives here; field-level validity lives in ChoicePolicy.
import type { Answer, Classifier } from "./classifier.ts";
import type { Config } from "./config.ts";
import { loadJson, validateConfigFiles } from "./datafiles.ts";
import type { TeamCatalog } from "./datafiles.ts";
import type { JiraGateway } from "./gateway.ts";
import { log } from "./log.ts";
import type { Ticket } from "./normalize.ts";
import { isRecord } from "./normalize.ts";
import {
  buildQuestions,
  buildState,
  canonicalizeComponent,
  matchAssigneeTeam,
} from "./questions.ts";
import { ChoicePolicy } from "./policy.ts";
import { describeException, redact } from "./redact.ts";
import type { Decision, TicketResult } from "./records.ts";
import { logTicketResult, summarize, writeReport } from "./report.ts";
import type { AuditHistory } from "./state.ts";

/** Everything a mode needs beyond the ticket: catalogs, the classifier
 * seam, the guarded-write gateway, and the policy knobs from Config. */
export interface ModeContext {
  teams: TeamCatalog;
  aliases: Record<string, string>;
  descriptions: Record<string, string>;
  classifier: Classifier;
  gateway: JiraGateway;
  confidenceThreshold: number;
  dryRun: boolean;
  descriptionMaxChars: number;
  /** triage only: deterministic assignee→team pre-route. */
  assigneeRoute: boolean;
  /** audit only. */
  history?: AuditHistory;
}

export function triageTicket(ticket: Ticket, ctx: ModeContext): Promise<TicketResult> {
  return (async () => {
    const result: TicketResult = {
      key: ticket.key,
      outcome: "error",
      decisions: [],
      writes: [],
    };
    const missingTeam = ticket.team === null;
    const missingComponent = ticket.component === null;

    if (!missingTeam && !missingComponent) {
      result.outcome = "skipped";
      return result;
    }

    // Deterministic pre-route: the assignee is a known team member.
    const assigneeTeam = matchAssigneeTeam(ticket.assignee, ctx.teams);
    const teamPreRouted = missingTeam && ctx.assigneeRoute && assigneeTeam !== null;

    const needTeam = missingTeam && !teamPreRouted;
    let needComponent = missingComponent;

    let liveComponents: string[] | null = null;
    if (needTeam || needComponent) {
      liveComponents = await ctx.gateway.getProjectComponents(ticket.projectKey);
    }

    // A missing component needs the live project list for question choices and
    // write validation; without it we abstain rather than write blind.
    if (needComponent) {
      if (liveComponents === null) {
        result.decisions.push({
          field: "component",
          action: "abstained",
          reason: "component-lookup-failed",
        });
        needComponent = false;
      } else if (liveComponents.length === 0) {
        result.decisions.push({
          field: "component",
          action: "abstained",
          reason: "no-components-in-project",
        });
        needComponent = false;
      }
    }

    const questions = buildQuestions(
      needTeam,
      needComponent,
      ctx.teams,
      liveComponents ?? [],
      ctx.descriptions,
      ctx.aliases,
    );

    let answers: Record<string, Answer> = {};
    let classifyFailed = false;
    if (Object.keys(questions).length > 0) {
      const state = buildState(ticket, liveComponents, assigneeTeam, ctx.descriptionMaxChars);
      try {
        answers = await ctx.classifier.classify(state, questions);
      } catch (error) {
        classifyFailed = true;
        log.warn(`classify failed for ${redact(ticket.key)}: ${describeException(error)}`);
        answers = {};
      }
    }

    if (classifyFailed) {
      // A failed classification suppresses every write for this ticket,
      // including the deterministic assignee pre-route.
      const failedFields = Object.keys(questions);
      if (teamPreRouted && !failedFields.includes("team")) {
        failedFields.unshift("team");
      }
      for (const field of failedFields) {
        result.decisions.push({
          field: field as "team" | "component",
          action: "abstained",
          reason: "classify-failed",
        });
      }
      result.outcome = "abstained";
      return result;
    }

    const policy = new ChoicePolicy(ctx.aliases, ctx.confidenceThreshold);
    if (teamPreRouted && assigneeTeam) {
      result.decisions.push({
        field: "team",
        action: "assigned",
        source: "assignee-route",
        value: assigneeTeam,
        confidence: 1.0,
      });
    } else if (needTeam) {
      result.decisions.push(
        policy.assess("team", answers.team, Object.keys(ctx.teams), ticket.team).decision("team"),
      );
    }

    if (needComponent && liveComponents) {
      result.decisions.push(
        policy
          .assess("component", answers.component, liveComponents, ticket.component)
          .decision("component"),
      );
    }

    for (const decision of result.decisions) {
      if (decision.action !== "assigned" || typeof decision.value !== "string") {
        continue;
      }
      const write = await ctx.gateway.fillMissing(
        ticket.key,
        decision.field,
        decision.value,
        ctx.dryRun,
      );
      decision.write = write.status;
      if (write.status === "abstained") {
        decision.action = "abstained";
        decision.reason = write.reason ?? null;
      }
      result.writes.push(write);
    }

    if (result.writes.some((write) => write.status === "error")) {
      result.outcome = "error";
    } else if (result.decisions.some((decision) => decision.action === "assigned")) {
      result.outcome = "assigned";
    } else {
      result.outcome = "abstained";
    }
    return result;
  })();
}

export async function auditTicket(
  ticket: Ticket,
  ctx: ModeContext,
  now: Date,
): Promise<TicketResult> {
  /** Ask both questions; correct only validated high-confidence mismatches. */
  const result: TicketResult = {
    key: ticket.key,
    outcome: "uncertain",
    decisions: [],
    writes: [],
  };
  const live = await ctx.gateway.getProjectComponents(ticket.projectKey);
  if (!live) {
    result.reason = "component-lookup-failed";
    return result;
  }
  const questions = buildQuestions(true, true, ctx.teams, live, ctx.descriptions, ctx.aliases);
  let answers: Record<string, Answer>;
  try {
    answers = await ctx.classifier.classify(
      buildState(ticket, live, null, ctx.descriptionMaxChars),
      questions,
    );
  } catch (error) {
    result.outcome = "classify-failed";
    result.reason = describeException(error);
    return result;
  }
  const choices: { team: string | null; component: string | null } = {
    team: null,
    component: null,
  };
  const mismatches: Decision[] = [];
  let invalid = false;
  const policy = new ChoicePolicy(ctx.aliases, ctx.confidenceThreshold);
  const answerRecord: Record<string, Answer> = isRecord(answers) ? answers : {};
  const fieldSpecs: ["team" | "component", string[]][] = [
    ["team", Object.keys(ctx.teams)],
    ["component", live],
  ];
  for (const [field, allowed] of fieldSpecs) {
    const answer = answerRecord[field];
    const assessment = policy.assess(field, answer, allowed, ticket[field]);
    const decision = assessment.decision(field);
    choices[field] = assessment.choice;
    decision.old = ticket[field];
    decision.new = assessment.choice;
    result.decisions.push(decision);
    if (assessment.validationReason !== null) {
      invalid = true;
    } else if (!assessment.agreement) {
      mismatches.push(decision);
    }
  }
  result.choice = choices;
  if (invalid) {
    return result;
  }
  if (ctx.history?.isDuplicate(ticket, choices, now)) {
    result.outcome = "ok";
    result.deduplicated = true;
    return result;
  }
  if (mismatches.length === 0) {
    result.outcome = "ok";
    return result;
  }
  // A malformed answer or low-confidence mismatch suppresses all corrections.
  if (mismatches.some((decision) => decision.action !== "assigned")) {
    return result;
  }
  for (const decision of mismatches) {
    if (typeof decision.new !== "string") {
      continue;
    }
    const write = await ctx.gateway.correctUnchanged(
      ticket,
      decision.field,
      decision.new,
      ctx.dryRun,
    );
    decision.write = write.status;
    if (write.status === "abstained") {
      decision.action = "abstained";
      decision.reason = write.reason ?? null;
    }
    result.writes.push(write);
  }
  if (result.writes.every((write) => write.status === "written" || write.status === "dry-run")) {
    result.outcome = "corrected";
  }
  return result;
}

/** Replay labeled export via classifier only: never construct/contact Jira. */
export async function evaluate(
  config: Config,
  classifier: Classifier,
): Promise<ReturnType<typeof summarize> & { report?: string }> {
  const { teams, aliases, descriptions } = validateConfigFiles(config);
  const corpus = loadJson(config.corpus ?? "");
  const required = ["key", "title", "description", "team", "component"];
  if (
    !Array.isArray(corpus) ||
    corpus.some(
      (row) =>
        !isRecord(row) ||
        !required.every((key) => key in row) ||
        !required.every(
          (key) =>
            typeof row[key] === "string" ||
            (["description", "team", "component"].includes(key) && row[key] === null),
        ),
    )
  ) {
    throw new Error("corpus must be an array of labeled export records");
  }
  const rows = config.sample === undefined ? corpus : corpus.slice(0, config.sample);
  const confusion: Record<string, Record<string, Record<string, number>>> = {
    team: {},
    component: {},
  };
  const confidence: number[] = [];
  const agree: Record<string, number> = { team: 0, component: 0 };
  const results: TicketResult[] = [];
  let wouldWrite = 0;
  let wouldWriteTickets = 0;
  const policy = new ChoicePolicy(aliases, config.confidenceThreshold);
  const componentLabels = Object.keys(descriptions);
  for (const row of rows as Record<string, unknown>[]) {
    let ticketWouldWrite = false;
    const ticket: Ticket = {
      key: row.key as string,
      title: row.title as string,
      description: (row.description as string | null) ?? "",
      team: row.team as string | null,
      component: row.component as string | null,
      assignee: null,
      projectKey: "PROJECT",
    };
    const result: TicketResult = {
      key: ticket.key,
      outcome: "ok",
      decisions: [],
      writes: [],
    };
    try {
      const questions = buildQuestions(true, true, teams, componentLabels, descriptions, aliases);
      const answers = await classifier.classify(
        buildState(ticket, componentLabels, null, config.descriptionMaxChars),
        questions,
      );
      if (!isRecord(answers)) {
        throw new Error("classify response missing answers object");
      }
      const answerRecord: Record<string, Answer> = answers;
      const fieldSpecs: ["team" | "component", string[]][] = [
        ["team", Object.keys(teams)],
        ["component", componentLabels],
      ];
      for (const [field, allowed] of fieldSpecs) {
        const assessment = policy.assess(
          field,
          answerRecord[field],
          allowed,
          row[field] as string | null,
        );
        const decision = assessment.decision(field);
        decision.old = row[field] as string | null;
        decision.new = assessment.choice;
        result.decisions.push(decision);
        const label =
          field === "component"
            ? canonicalizeComponent(row[field] as string | null, aliases)
            : (row[field] as string | null);
        const predicted = assessment.validationReason === null ? assessment.choice : "<invalid>";
        const counts = confusion[field];
        const bucket = (counts[label ?? "<empty>"] ??= {});
        bucket[predicted ?? "<invalid>"] = (bucket[predicted ?? "<invalid>"] ?? 0) + 1;
        if (assessment.validationReason === null && assessment.confidence !== null) {
          confidence.push(assessment.confidence);
        }
        if (assessment.agreement) {
          agree[field] += 1;
        } else {
          result.outcome = "uncertain";
          if (decision.action === "assigned") {
            wouldWrite += 1;
            ticketWouldWrite = true;
          }
        }
      }
    } catch (error) {
      result.outcome = "classify-failed";
      result.reason = describeException(error);
      for (const field of ["team", "component"] as const) {
        const raw = row[field] as string | null;
        const label = field === "component" ? canonicalizeComponent(raw, aliases) : raw;
        const counts = confusion[field];
        const bucket = (counts[label ?? "<empty>"] ??= {});
        bucket["<classify-failed>"] = (bucket["<classify-failed>"] ?? 0) + 1;
      }
      results.push(result);
      logTicketResult(result);
      continue;
    }
    wouldWriteTickets += ticketWouldWrite ? 1 : 0;
    results.push(result);
    logTicketResult(result);
  }
  const total = rows.length;
  const metrics = {
    agreement_rate: {
      team: total ? agree.team / total : 0,
      component: total ? agree.component / total : 0,
    },
    overall_agreement_rate: total ? (agree.team + agree.component) / (2 * total) : 0,
    confusion,
    confidence_distribution: {
      values: confidence,
      count: confidence.length,
      min: confidence.length ? Math.min(...confidence) : null,
      max: confidence.length ? Math.max(...confidence) : null,
      mean: confidence.length
        ? confidence.reduce((sum, value) => sum + value, 0) / confidence.length
        : null,
    },
    would_write_count: wouldWrite,
    would_write_ticket_count: wouldWriteTickets,
  };
  const summary = summarize(results);
  summary.metrics = metrics;
  summary.report = writeReport(config, results, summary, metrics);
  return summary;
}
