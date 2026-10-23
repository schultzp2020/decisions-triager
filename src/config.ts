// Configuration: config.yaml holds the settings, .env / the environment
// holds the secrets, DRY_RUN in the environment overrides the file.
// The file is validated against a TypeBox schema (the same schema system
// pi-ai uses) before anything runs: a typo aborts startup, never silently
// enables live writes or bypasses the confidence gate.
//
// config.yaml is deployment-specific (Jira site, JQL, catalogs) and is
// gitignored: copy config.example.yaml to config.yaml and fill it in.
// TRIAGER_CONFIG in the environment points at a different file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { registerSecrets } from "./redact.ts";

export const BASE_DIR = join(import.meta.dirname, "..");
export const TEAM_FIELD = "customfield_10001"; // Jira custom field id for "Team"

export type ClassifierBackend = "llama" | "openai";
export type Mode = "triage" | "audit" | "eval";

export class ConfigError extends Error {}

export type Env = Record<string, string | undefined>;

const ConfigSchema = Type.Object(
  {
    mode: Type.Optional(
      Type.Union([Type.Literal("triage"), Type.Literal("audit"), Type.Literal("eval")]),
    ),
    jira: Type.Optional(
      Type.Object({ server: Type.Optional(Type.String()) }, { additionalProperties: false }),
    ),
    jql: Type.Optional(
      Type.Object(
        { candidate: Type.Optional(Type.String()), audit: Type.Optional(Type.String()) },
        { additionalProperties: false },
      ),
    ),
    team_name_prefixes: Type.Optional(Type.Array(Type.String())),
    classifier: Type.Object(
      {
        backend: Type.Union([Type.Literal("llama"), Type.Literal("openai")]),
        base_url: Type.String({ minLength: 1 }),
        model: Type.String({ minLength: 1 }),
        timeout_seconds: Type.Optional(Type.Number({ minimum: 1 })),
      },
      { additionalProperties: false },
    ),
    confidence_threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    assignee_route: Type.Optional(Type.Boolean()),
    dry_run: Type.Optional(Type.Boolean()),
    max_tickets: Type.Optional(Type.Number({ minimum: 1 })),
    description_max_chars: Type.Optional(Type.Number({ minimum: 500 })),
    audit: Type.Optional(
      Type.Object(
        {
          recheck_days: Type.Optional(Type.Number({ minimum: 0 })),
          state_file: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    report_file: Type.Optional(Type.String()),
    files: Type.Optional(
      Type.Object(
        {
          teams: Type.Optional(Type.String()),
          components: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

interface YamlConfig {
  mode?: unknown;
  jira?: { server?: unknown };
  jql?: { candidate?: unknown; audit?: unknown };
  team_name_prefixes?: unknown;
  classifier: {
    backend: "llama" | "openai";
    base_url: string;
    model: string;
    timeout_seconds?: unknown;
  };
  confidence_threshold?: unknown;
  assignee_route?: unknown;
  dry_run?: unknown;
  max_tickets?: unknown;
  description_max_chars?: unknown;
  audit?: { recheck_days?: unknown; state_file?: unknown };
  report_file?: unknown;
  files?: { teams?: unknown; components?: unknown };
}

/** Parse and validate config.yaml: unknown keys and wrong types abort with
 * a path-bearing message (e.g. config.yaml/dry_run: must be boolean). */
function parseConfigYaml(yamlText: string): YamlConfig {
  const raw: unknown = parse(yamlText);
  const errors = [...Value.Errors(ConfigSchema, raw)];
  if (errors.length > 0) {
    // prefer the field-level error over the object-level duplicate
    const first =
      errors.find(
        (error) => error.instancePath !== "" && error.keyword !== "additionalProperties",
      ) ?? errors[0];
    const message =
      first.keyword === "boolean" && first.message === "schema is false"
        ? `unknown key '${first.instancePath.split("/").at(-1)}'`
        : first.message;
    throw new ConfigError(`config.yaml${first.instancePath}: ${message}`);
  }
  return raw as YamlConfig;
}

/** Strict env boolean: only true/false (case-insensitive) are accepted. */
function envBoolean(env: Env, name: string): boolean | undefined {
  const raw = env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  const value = raw.toLowerCase();
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  // no raw value in the message: a secret pasted into the wrong variable
  // must not leak before any secrets are registered for redaction
  throw new ConfigError(`${name} must be true or false`);
}

function requiredString(value: unknown, what: string): string {
  if (typeof value !== "string" || !value) {
    throw new ConfigError(`${what} is required`);
  }
  return value;
}

function optionalString(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function optionalNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function dataFilePath(value: unknown, what: string): string {
  const path = optionalString(value, what);
  return path.includes("/") || path.includes("\\") || /^[A-Za-z]:/u.test(path)
    ? path
    : join(BASE_DIR, path);
}

/**
 * The Jira site the credential may ever be sent to: exactly one https
 * origin — no port, path, query, fragment, or user info. The check runs
 * at config load, before any credential is constructed.
 */
export function validateJiraServer(server: string): void {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new ConfigError(
      "jira.server must be a valid https origin, e.g. https://site.atlassian.net",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ConfigError(
      "jira.server must be exactly one https origin " +
        "(no port, path, query, fragment, or user info)",
    );
  }
}

export interface Config {
  /** The one https origin the Basic email:token credential may be sent to. */
  jiraServer: string;
  /** Candidate search: open tickets missing Team and/or component. */
  candidateJql: string;
  /** Audit search: tickets with Team and component both set. */
  auditJql: string;
  /** Site-specific prefixes stripped from Jira team names before catalog
   * matching (case-insensitive), e.g. ["ACME "]. */
  teamNamePrefixes: string[];
  jiraApiToken: string;
  teamConfigFile: string;
  componentCatalogFile: string;
  classifierBackend: ClassifierBackend;
  classifierBaseUrl: string;
  classifierModel: string;
  classifierApiKey: string;
  classifierTimeoutSeconds: number;
  confidenceThreshold: number;
  assigneeRoute: boolean;
  dryRun: boolean;
  maxTickets: number;
  descriptionMaxChars: number;
  mode: Mode;
  stateFile: string;
  auditRecheckDays: number;
  reportFile: string;
  corpus?: string;
  sample?: number;
}

export interface LoadConfigOptions {
  /** Parse this YAML text instead of reading config.yaml. */
  yamlText?: string;
  /** Read this file instead of the shipped config.yaml. */
  yamlPath?: string;
}

export function loadConfig(env: Env = process.env, options: LoadConfigOptions = {}): Config {
  const yamlText =
    options.yamlText ??
    readFileSync(options.yamlPath ?? env.TRIAGER_CONFIG ?? join(BASE_DIR, "config.yaml"), "utf-8");
  const file = parseConfigYaml(yamlText);

  const jiraServer = requiredString(file.jira?.server, "jira.server");
  validateJiraServer(jiraServer);
  const candidateJql = requiredString(file.jql?.candidate, "jql.candidate");
  const auditJql = requiredString(file.jql?.audit, "jql.audit");
  const prefixes = Array.isArray(file.team_name_prefixes)
    ? (file.team_name_prefixes as string[])
    : [];

  const dryRunFile = optionalBoolean(file.dry_run, true);
  const dryRunEnv = envBoolean(env, "DRY_RUN"); // cron switch, still strict

  const config: Config = {
    jiraServer,
    candidateJql,
    auditJql,
    teamNamePrefixes: prefixes,
    jiraApiToken: env.JIRA_API_TOKEN ?? "",
    teamConfigFile: dataFilePath(file.files?.teams, "teams.json"),
    componentCatalogFile: dataFilePath(file.files?.components, "components.json"),
    classifierBackend: file.classifier.backend,
    classifierBaseUrl: file.classifier.base_url,
    classifierModel: file.classifier.model,
    classifierApiKey: env.CLASSIFIER_API_KEY ?? "",
    classifierTimeoutSeconds: optionalNumber(file.classifier.timeout_seconds, 60),
    confidenceThreshold: optionalNumber(file.confidence_threshold, 0.7),
    assigneeRoute: optionalBoolean(file.assignee_route, true),
    dryRun: dryRunEnv ?? dryRunFile,
    maxTickets: optionalNumber(file.max_tickets, 100),
    descriptionMaxChars: optionalNumber(file.description_max_chars, 48000),
    mode: (file.mode ?? "triage") as Mode,
    stateFile: optionalString(file.audit?.state_file, "triager-state.json"),
    auditRecheckDays: optionalNumber(file.audit?.recheck_days, 30),
    reportFile: optionalString(file.report_file, ""),
  };

  // The openai backend cannot classify without a key: fail at load, with
  // the fix in the message, instead of deep inside the first classify call.
  if (config.classifierBackend === "openai" && !config.classifierApiKey) {
    throw new ConfigError("CLASSIFIER_API_KEY is required for the openai backend (add it to .env)");
  }

  // Scrub every configured secret from all diagnostic output (redact()).
  const secrets = [config.jiraApiToken, config.classifierApiKey];
  const urlTail = config.classifierBaseUrl.slice(config.classifierBaseUrl.indexOf("://") + 3);
  if (urlTail.includes("@")) {
    secrets.push(config.classifierBaseUrl); // URL carries credentials
  }
  registerSecrets(...secrets);
  return config;
}

export const SEARCH_FIELDS = [
  "summary",
  "description",
  "components",
  TEAM_FIELD,
  "assignee",
  "project",
];
