// Classifier adapter: pi-ai classifier APIs behind one interface.
// "llama" talks System One to a local llama-server (/v1/systemone, d3-flash
// and friends); "openai" talks OpenAI's Decisions API. The backend table is
// the only place that knows which pi-ai API each kind uses.
import type {
  ClassifierAnswer,
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  ClassifierOptions,
  ClassifierQuestion,
  ClassifierResult,
  JsonObject,
} from "@earendil-works/pi-ai";
import { classify as openAIDecisions } from "@earendil-works/pi-ai/api/openai-decisions";
import { classify as systemOne } from "@earendil-works/pi-ai/api/typesafe-system-one";
import type { ClassifierBackend } from "./config.ts";
import { describeException, redact } from "./redact.ts";

export class ClassifyError extends Error {}

export type Question = ClassifierQuestion;
export type Answer = ClassifierAnswer;

/** The seam the pipeline sees: answer questions about state in one call. */
export interface Classifier {
  classify(state: object, questions: Record<string, Question>): Promise<Record<string, Answer>>;
}

export type ClassifyFn = (
  model: ClassifierModel<ClassifierApi>,
  context: ClassifierContext,
  options?: ClassifierOptions,
) => Promise<ClassifierResult>;

const BACKENDS: Record<ClassifierBackend, ClassifyFn> = {
  llama: systemOne,
  openai: openAIDecisions,
};

export interface ClassifierOptionsSpec {
  kind: ClassifierBackend;
  model: string;
  baseUrl: string;
  apiKey?: string;
  timeoutSeconds?: number;
  /** Test seam: replace the pi-ai classify call. */
  classifyFns?: Record<ClassifierBackend, ClassifyFn>;
}

export class PiClassifier implements Classifier {
  private readonly kind: ClassifierBackend;
  private readonly fns: Record<ClassifierBackend, ClassifyFn>;
  private readonly model: ClassifierModel<ClassifierApi>;
  private readonly options: ClassifierOptions;

  constructor(spec: ClassifierOptionsSpec) {
    this.kind = spec.kind;
    this.fns = spec.classifyFns ?? BACKENDS;
    this.model = {
      type: "classifier",
      id: spec.model,
      name: "triager classifier",
      api: spec.kind === "llama" ? "typesafe-system-one" : "openai-decisions",
      provider: spec.kind,
      baseUrl: spec.baseUrl,
      input: ["text"],
      contextWindow: 64_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    this.options = {
      timeoutMs: (spec.timeoutSeconds ?? 60) * 1000,
      maxRetries: 0,
    };
    if (spec.apiKey) {
      this.options.apiKey = spec.apiKey;
    } else {
      // pi-ai's system-one transport requires an API key; the local llama
      // server ignores auth, so send a placeholder and suppress the header.
      this.options.apiKey = "triager-local";
      this.options.headers = { authorization: null };
    }
  }

  async classify(
    state: object,
    questions: Record<string, Question>,
  ): Promise<Record<string, Answer>> {
    let result: ClassifierResult;
    try {
      result = await this.fns[this.kind](
        this.model,
        { state: state as JsonObject, questions },
        this.options,
      );
    } catch (error) {
      // category only: the exception string can embed the request URL
      throw new ClassifyError(`classify request failed: ${describeException(error)}`);
    }
    if (result.stopReason !== "stop") {
      // errorMessage is provider-formatted and can embed URLs
      throw new ClassifyError(
        redact(result.errorMessage ?? `classifier stopped: ${result.stopReason}`),
      );
    }
    return result.answers;
  }
}

export function buildClassifier(
  config: {
    classifierBackend: ClassifierBackend;
    classifierModel: string;
    classifierBaseUrl: string;
    classifierApiKey: string;
    classifierTimeoutSeconds: number;
  },
  classifyFns?: Record<ClassifierBackend, ClassifyFn>,
): PiClassifier {
  return new PiClassifier({
    kind: config.classifierBackend,
    model: config.classifierModel,
    baseUrl: config.classifierBaseUrl,
    apiKey: config.classifierApiKey === "" ? undefined : config.classifierApiKey,
    timeoutSeconds: config.classifierTimeoutSeconds,
    classifyFns,
  });
}
