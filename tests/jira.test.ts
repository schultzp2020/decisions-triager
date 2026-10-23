// Wire contracts through the real jira.js client, exercised offline via its
// fetch seam: every request the adapter makes is scripted and inspected.
import { describe, expect, it } from "vitest";
import { TEAM_FIELD, loadConfig } from "../src/config.ts";
import { EXAMPLE_SERVER, REQUIRED_YAML, rawIssue, validFields } from "./helpers.ts";
import { JiraCloudClient, validateJiraConfig } from "../src/jira.ts";
import { redact, resetSecrets } from "../src/redact.ts";

interface Recorded {
  method: string;
  url: string;
  init: RequestInit;
}

function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: Recorded[] = [];
  const fetchFn = (url: string | URL | Request, init?: RequestInit) => {
    const next = responses.shift();
    calls.push({
      method: init?.method ?? "GET",
      url: url instanceof Request ? url.url : typeof url === "string" ? url : url.href,
      init: init ?? {},
    });
    if (!next) {
      throw new Error("no more scripted responses");
    }
    return Promise.resolve(
      new Response(next.status === 204 ? null : JSON.stringify(next.body), {
        status: next.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  return { fetchFn, calls };
}

function tokenConfig(token = "user@example.com:secret-token"): ReturnType<typeof loadConfig> {
  return loadConfig({ JIRA_API_TOKEN: token }, { yamlText: REQUIRED_YAML });
}

describe("validateJiraConfig", () => {
  it("requires an email:token credential", () => {
    for (const token of [
      "",
      "bare-token",
      "user@example.com:",
      ":token",
      "user:token",
      " user@example.com:token",
    ]) {
      expect(() => validateJiraConfig(tokenConfig(token))).toThrow(/email:token/);
    }
    validateJiraConfig(tokenConfig()); // well-formed: no throw
  });
});

describe("JiraCloudClient (jira.js adapter)", () => {
  it("sends Basic auth to the pinned origin, never following redirects", async () => {
    const page = { issues: [rawIssue()], isLast: true };
    const { fetchFn, calls } = fakeFetch([{ status: 200, body: page }]);
    const client = new JiraCloudClient(tokenConfig(), fetchFn);
    await client.searchJql("project = PROJ", 5, ["summary"]);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: `${EXAMPLE_SERVER}/rest/api/3/search/jql`,
    });
    expect(calls[0].init.redirect).toBe("manual");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("user@example.com:secret-token").toString("base64")}`,
    );
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({
      jql: "project = PROJ",
      maxResults: 5,
      fields: ["summary"],
    });
  });

  it("search pages carry nextPageToken on subsequent calls", async () => {
    const { fetchFn, calls } = fakeFetch([
      { status: 200, body: { issues: [], isLast: false, nextPageToken: "next" } },
      { status: 200, body: { issues: [], isLast: true } },
    ]);
    const client = new JiraCloudClient(tokenConfig(), fetchFn);
    await client.searchJql("jql", 5, null);
    await client.searchJql("jql", 4, null, "next");
    expect(JSON.parse(calls[1].init.body as string)).toMatchObject({
      nextPageToken: "next",
      maxResults: 4,
    });
  });

  it("issue GETs request the fields; updates PUT the field payload", async () => {
    const issue = { key: "PROJ-1", fields: validFields() };
    const { fetchFn, calls } = fakeFetch([
      { status: 200, body: issue },
      { status: 204, body: null },
    ]);
    const client = new JiraCloudClient(tokenConfig(), fetchFn);
    await client.issue("PROJ-1", ["summary", "description"]);
    expect(calls[0].method).toBe("GET");
    expect(decodeURIComponent(calls[0].url)).toContain(
      "/rest/api/3/issue/PROJ-1?fields=summary&fields=description",
    );

    await client.updateIssue("PROJ-1", { [TEAM_FIELD]: "uuid" });
    const put = calls.at(-1);
    expect(put?.method).toBe("PUT");
    expect(put?.url).toContain("/rest/api/3/issue/PROJ-1");
    expect(JSON.parse(put?.init.body as string)).toEqual({
      fields: { [TEAM_FIELD]: "uuid" },
    });
  });

  it("hits the project components endpoint", async () => {
    const { fetchFn, calls } = fakeFetch([{ status: 200, body: [{ name: "Catalog" }] }]);
    const client = new JiraCloudClient(tokenConfig(), fetchFn);
    expect(await client.projectComponents("PROJ")).toEqual([{ name: "Catalog" }]);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(`${EXAMPLE_SERVER}/rest/api/3/project/PROJ/components`);
  });

  it("HTTP failures surface the status only, never the response body", async () => {
    for (const status of [301, 403, 410, 400]) {
      const { fetchFn } = fakeFetch([{ status, body: { secret: "do-not-log" } }]);
      const client = new JiraCloudClient(tokenConfig(), fetchFn);
      await expect(client.updateIssue("PROJ-1", {})).rejects.toThrow(
        `Jira returned HTTP ${status}`,
      );
    }
  });

  it("registers the token and encoded credential for redaction", () => {
    resetSecrets();
    new JiraCloudClient(tokenConfig(), fakeFetch([]).fetchFn);
    expect(redact("user@example.com:secret-token")).toBe("[REDACTED]");
    expect(redact(`Basic ${Buffer.from("user@example.com:secret-token").toString("base64")}`)).toBe(
      "Basic [REDACTED]",
    );
  });
});
