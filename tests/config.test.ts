import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";
import { REQUIRED_YAML } from "./helpers.ts";
import { redact, resetSecrets } from "../src/redact.ts";

const BASE_YAML = REQUIRED_YAML; // required surface + defaults for the rest

describe("config.yaml loading", () => {
  it("defaults match the shipped contract", () => {
    const config = loadConfig({}, { yamlText: BASE_YAML });
    expect(config.mode).toBe("triage");
    expect(config.classifierBackend).toBe("llama");
    expect(config.classifierBaseUrl).toBe("http://localhost:8080/v1");
    expect(config.classifierModel).toBe("ggml-org/vllm-d3-flash-GGUF:Q8_0");
    expect(config.classifierTimeoutSeconds).toBe(60);
    expect(config.confidenceThreshold).toBe(0.7);
    expect(config.assigneeRoute).toBeTruthy();
    expect(config.dryRun).toBeTruthy();
    expect(config.maxTickets).toBe(100);
    expect(config.descriptionMaxChars).toBe(48000);
    expect(config.auditRecheckDays).toBe(30);
    expect(config.stateFile).toBe("triager-state.json");
    expect(config.jiraServer).toBe("https://example.atlassian.net");
    expect(config.candidateJql).toBe("project in (PROJ) AND status != closed");
    expect(config.auditJql).toBe("project in (PROJ) AND component is not EMPTY");
    expect(config.teamNamePrefixes).toEqual([]);
  });

  it("reads yaml settings", () => {
    const config = loadConfig(
      {},
      { yamlText: `${REQUIRED_YAML}mode: audit\nconfidence_threshold: 0.4\ndry_run: false\n` },
    );
    expect(config.mode).toBe("audit");
    expect(config.confidenceThreshold).toBe(0.4);
    expect(config.dryRun).toBeFalsy();
  });

  it("rejects unknown keys (typo protection)", () => {
    expect(() => loadConfig({}, { yamlText: `${REQUIRED_YAML}dry_runn: true\n` })).toThrow(
      ConfigError,
    );
    expect(() =>
      loadConfig({}, { yamlText: `${REQUIRED_YAML}classifier:\n  backends: llama\n` }),
    ).toThrow(/unknown key 'backends'/);
  });

  it("rejects wrong types and out-of-range values", () => {
    for (const yaml of [
      `${REQUIRED_YAML}dry_run: yes\n`,
      `${REQUIRED_YAML}dry_run: 'true'\n`,
      `${REQUIRED_YAML}confidence_threshold: 1.5\n`,
      `${REQUIRED_YAML}confidence_threshold: -0.1\n`,
      `${REQUIRED_YAML}confidence_threshold: nan\n`,
      `${REQUIRED_YAML}mode: sideways\n`,
      `${REQUIRED_YAML}classifier:\n  backend: gemini\n`,
      `${REQUIRED_YAML}max_tickets: 0\n`,
      `${REQUIRED_YAML}description_max_chars: 100\n`,
      `${REQUIRED_YAML}classifier:\n  timeout_seconds: 0\n`,
    ]) {
      expect(() => loadConfig({}, { yamlText: yaml })).toThrow(ConfigError);
    }
  });

  it("DRY_RUN env override is strict and wins over the file", () => {
    expect(
      loadConfig({ DRY_RUN: "false" }, { yamlText: `${REQUIRED_YAML}dry_run: true\n` }).dryRun,
    ).toBeFalsy();
    expect(
      loadConfig({ DRY_RUN: " True " }, { yamlText: `${REQUIRED_YAML}dry_run: false\n` }).dryRun,
    ).toBeTruthy();
    // a typo must never enable live writes
    expect(() => loadConfig({ DRY_RUN: "ture" }, { yamlText: BASE_YAML })).toThrow(/DRY_RUN/);
    expect(() => loadConfig({ DRY_RUN: "1" }, { yamlText: BASE_YAML })).toThrow(/DRY_RUN/);
  });

  it("registers env secrets for redaction", () => {
    resetSecrets();
    loadConfig(
      { JIRA_API_TOKEN: "tok-123", CLASSIFIER_API_KEY: "sk-classify" },
      { yamlText: BASE_YAML },
    );
    expect(redact("leak tok-123 and sk-classify")).toBe("leak [REDACTED] and [REDACTED]");
  });

  it("registers a credentialed classifier base URL", () => {
    resetSecrets();
    loadConfig(
      {},
      {
        yamlText: `${REQUIRED_YAML}classifier:\n  base_url: http://user:pass@llama:8080/v1\n`,
      },
    );
    expect(redact("http://user:pass@llama:8080/v1")).toBe("[REDACTED]");
  });

  it("relative data file paths resolve against the package directory", () => {
    const config = loadConfig({}, { yamlText: `${REQUIRED_YAML}files:\n  teams: my-teams.json\n` });
    expect(config.teamConfigFile.replaceAll("\\", "/")).toMatch(/triager[/\\]my-teams\.json$/u);
  });
});

describe("jira.server and jql validation", () => {
  it("requires the server and a valid https origin", () => {
    expect(() => loadConfig({}, { yamlText: "jql:\n  candidate: a\n  audit: b\n" })).toThrow(
      "jira.server is required",
    );
    for (const server of [
      "http://example.atlassian.net",
      "https://example.atlassian.net:8443",
      "https://example.atlassian.net/rest",
      "https://example.atlassian.net?x=1",
      "https://example.atlassian.net#frag",
      "https://user:secret@example.atlassian.net",
      "not a url",
    ]) {
      expect(() =>
        loadConfig(
          {},
          { yamlText: `jira:\n  server: ${server}\njql:\n  candidate: a\n  audit: b\n` },
        ),
      ).toThrow(ConfigError);
    }
  });

  it("requires both JQL queries", () => {
    expect(() =>
      loadConfig(
        {},
        { yamlText: "jira:\n  server: https://example.atlassian.net\njql:\n  audit: b\n" },
      ),
    ).toThrow("jql.candidate is required");
    expect(() =>
      loadConfig(
        {},
        { yamlText: "jira:\n  server: https://example.atlassian.net\njql:\n  candidate: a\n" },
      ),
    ).toThrow("jql.audit is required");
  });

  it("team_name_prefixes must be a list of strings", () => {
    expect(() =>
      loadConfig({}, { yamlText: `${REQUIRED_YAML}team_name_prefixes: 'ACME'\n` }),
    ).toThrow("team_name_prefixes");
    const config = loadConfig(
      {},
      { yamlText: `${REQUIRED_YAML}team_name_prefixes:\n  - "ACME "\n` },
    );
    expect(config.teamNamePrefixes).toEqual(["ACME "]);
  });
});
