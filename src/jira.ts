// Jira Cloud adapter over jira.js. The library owns transport, auth, and
// response schemas; this module owns the policy jira.js cannot: the
// origin-pinned host, never-follow redirects, single-attempt requests, the
// 30s timeout, and the email:token credential shape. Everything downstream
// still sees the small JiraClient interface.
import { createCloudClient, isApiError, type CloudClient } from "jira.js";
import { type Config } from "./config.ts";
import { registerSecrets } from "./redact.ts";

export interface SearchPage {
  issues: unknown[];
  isLast: boolean;
  nextPageToken?: string;
}

/** The transport seam: gateway and tests build on this interface. */
export interface JiraClient {
  searchJql(
    jql: string,
    maxResults: number,
    fields: string[] | null,
    nextPageToken?: string,
  ): Promise<unknown>;
  issue(key: string, fields?: string[] | null): Promise<unknown>;
  updateIssue(key: string, fields: Record<string, unknown>): Promise<void>;
  projectComponents(projectKey: string): Promise<unknown>;
}

/** Parse "email:token"; anything else fails startup before a client exists. */
export function validateJiraConfig(config: Config): void {
  const separator = config.jiraApiToken.indexOf(":");
  const email = config.jiraApiToken.slice(0, separator === -1 ? undefined : separator);
  const token = separator === -1 ? "" : config.jiraApiToken.slice(separator + 1);
  if (separator === -1 || !email.includes("@") || !token.trim() || email !== email.trim()) {
    throw new Error("JIRA_API_TOKEN must be email:token (see triager/README.md)");
  }
}

function splitCredential(config: Config): { email: string; apiToken: string } {
  const separator = config.jiraApiToken.indexOf(":");
  return {
    email: config.jiraApiToken.slice(0, separator),
    apiToken: config.jiraApiToken.slice(separator + 1),
  };
}

const REQUEST_TIMEOUT_MS = 30_000;

export class JiraCloudClient implements JiraClient {
  private readonly client: CloudClient;
  private readonly server: string;

  constructor(config: Config, fetchFn: typeof fetch = fetch) {
    validateJiraConfig(config);
    this.server = config.jiraServer; // shape-validated at config load
    const { email, apiToken } = splitCredential(config);
    const credential = Buffer.from(config.jiraApiToken, "utf-8").toString("base64");
    registerSecrets(config.jiraApiToken, apiToken, credential);
    this.client = createCloudClient({
      // Exact-origin pin: the credential is only ever sent to this one host.
      host: this.server,
      auth: { type: "basic", email, apiToken },
      // A 301 destroys PUT bodies; mutations must never follow redirects.
      fetch: (url, init) => fetchFn(url, { ...init, redirect: "manual" }),
      // Deterministic fail-closed behavior: one attempt, no back-off.
      retry: { maxAttempts: 1 },
      // Our fail-closed normalize layer is the validation authority; the
      // library's schema warnings would only duplicate it on stderr.
      onSchemaMismatch: "silent",
    });
  }

  private get signal(): AbortSignal {
    return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  }

  /** jira.js embeds the raw response body in ApiError messages; the body is
   * untrusted and must never reach logs or reports. Surface the status only. */
  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (isApiError(error)) {
        throw new Error(`Jira returned HTTP ${error.status}`);
      }
      throw error;
    }
  }

  async searchJql(
    jql: string,
    maxResults: number,
    fields: string[] | null,
    nextPageToken?: string,
  ): Promise<unknown> {
    return this.call(() =>
      this.client.issueSearch.searchIssuesPost(
        { jql, maxResults, ...(fields ? { fields } : {}), nextPageToken },
        { signal: this.signal },
      ),
    );
  }

  async issue(key: string, fields?: string[] | null): Promise<unknown> {
    return this.call(() =>
      this.client.issues.getIssue(
        { issueIdOrKey: key, ...(fields ? { fields } : {}) },
        { signal: this.signal },
      ),
    );
  }

  async updateIssue(key: string, fields: Record<string, unknown>): Promise<void> {
    await this.call(() =>
      this.client.issues.editIssue({ issueIdOrKey: key, fields }, { signal: this.signal }),
    );
  }

  async projectComponents(projectKey: string): Promise<unknown> {
    return this.call(() =>
      this.client.projectComponents.getProjectComponents(
        { projectIdOrKey: projectKey },
        { signal: this.signal },
      ),
    );
  }
}
