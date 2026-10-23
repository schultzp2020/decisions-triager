# AGENTS.md

Guidance for coding agents working in this repository.

## Definition of done

`pnpm check` green — type-aware oxlint, oxfmt, and the vitest suite in one
command. That is the only gate; everything else is convention below.

There is no build step and no `tsc`: Node runs the TypeScript sources
directly, and type errors surface through oxlint's type-aware pass as lint
errors. Reach for `node src/index.ts` to run, `pnpm vitest run <file>` to
iterate on one suite.

## The one rule

Everything here is **fail-closed**: any failure — malformed config, bad
Jira payload, classifier error, low confidence, race, team-UUID conflict —
lands in the abstain or error path, never in a write to Jira. When
changing `src/`, preserve that property. The README section
"Explanation: the safety model" is the authoritative contract, and
`tests/` encodes it case by case — a change that turns a red test green
by weakening the check it covers is wrong even when `pnpm check` passes.

## Conventions the code does not confess

- pnpm, never npm or yarn.
- `erasableSyntaxOnly` is on: no constructor parameter properties, no
  enums; write explicit field declarations instead.
- jira.js embeds raw response bodies in its error messages, so every
  jira.js call goes through the `call()` wrapper in `src/jira.ts` that
  rethrows a status-only error. Route any new endpoint through it.
- Anything logged or written to a report passes through `redact()` /
  `scrub` in `src/redact.ts`; secrets register via `registerSecrets`.
- Tests stay offline. The two seams are jira.js's custom `fetch` (wired in
  `src/jira.ts`, scripted in `tests/jira.test.ts`) and the injected
  classifier functions (`ClassifyFn` in `src/classifier.ts`, fakes in
  `tests/helpers.ts`). A test that would need network is testing the
  wrong seam.
- The config surface lives in the TypeBox schema in `src/config.ts` —
  single source of truth for keys, types, and ranges. When adding a key:
  update the schema, `config.example.yaml`, and the README reference
  table in the same change.
- Fixtures use fictional names, sites, and UUIDs. The real
  `config.yaml`, `teams.json`, and `components.json` are gitignored
  deployment files; commit only the `*.example*` counterparts.
- External contracts to keep verbatim: the report JSON shape, the
  `triager-state.json` entry shape, and the two-arg
  `searchCandidates(limit, jql)` style seams the tests drive. Change them
  deliberately, never incidentally.
