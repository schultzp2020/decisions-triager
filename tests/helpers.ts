// Shared fixtures and fakes for the offline test suites.
import type { Answer, Classifier, Question } from "../src/classifier.ts";
import type { TeamCatalog } from "../src/datafiles.ts";
import type { JiraClient } from "../src/jira.ts";
import type { Ticket } from "../src/normalize.ts";

export const TEAMS: TeamCatalog = {
  Platform: {
    id: "11111111-2222-3333-4444-555555555555",
    components: ["Catalog", "Build"],
    members: ["Alex Ash", "Bea Brooks"],
  },
  Install: {
    id: "66666666-7777-8888-9999-000000000000",
    components: ["Helm Chart", "Operator"],
    members: ["Chris Chen"],
  },
};

export const ALIASES: Record<string, string> = {
  "ArgoCD Plugin": "ArgoCD",
  "Quay Plugin": "Quay",
};

export const DESCRIPTIONS: Record<string, string> = {
  ArgoCD: "ArgoCD plugin integration",
  Catalog: "Backstage software catalog",
  "Helm Chart": "Helm chart for deployment",
};

export const LIVE_COMPONENTS = ["ArgoCD", "ArgoCD Plugin", "Catalog", "Helm Chart", "Quay Plugin"];

export const UUID = "11111111-2222-3333-4444-555555555555";
export const OTHER_UUID = "66666666-7777-8888-9999-000000000000";

/** A complete, readable Jira fields object (explicit empties allowed). */
export function validFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: "t",
    description: null,
    components: [],
    customfield_10001: null,
    assignee: null,
    project: { key: "PROJECT" },
    ...overrides,
  };
}

export function rawIssue(
  key = "PROJ-1",
  opts: {
    team?: unknown;
    component?: string | null;
    assignee?: unknown;
    summary?: string;
    description?: unknown;
    project?: string;
  } = {},
): { key: string; fields: Record<string, unknown>; updates: unknown[] } {
  return {
    key,
    updates: [],
    fields: validFields({
      summary: opts.summary ?? "t",
      description: opts.description ?? "d",
      components:
        opts.component === null || opts.component === undefined ? [] : [{ name: opts.component }],
      customfield_10001: typeof opts.team === "string" ? { name: opts.team } : (opts.team ?? null),
      assignee: opts.assignee ?? null,
      project: { key: opts.project ?? "PROJECT" },
    }),
  };
}

export interface RawIssue {
  key: string;
  fields: Record<string, unknown>;
  updates: unknown[];
}

export function makeTicket(
  opts: {
    key?: string;
    team?: string | null;
    component?: string | null;
    assignee?: string | null;
    title?: string;
    description?: string;
  } = {},
): Ticket {
  return {
    key: opts.key ?? "PROJ-1",
    title: opts.title ?? "Catalog import fails",
    description: opts.description ?? "Import fails",
    component: opts.component ?? null,
    team: opts.team ?? null,
    assignee: opts.assignee ?? null,
    projectKey: "PROJECT",
  };
}

export function choiceAnswer(
  choice: string,
  confidence = 0.9,
  probs?: Record<string, number>,
): Answer {
  return {
    type: "choice",
    choice,
    probabilities: probs ?? { [choice]: confidence },
    confidence,
  };
}

export class FakeClassifier implements Classifier {
  calls: { state: object; questions: Record<string, Question> }[] = [];
  answers: Record<string, Answer>;
  exc: Error | null;

  constructor(answers: Record<string, Answer> = {}, opts: { exc?: Error } = {}) {
    this.answers = answers;
    this.exc = opts.exc ?? null;
  }

  classify(state: object, questions: Record<string, Question>): Promise<Record<string, Answer>> {
    this.calls.push({ state, questions });
    if (this.exc) {
      return Promise.reject(this.exc);
    }
    return Promise.resolve(this.answers);
  }
}

/** Mimics the Cloud adapter surface used by JiraGateway (raw payloads).

  issues maps key -> array of raw issues returned by successive issue()
  calls (the last entry repeats); this lets tests simulate a value being
  filled between two fetches. */
export class FakeJiraClient implements JiraClient {
  private readonly issues: Map<string, RawIssue[]>;
  private readonly searchResults: unknown[];
  private readonly components: unknown[] | null;
  searchCalls: { jql: string; maxResults: number; fields: string[] | null }[] = [];
  updates: { key: string; fields: Record<string, unknown> }[] = [];
  componentsCalls = 0;
  /** When set, updateIssue payloads whose JSON mentions this key fail. */
  failUpdateOn: string | null = null;

  constructor(
    opts: {
      issues?: Record<string, RawIssue[]>;
      searchResults?: RawIssue[];
      components?: unknown[] | null;
    } = {},
  ) {
    this.issues = new Map(Object.entries(opts.issues ?? {}).map(([k, v]) => [k, [...v]]));
    this.searchResults = [...(opts.searchResults ?? [])];
    let { components } = opts;
    if (components === undefined) {
      components = LIVE_COMPONENTS.map((name) => ({ name }));
    }
    this.components = components;
  }

  issue(key: string): Promise<unknown> {
    const queue = this.issues.get(key);
    if (!queue || queue.length === 0) {
      return Promise.reject(new Error(`no queued issue for ${key}`));
    }
    return Promise.resolve(queue.length > 1 ? queue.shift() : queue[0]);
  }

  searchJql(jql: string, maxResults: number, fields: string[] | null): Promise<unknown> {
    this.searchCalls.push({ jql, maxResults, fields });
    return Promise.resolve({ issues: this.searchResults, isLast: true });
  }

  updateIssue(key: string, fields: Record<string, unknown>): Promise<void> {
    if (this.failUpdateOn && JSON.stringify(fields).includes(this.failUpdateOn)) {
      return Promise.reject(new Error("update denied"));
    }
    this.updates.push({ key, fields });
    const queue = this.issues.get(key);
    if (queue && queue.length > 0) {
      queue.at(-1)?.updates.push(fields);
    }
    return Promise.resolve();
  }

  projectComponents(): Promise<unknown> {
    this.componentsCalls += 1;
    return Promise.resolve(this.components);
  }
}

/** The required config surface (jira site + JQL) with fictional values. */
export const EXAMPLE_SERVER = "https://example.atlassian.net";
/** The required config minus the classifier block, for tests that supply
 * their own classifier settings. */
export const REQUIRED_YAML_NO_CLASSIFIER = `jira:\n  server: ${EXAMPLE_SERVER}\njql:\n  candidate: 'project in (PROJ) AND status != closed'\n  audit: 'project in (PROJ) AND component is not EMPTY'\n`;

/** A minimal valid config: fictional site, JQL, and classifier. */
export const REQUIRED_YAML = `${REQUIRED_YAML_NO_CLASSIFIER}classifier:\n  backend: llama\n  base_url: http://localhost:8080/v1\n  model: test-model\n`;
