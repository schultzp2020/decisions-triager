import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CLI = join(import.meta.dirname, "..", "src", "index.ts");
const FIXTURE_CONFIG = join(import.meta.dirname, "fixtures", "cli-config.yaml");

function runCli(
  args: string[],
  env: Record<string, string> = {},
  cwd?: string,
): { status: number; output: string; err: string } {
  try {
    const output = execFileSync("node", [CLI, ...args], {
      encoding: "utf-8",
      env: { ...process.env, TRIAGER_CONFIG: FIXTURE_CONFIG, ...env },
      ...(cwd ? { cwd } : {}),
    });
    return { status: 0, output, err: "" };
  } catch (error) {
    const e = error as { status: number; stdout: string; stderr: string };
    return { status: e.status, output: e.stdout, err: e.stderr };
  }
}

describe("CLI", () => {
  it("--check validates offline and reports no network", () => {
    const result = runCli(["--check"], { JIRA_API_TOKEN: "user@example.com:tok" });
    expect(result.status).toBe(0);
    expect(result.output).toContain("configuration valid (no network)");
  });

  it("fails closed on invalid env without echoing the value", () => {
    const result = runCli(["--check"], { JIRA_API_TOKEN: "user@example.com:tok", DRY_RUN: "ture" });
    expect(result.status).toBe(1);
    expect(result.err).not.toContain("ture");
    expect(result.err).toContain("DRY_RUN");
  });

  it("rejects malformed credentials before checking files", () => {
    for (const token of ["", "bare-token", "user@example.com:"]) {
      const result = runCli(["--check"], { JIRA_API_TOKEN: token });
      expect(result.status).toBe(1);
      expect(result.err).toContain("email:token");
    }
  });

  it("eval mode requires --corpus", () => {
    const result = runCli(["--mode", "eval"], { JIRA_API_TOKEN: "user@example.com:tok" });
    expect(result.status).toBe(1);
    expect(result.err).toContain("--corpus");
  });

  it("rejects unknown CLI values", () => {
    const result = runCli(["--mode", "sideways"], { JIRA_API_TOKEN: "user@example.com:tok" });
    expect(result.status).toBe(1);
    expect(result.err).toContain("--mode");
    const sample = runCli(["--mode", "eval", "--corpus", "x.json", "--sample", "abc"], {
      JIRA_API_TOKEN: "user@example.com:tok",
    });
    expect(sample.status).toBe(1);
    expect(sample.err).toContain("--sample");
  });

  it("audit --check validates the audit state file in the working directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "triager-cli-"));
    writeFileSync(join(dir, "triager-state.json"), "{broken", "utf-8");
    const result = runCli(
      ["--mode", "audit", "--check"],
      {
        JIRA_API_TOKEN: "user@example.com:tok",
      },
      dir,
    );
    expect(result.status).toBe(1);
    expect(result.err).toContain("unreadable/corrupt");
  });
});
