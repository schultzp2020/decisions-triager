import { describe, expect, it } from "vitest";
import { ChoicePolicy, topProbabilities } from "../src/policy.ts";
import type { Answer } from "../src/classifier.ts";
import { ALIASES, choiceAnswer } from "./helpers.ts";

describe("topProbabilities", () => {
  it("sorts and truncates valid probabilities", () => {
    const answer = { probabilities: { B: 0.3, A: 0.6, C: 0.1, D: 0.05 } } as unknown as Answer;
    expect(topProbabilities(answer)).toEqual([
      ["A", 0.6],
      ["B", 0.3],
      ["C", 0.1],
    ]);
  });

  it("treats malformed probabilities as absent metadata", () => {
    for (const probs of [
      "nope",
      ["a", "b"],
      { A: Number.NaN },
      { A: Number.POSITIVE_INFINITY },
      { A: true },
      { A: "0.9" },
    ]) {
      expect(topProbabilities({ probabilities: probs } as unknown as Answer)).toEqual([]);
    }
    expect(topProbabilities(undefined)).toEqual([]);
  });

  it("oversized integers are absent", () => {
    expect(
      topProbabilities({ probabilities: { Catalog: 1e308 * 10 } } as unknown as Answer),
    ).toEqual([]);
  });
});

describe("ChoicePolicy.assess", () => {
  const policy = new ChoicePolicy(ALIASES, 0.7);

  it("threshold is inclusive", () => {
    expect(
      policy.assess("team", choiceAnswer("Platform", 0.7), ["Platform"], null).writeEligible,
    ).toBeTruthy();
    expect(policy.assess("team", choiceAnswer("Platform", 0.699), ["Platform"], null).reason).toBe(
      "low-confidence",
    );
  });

  it("reasons for every malformed answer shape", () => {
    expect(policy.assess("team", undefined, ["Platform"], null).validationReason).toBe(
      "missing-answer",
    );
    expect(
      policy.assess(
        "team",
        { type: "score", score: 1, confidence: 0.9 } as unknown as Answer,
        ["Platform"],
        null,
      ).validationReason,
    ).toBe("malformed-answer");
    expect(
      policy.assess("team", choiceAnswer("Not A Team"), ["Platform"], null).validationReason,
    ).toBe("invalid-choice");
    expect(
      policy.assess(
        "team",
        { type: "choice", choice: "Platform", probabilities: {} } as unknown as Answer,
        ["Platform"],
        null,
      ).validationReason,
    ).toBe("invalid-confidence");
  });

  it("canonicalizes component aliases and requires the live target", () => {
    const assessment = policy.assess(
      "component",
      choiceAnswer("ArgoCD Plugin", 0.9),
      ["ArgoCD Plugin", "ArgoCD"],
      "ArgoCD",
    );
    expect(assessment.choice).toBe("ArgoCD");
    expect(assessment.validationReason).toBe(null);
    expect(assessment.agreement).toBeTruthy();
    expect(assessment.writeEligible).toBeTruthy();

    const unknown = new ChoicePolicy(ALIASES, 0.7).assess(
      "component",
      choiceAnswer("ArgoCD Plugin"),
      ["ArgoCD Plugin"],
      "ArgoCD",
    );
    expect(unknown.validationReason).toBe("unknown-component");
    expect(unknown.writeEligible).toBeFalsy();
  });

  it("low confidence never masks the validation reason", () => {
    const assessment = new ChoicePolicy(ALIASES, 0.7).assess(
      "component",
      choiceAnswer("ArgoCD Plugin", 0.6),
      ["ArgoCD Plugin"],
      "ArgoCD",
    );
    expect(assessment.validationReason).toBe("unknown-component");
    expect(assessment.reason).toBe("low-confidence");
    expect(assessment.writeEligible).toBeFalsy();
  });

  it("decision records metadata only when the answer carried it", () => {
    const withMeta = policy
      .assess(
        "team",
        choiceAnswer("Platform", 0.9, { Platform: 0.9, Other: 0.1 }),
        ["Platform"],
        null,
      )
      .decision("team");
    expect(withMeta.action).toBe("assigned");
    expect(withMeta.source).toBe("model");
    expect(withMeta.confidence).toBe(0.9);
    expect(withMeta.probabilities).toEqual([
      ["Platform", 0.9],
      ["Other", 0.1],
    ]);
    const noMeta = policy.assess("team", undefined, ["Platform"], null).decision("team");
    expect(noMeta.action).toBe("abstained");
    expect(noMeta.confidence).toBeUndefined();
  });

  it("unknown-component decisions still carry the predicted value", () => {
    const decision = new ChoicePolicy(ALIASES, 0.7)
      .assess("component", choiceAnswer("ArgoCD Plugin"), ["ArgoCD Plugin"], "ArgoCD")
      .decision("component");
    expect(decision.action).toBe("abstained");
    expect(decision.reason).toBe("unknown-component");
    expect(decision.value).toBe("ArgoCD");
  });
});
