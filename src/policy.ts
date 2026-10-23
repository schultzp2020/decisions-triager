// Pure prediction validity, canonical authorization, and write eligibility.
import type { Answer } from "./classifier.ts";
import { isRecord } from "./normalize.ts";
import { canonicalizeComponent } from "./questions.ts";
import type { Decision, FieldName } from "./records.ts";

/** Top-N (label, probability) pairs of a choice answer, highest first.

probabilities must be an object of string -> finite number; anything else is
treated as absent metadata ([]), never a ticket failure. */
export function topProbabilities(answer: Answer | null | undefined, limit = 3): [string, number][] {
  const probs = isRecord(answer) ? answer.probabilities : undefined;
  if (
    !isRecord(probs) ||
    !Object.values(probs).every((value) => typeof value === "number" && Number.isFinite(value))
  ) {
    return [];
  }
  return (Object.entries(probs) as [string, number][]).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

export class ChoiceAssessment {
  readonly choice: string | null;
  readonly validationReason: string | null;
  readonly confidence: number | null;
  readonly probabilities: [string, number][];
  readonly agreement: boolean;
  readonly writeEligible: boolean;
  readonly reason: string | null;
  readonly hasMetadata: boolean;

  constructor(
    choice: string | null,
    validationReason: string | null,
    confidence: number | null,
    probabilities: [string, number][],
    agreement: boolean,
    writeEligible: boolean,
    reason: string | null,
    hasMetadata: boolean,
  ) {
    this.choice = choice;
    this.validationReason = validationReason;
    this.confidence = confidence;
    this.probabilities = probabilities;
    this.agreement = agreement;
    this.writeEligible = writeEligible;
    this.reason = reason;
    this.hasMetadata = hasMetadata;
  }

  decision(field: FieldName): Decision {
    let decision: Decision;
    if (this.writeEligible) {
      decision = {
        field,
        action: "assigned",
        source: "model",
        value: this.choice,
      };
    } else {
      decision = { field, action: "abstained", reason: this.reason };
    }
    if (this.reason === "unknown-component") {
      decision.source = "model";
      decision.value = this.choice;
    }
    if (this.hasMetadata) {
      decision.confidence = this.confidence;
      decision.probabilities = this.probabilities;
    }
    return decision;
  }
}

export class ChoicePolicy {
  private readonly aliases: Record<string, string>;
  private readonly threshold: number;

  constructor(aliases: Record<string, string>, confidenceThreshold: number) {
    this.aliases = { ...aliases };
    this.threshold = confidenceThreshold;
  }

  assess(
    field: FieldName,
    answer: Answer | null | undefined,
    allowedLabels: string[],
    previous: string | null,
  ): ChoiceAssessment {
    let choice: string | null = null;
    let reason: string | null = null;
    let confidence: number | null = null;
    const record = isRecord(answer) ? (answer as Record<string, unknown>) : null;
    if (record) {
      const candidate = record.confidence;
      if (typeof candidate === "number" && candidate >= 0 && candidate <= 1) {
        confidence = candidate;
      }
    }
    if (record === null) {
      reason = answer === undefined || answer === null ? "missing-answer" : "malformed-answer";
    } else if (record.type !== "choice") {
      reason = "malformed-answer";
    } else {
      const picked = record.choice;
      if (typeof picked !== "string" || !allowedLabels.includes(picked)) {
        reason = "invalid-choice";
      } else if (confidence === null) {
        reason = "invalid-confidence";
      } else {
        choice = picked;
      }
    }
    if (field === "component") {
      previous = canonicalizeComponent(previous, this.aliases);
      if (choice !== null) {
        const canonical = canonicalizeComponent(choice, this.aliases);
        choice = canonical;
        if (choice !== null && !allowedLabels.includes(choice)) {
          reason = "unknown-component";
        }
      }
    }
    let writeReason = reason;
    if (choice !== null && (confidence ?? 0) < this.threshold) {
      writeReason = "low-confidence";
    }
    return new ChoiceAssessment(
      choice,
      reason,
      confidence,
      topProbabilities(answer),
      reason === null && choice === previous,
      writeReason === null,
      writeReason,
      record !== null,
    );
  }
}
