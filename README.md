# decisions-triager — guarded Jira auto-triage

Fetches open Jira tickets that are missing **Team** and/or **component**,
decides the missing fields with a decision model, and fills them in —
behind a fail-closed safety model so a bad config, a flaky model, or a
racy edit can never corrupt your tracker.

Classification runs through [`jira.js`](https://github.com/mrrefactoring/jira.js)
+ [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi-ai) behind
a small adapter layer: by default a self-hosted llama.cpp System One
decision model; `classifier.backend: openai` swaps to OpenAI's Decisions
API with a config change. TypeScript, no build step — Node runs the source
directly.

## Quick start

```bash
git clone https://github.com/schultzp2020/decisions-triager
cd decisions-triager
pnpm install

cp config.example.yaml config.yaml    # fill in your Jira site + JQL
cp teams.example.json teams.json      # your team catalog
cp components.example.json components.json   # your component catalog
cp .env.example .env                  # JIRA_API_TOKEN, CLASSIFIER_API_KEY

node src/index.ts --check             # offline validation, no network
node src/index.ts                     # triage mode (dry run by default)
```

## Safety model

- **`dry_run` defaults to `true`** — nothing is written to Jira unless the
  config (or `DRY_RUN=false` in the environment) says otherwise.
- **Strict configuration**: every `config.yaml` value is validated against
  a [TypeBox](https://github.com/sinclairzx81/typebox) schema before use;
  unknown keys and wrong types abort startup. A typo like
  `dry_run: "ture"` can never silently enable live writes, and a
  `confidence_threshold` outside `[0, 1]` can never bypass the gate.
- **The Jira credential is pinned to one origin**: `jira.server` must be
  exactly one `https` origin (no port, path, query, fragment, or user
  info), validated at load time before any credential is constructed.
  Mutations never follow redirects (a 301 destroys PUT bodies), requests
  are single-attempt with a 30s timeout, and HTTP failures surface the
  status code only — response bodies never reach logs or reports.
- **Fetched issues are validated** before anything is decided or written:
  the key must be readable (and match the requested key on a re-fetch),
  every requested field must be present, and values must have supported
  shapes. Omitted keys and unreadable shapes **fail the ticket** — they
  never count as "missing" (writable) fields, and no project default is
  ever assumed. Descriptions accept strings or validated Cloud ADF
  documents (max depth 10, max 10,000 nodes); unknown/malformed ADF fails
  closed.
- Deterministic pre-routes run **before** any model call:
  - both fields already set → ticket skipped, no model call;
  - the assignee is a known team member and Team is missing → that team is
    assigned deterministically (no model call for Team).
- **Classifier failure suppresses all writes for that ticket**: if the
  classify call fails, every field that needed a decision is recorded as
  `classify-failed` and nothing is written — including the deterministic
  assignee-routed team.
- Model answers are validated: the choice must be an allowed label,
  confidence a number in `[0, 1]` at or above `confidence_threshold`.
  Anything else **abstains** — no write, logged for human review. There is
  no fallback model.
- Predicted components are canonicalized through `components.json` and
  must exist in the **live** Jira project component list. Lookup failure or
  an unknown canonical name abstains; unvalidated labels are never written.
- Before each write the issue is re-fetched and the field is only filled if
  still missing (or, in audit mode, unchanged since the search snapshot);
  the update path re-fetches and verifies **twice** more immediately before
  dispatch, skipping (`skipped-race`) any field that changed. Jira offers
  no atomic compare-and-set, so a small residual race window remains.
- **Team writes use catalog UUIDs with a live cross-check**: the catalog in
  `teams.json` is authoritative; a live Jira UUID that disagrees with it
  marks the team conflicted for the run and Team writes for it abstain
  (`team-uuid-conflict`).
- Logs are bounded and secret-redacted: configured tokens and the encoded
  credential never appear in diagnostics, reports, or the audit state file.

## Layout

```
config.yaml      settings (the single settings surface; gitignored)
.env             secrets: JIRA_API_TOKEN, CLASSIFIER_API_KEY (gitignored)
teams.json       team catalog: {team: {id, components, members, description?}}
components.json  component catalog: {canonical: {description, aliases}}
src/
  index.ts       CLI (cleye): --mode/--check/--report/--corpus/--sample
  config.ts      strict TypeBox-validated config.yaml + env
  classifier.ts  pi-ai adapter (llama System One | OpenAI Decisions)
  jira.ts        jira.js adapter: origin pin, no redirects, one attempt
  normalize.ts   raw Jira payloads -> validated Tickets (fail closed)
  gateway.ts     guarded reads/writes, team-UUID cross-check
  questions.ts   classifier state + questions (the prompt contract)
  policy.ts      answer validation, canonicalization, write eligibility
  modes.ts       triage / audit / eval orchestration
  state.ts       audit history (atomic, validated)
  report.ts      run summary + JSON report artifacts
tests/           offline vitest suites (no Jira, no model)
```

`teams.json` and `components.json` are deployment-private (gitignored);
the committed `*.example*` files show the shape with fictional data.

## Configuration

`config.yaml` holds every setting; secrets live in `.env` (or the
environment, loaded with Node's built-in `process.loadEnvFile`) and are
never committed. `DRY_RUN` in the environment overrides the file (strict
`true`/`false` only).

Required settings (see `config.example.yaml`):

| Setting              | Purpose                                                                     |
| -------------------- | --------------------------------------------------------------------------- |
| `jira.server`        | Exactly one `https` origin, e.g. `https://your-site.atlassian.net`          |
| `jql.candidate`      | Search for tickets missing Team and/or component                            |
| `jql.audit`          | Search for tickets with Team and component both set                         |
| `team_name_prefixes` | Strip site-specific prefixes from Jira team names, e.g. `["ACME "]`         |

Optional settings:

| Setting                            | Default                   | Purpose                                                                       |
| ---------------------------------- | ------------------------- | ----------------------------------------------------------------------------- |
| `mode`                             | `triage`                  | `triage` \| `audit` \| `eval` (`--mode` overrides)                            |
| `classifier.backend`               | `llama`                   | `llama` (System One on llama.cpp `/v1/systemone`) or `openai` (Decisions API) |
| `classifier.base_url`              | per backend               | `http://localhost:8080/v1` for llama; `https://api.openai.com/v1` for openai  |
| `classifier.model`                 | per backend               | `ggml-org/vllm-d3-flash-GGUF:Q8_0` for llama; `gpt-6-luna` for openai         |
| `classifier.timeout_seconds`       | `60`                      | Per-request timeout (>= 1)                                                    |
| `confidence_threshold`             | `0.7`                     | Minimum confidence to write (inclusive), `[0, 1]`                             |
| `assignee_route`                   | `true`                    | Deterministic assignee→team pre-route                                         |
| `dry_run`                          | `true`                    | `false` enables live Jira writes                                              |
| `max_tickets`                      | `100`                     | Candidate limit per run (>= 1)                                                |
| `description_max_chars`            | `48000`                   | Cap on the description sent to the classifier (>= 500)                        |
| `audit.recheck_days`               | `30`                      | Dedup interval for re-audits (>= 0)                                           |
| `audit.state_file`                 | `triager-state.json`      | Audit history (atomic JSON, cwd-relative)                                     |
| `report_file`                      | `report-<timestamp>.json` | Per-run JSON artifact                                                         |
| `files.teams` / `files.components` | shipped files             | Catalog overrides (package-relative when bare)                                |

Secrets (`.env`, copy from `.env.example`):

| Variable             | Purpose                                                          |
| -------------------- | ---------------------------------------------------------------- |
| `JIRA_API_TOKEN`     | `email:api-token` — sent as Basic auth to the configured origin only |
| `CLASSIFIER_API_KEY` | Required for the `openai` backend; optional for local llama      |

`TRIAGER_CONFIG` in the environment points the CLI at a different config
file.

## Running

```bash
pnpm install            # once
pnpm check              # lint + format + tests

node src/index.ts --check                       # offline config validation
node src/index.ts                               # triage mode (dry run)
DRY_RUN=false node src/index.ts                 # triage mode (live)
node src/index.ts --mode audit                  # correct stale assignments
node src/index.ts --mode eval --corpus export.json --sample 100
node src/index.ts --mode audit --report out.json
```

`--check` validates the config, catalogs, and credentials without network
access (audit mode additionally validates the state file). Exit code is `0`
on success, `1` if the run fails or any per-ticket write errored.

Modes:

- **triage** — fill missing Team/component on open candidates.
- **audit** — re-check tickets whose fields are all set; correct only
  validated, high-confidence mismatches, deduplicated through the state
  file for `recheck_days`.
- **eval** — replay a labeled export (`key`, `title`, `description`,
  `team`, `component`) through the classifier only; never contacts Jira.
  Produces agreement/confusion metrics.

Each ticket logs one structured JSON line (`key`, `outcome`, `decisions`
with confidence and top-3 probabilities, `writes` with per-field status).
Every run appends to `reports/index.jsonl` and writes its report artifact.

## The classifier backends

- **`llama`** (default) — [System One](https://github.com/ggml-org) style
  decision calls against a self-hosted llama.cpp server
  (`llama-server`). Reads next-token probabilities, so confidence numbers
  are actual model probabilities. No API key needed on a trusted network.
- **`openai`** — OpenAI's Decisions API. Needs `CLASSIFIER_API_KEY` in
  `.env`.

Both answer the same two questions per ticket (Team, component) with
choice + confidence + probability distributions; the policy layer treats
them identically.

## Tests

```bash
pnpm test
```

Offline vitest suites cover: strict config validation, fail-closed issue
normalization (including ADF bounds), the guarded write paths and race
skips, team-UUID conflicts, all three modes, audit-history semantics, the
jira.js adapter's wire contracts (through its fetch seam), and the pi-ai
classifier adapter (through injected backend functions). Nothing in the
suite contacts Jira or a model.

## License

Apache-2.0 — see [LICENSE](LICENSE).
