import { describe, expect, it } from "vitest";
import {
  IssueValidationError,
  descriptionText,
  isTeamUuid,
  normalizeIssue,
  teamNameKey,
} from "../src/normalize.ts";
import { rawIssue, validFields } from "./helpers.ts";

describe("normalizeIssue", () => {
  it("reads cloud team objects and explicit empties", () => {
    const issue = {
      key: "PROJ-1",
      fields: validFields({
        description: "d",
        components: [{ name: "Catalog" }],
        customfield_10001: { name: "Platform" },
        assignee: { displayName: "Alex Ash" },
      }),
    };
    expect(normalizeIssue(issue)).toEqual({
      key: "PROJ-1",
      title: "t",
      description: "d",
      component: "Catalog",
      team: "Platform",
      assignee: "Alex Ash",
      projectKey: "PROJECT",
    });
    expect(
      normalizeIssue({
        key: "PROJ-2",
        fields: validFields({
          customfield_10001: { name: "Install" },
          project: { key: "SUPP" },
        }),
      }),
    ).toMatchObject({ team: "Install", projectKey: "SUPP", component: null });
  });

  it("explicit empties mean missing (writable), not unreadable", () => {
    expect(normalizeIssue({ key: "PROJ-1", fields: validFields() })).toMatchObject({
      team: null,
      component: null,
      description: "",
      assignee: null,
    });
  });

  it("missing team name shapes are unset", () => {
    for (const team of [null, {}, { id: "x" }, { name: null }]) {
      expect(
        normalizeIssue({ key: "PROJ-1", fields: validFields({ customfield_10001: team }) }).team,
      ).toBe(null);
    }
  });

  it("malformed team values fail closed", () => {
    for (const team of ["Platform", false, [], { name: 9 }, { name: "" }]) {
      expect(() =>
        normalizeIssue({ key: "PROJ-1", fields: validFields({ customfield_10001: team }) }),
      ).toThrow(IssueValidationError);
    }
  });

  it("falsey and non-list components fail closed", () => {
    for (const components of [{}, false, 0, "", "Catalog", { name: "Catalog" }]) {
      expect(() => normalizeIssue({ key: "PROJ-1", fields: validFields({ components }) })).toThrow(
        IssueValidationError,
      );
    }
  });

  it("permits null and empty-list components", () => {
    for (const components of [null, []]) {
      expect(normalizeIssue({ key: "PROJ-1", fields: validFields({ components }) }).component).toBe(
        null,
      );
    }
  });

  it("rejects empty, partial, mismatched, and projectless responses", () => {
    expect(() => normalizeIssue({})).toThrow(/key/);
    expect(() => normalizeIssue({ key: "PROJ-1" })).toThrow(/fields/);
    const fields = validFields();
    delete fields.customfield_10001;
    expect(() => normalizeIssue({ key: "PROJ-1", fields })).toThrow(/omitted/);
    expect(() => normalizeIssue({ key: "PROJ-2", fields: validFields() }, "PROJ-1")).toThrow(
      /does not match/,
    );
    expect(() =>
      normalizeIssue({ key: "PROJ-1", fields: validFields({ components: [{ id: "123" }] }) }),
    ).toThrow(/components/);
    for (const bad of [null, {}, { key: 42 }]) {
      expect(() =>
        normalizeIssue({ key: "PROJ-1", fields: validFields({ project: bad }) }),
      ).toThrow(/project/);
    }
    const noProject = validFields();
    delete noProject.project;
    expect(() => normalizeIssue({ key: "PROJ-1", fields: noProject })).toThrow(/omitted/);
  });

  it("reads the raw/fields test-resource shape", () => {
    const raw = rawIssue("PROJ-1", { team: { name: "Platform" }, component: "Catalog" });
    const ticket = normalizeIssue({ key: raw.key, raw: { fields: raw.fields } });
    expect(ticket.team).toBe("Platform");
    expect(ticket.component).toBe("Catalog");
  });
});

describe("descriptionText (Cloud ADF)", () => {
  it("extracts text from nested containers and leaves", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hello" },
            { type: "hardBreak" },
            { type: "text", text: "world" },
          ],
        },
        {
          type: "blockquote",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Nested" }] },
            { type: "paragraph", content: [{ type: "text", text: "paragraph" }] },
          ],
        },
      ],
    };
    expect(descriptionText(doc)).toBe("Hello world Nested paragraph");
  });

  it("media nodes extract no text; empty containers are fine", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "mediaSingle", content: [{ type: "media", attrs: { id: "a1" } }] },
        { type: "paragraph", attrs: {} },
      ],
    };
    expect(descriptionText(doc)).toBe("");
  });

  it("task lists extract their text", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { state: "TODO" },
              content: [{ type: "text", text: "reproduce" }],
            },
            {
              type: "taskItem",
              attrs: { state: "DONE" },
              content: [{ type: "text", text: "triage" }],
            },
          ],
        },
      ],
    };
    expect(descriptionText(doc)).toBe("reproduce triage");
  });

  it("malformed documents fail closed", () => {
    for (const adf of [
      { type: "paragraph" },
      { type: "doc", content: "not-a-list" },
      { type: "doc", content: ["invalid"] },
      { type: "doc", content: [{ type: "text" }] },
      { type: "doc", content: [{ type: "unknown" }] },
      { type: "doc", content: [{ type: [] }] },
      { type: "doc", content: [{ type: "hardBreak", content: [] }] },
    ]) {
      expect(() => descriptionText(adf)).toThrow(IssueValidationError);
    }
  });

  it("enforces depth and node bounds", () => {
    let nested: unknown = { type: "paragraph", content: [] };
    for (let i = 0; i < 11; i++) {
      nested = { type: "blockquote", content: [nested] };
    }
    expect(() => descriptionText({ type: "doc", content: [nested] })).toThrow(/bounds/);
    const many = Array.from({ length: 10_001 }, () => ({ type: "text", text: "x" }));
    expect(() => descriptionText({ type: "doc", content: many })).toThrow(/bounds/);
  });
});

describe("team helpers", () => {
  it("teamNameKey folds case and strips configured prefixes", () => {
    const prefixes = ["ACME "];
    expect(teamNameKey("  acme PLATFORM  ", prefixes)).toBe("platform");
    expect(teamNameKey("AcMe Platform", prefixes)).toBe("platform");
    expect(teamNameKey("Other Team", prefixes)).toBe("other team");
    expect(teamNameKey("  acme PLATFORM  ")).toBe("acme platform"); // no prefixes: no strip
  });

  it("isTeamUuid accepts plain, suffixed, and uppercase ids", () => {
    expect(isTeamUuid("11111111-2222-3333-4444-555555555556")).toBeTruthy();
    expect(isTeamUuid("11111111-2222-3333-4444-555555555555-4403")).toBeTruthy();
    expect(isTeamUuid("11111111-2222-3333-4444-555555555557")).toBeTruthy();
    for (const bad of ["4564", "not-a-uuid", "", null, 1]) {
      expect(isTeamUuid(bad)).toBeFalsy();
    }
  });
});
