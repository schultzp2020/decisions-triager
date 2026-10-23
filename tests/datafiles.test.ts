import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BASE_DIR, loadConfig } from "../src/config.ts";
import { REQUIRED_YAML } from "./helpers.ts";
import {
  aliasMap,
  descriptionMap,
  loadComponents,
  loadTeamConfig,
  validateConfigFiles,
} from "../src/datafiles.ts";
import { isTeamUuid } from "../src/normalize.ts";

const UUID_ID = "11111111-2222-3333-4444-555555555555-9999";
const VALID_TEAM = { id: UUID_ID, components: ["Catalog"], members: ["Paul"] };

function writeJson(name: string, data: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "triager-data-"));
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(data), "utf-8");
  return path;
}

function configWithFiles(teams: string, components: string) {
  return loadConfig(
    {},
    {
      yamlText: [
        REQUIRED_YAML,
        `files:`,
        `  teams: ${JSON.stringify(teams).replaceAll("\\", "/")}`,
        `  components: ${JSON.stringify(components).replaceAll("\\", "/")}`,
      ].join("\n"),
    },
  );
}

describe("loadTeamConfig", () => {
  it("accepts valid shapes and normalizes the description field", () => {
    expect(loadTeamConfig(writeJson("teams.json", { T: VALID_TEAM }))).toEqual({
      T: { id: UUID_ID, components: ["Catalog"], members: ["Paul"] },
    });
    expect(
      loadTeamConfig(
        writeJson("teams.json", { T: { ...VALID_TEAM, description: "Ships builds." } }),
      ).T.description,
    ).toBe("Ships builds.");
  });

  it("accepts uuid-shaped ids", () => {
    for (const id of [
      "11111111-2222-3333-4444-555555555556",
      "11111111-2222-3333-4444-555555555555-4403",
      "11111111-2222-3333-4444-555555555557",
    ]) {
      expect(
        loadTeamConfig(writeJson("teams.json", { T: { id, components: [], members: [] } })).T.id,
      ).toBe(id);
    }
  });

  it("rejects malformed teams", () => {
    for (const team of [
      { id: UUID_ID, components: ["Catalog"], members: "Paul" },
      { id: null, components: [], members: [] },
      { id: "", components: [], members: [] },
      { id: 1, components: [], members: [] },
      { id: "4564", components: [], members: [] },
      { id: "not-a-uuid", components: [], members: [] },
      { id: UUID_ID, components: "Catalog", members: [] },
      { id: UUID_ID, components: ["A", 2], members: [] },
      { id: UUID_ID, components: [], members: ["A", 2] },
      { components: [], members: [] },
      { id: UUID_ID, components: [], members: [], description: 3 },
    ]) {
      expect(() => loadTeamConfig(writeJson("teams.json", { T: team }))).toThrow("team");
    }
  });

  it("rejects malformed top levels", () => {
    for (const data of [[], {}, { T: "not-a-dict" }]) {
      expect(() => loadTeamConfig(writeJson("teams.json", data))).toThrow("teams");
    }
  });

  it("accepts the shipped catalog with authoritative UUIDs", () => {
    const teams = loadTeamConfig(join(BASE_DIR, "teams.example.json"));
    expect(Object.keys(teams).length).toBeGreaterThanOrEqual(1);
    for (const team of Object.values(teams)) {
      expect(isTeamUuid(team.id)).toBeTruthy();
    }
    expect(teams["Platform"]?.id).toBe("11111111-2222-3333-4444-555555555555");
  });
});

describe("loadComponents", () => {
  it("accepts the merged shape and derives alias/description maps", () => {
    const path = writeJson("components.json", {
      ArgoCD: { description: "ArgoCD plugin integration", aliases: ["ArgoCD Plugin"] },
      Catalog: { description: "Backstage software catalog", aliases: [] },
    });
    const components = loadComponents(path);
    expect(aliasMap(components)).toEqual({ "ArgoCD Plugin": "ArgoCD" });
    expect(descriptionMap(components)).toEqual({
      ArgoCD: "ArgoCD plugin integration",
      Catalog: "Backstage software catalog",
    });
  });

  it("rejects malformed entries", () => {
    for (const entry of [
      null,
      "flat",
      { description: 3, aliases: [] },
      { description: "d", aliases: "ArgoCD Plugin" },
      { description: "d", aliases: ["a", 2] },
      { aliases: [] },
    ]) {
      expect(() => loadComponents(writeJson("components.json", { Catalog: entry }))).toThrow(
        "component",
      );
    }
    expect(() => loadComponents(writeJson("components.json", []))).toThrow("components");
  });

  it("accepts the shipped catalog", () => {
    const components = loadComponents(join(BASE_DIR, "components.example.json"));
    expect(Object.keys(components).length).toBeGreaterThanOrEqual(1);
    for (const entry of Object.values(components)) {
      expect(typeof entry.description).toBe("string");
    }
  });
});

describe("validateConfigFiles", () => {
  it("loads both catalogs and their derived maps", () => {
    const teams = writeJson("teams.json", { T: VALID_TEAM });
    const components = writeJson("components.json", {
      Catalog: { description: "d", aliases: ["Old Catalog"] },
    });
    const catalogs = validateConfigFiles(configWithFiles(teams, components));
    expect(catalogs.teams.T.id).toBe(UUID_ID);
    expect(catalogs.aliases["Old Catalog"]).toBe("Catalog");
    expect(catalogs.descriptions.Catalog).toBe("d");
    expect(catalogs.components.Catalog.aliases).toEqual(["Old Catalog"]);
  });
});
