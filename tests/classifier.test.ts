import { describe, expect, it } from "vitest";
import type { ClassifierResult } from "@earendil-works/pi-ai";
import { PiClassifier, type ClassifyFn } from "../src/classifier.ts";
import { loadConfig } from "../src/config.ts";
import { REQUIRED_YAML_NO_CLASSIFIER } from "./helpers.ts";
import { registerSecrets, resetSecrets } from "../src/redact.ts";

interface Recorded {
  model: unknown;
  context: unknown;
  options: unknown;
}

/** A scripted ClassifyFn: returns queued results or rejects. */
function fakeFn(script: { results?: ClassifierResult[]; error?: Error }): {
  fn: ClassifyFn;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const queue = [...(script.results ?? [])];
  const fn = ((model: unknown, context: unknown, options?: unknown) => {
    calls.push({ model, context, options });
    if (script.error) {
      return Promise.reject(script.error);
    }
    const next = queue.shift();
    return next ? Promise.resolve(next) : Promise.reject(new Error("no scripted result"));
  }) as ClassifyFn;
  return { fn, calls };
}

function result(
  answers: Record<string, unknown>,
  stopReason: ClassifierResult["stopReason"] = "stop",
): ClassifierResult {
  return {
    api: "typesafe-system-one",
    provider: "llama",
    model: "m",
    answers: answers as ClassifierResult["answers"],
    stopReason,
    timestamp: 0,
  };
}

const QUESTION = {
  type: "choice",
  instructions: "i",
  criteria: { A: "a" },
} as const;

function classifierWith(
  llama: ClassifyFn,
  openai: ClassifyFn,
  spec: Partial<ConstructorParameters<typeof PiClassifier>[0]> = {},
) {
  return new PiClassifier({
    kind: "llama",
    model: "clef",
    baseUrl: "http://llama:8080/v1",
    ...spec,
    classifyFns: { llama, openai },
  });
}

describe("PiClassifier", () => {
  it("routes to the backend's pi-ai API and returns its answers", async () => {
    const llama = fakeFn({
      results: [
        result({ team: { type: "choice", choice: "A", probabilities: { A: 1 }, confidence: 0.9 } }),
      ],
    });
    const openai = fakeFn({ results: [] });
    const classifier = classifierWith(llama.fn, openai.fn, {
      apiKey: "sekrit",
      timeoutSeconds: 30,
    });
    const answers = await classifier.classify({ key: "PROJ-1" }, { team: QUESTION });
    expect(answers.team).toMatchObject({ type: "choice", choice: "A" });
    expect(llama.calls.length).toBe(1);
    expect(openai.calls.length).toBe(0);
    const call = llama.calls[0] as {
      model: { api: string; baseUrl: string };
      context: { state: unknown; questions: unknown };
    };
    expect(call.model.api).toBe("typesafe-system-one");
    expect(call.model.baseUrl).toBe("http://llama:8080/v1");
    expect(call.context.state).toEqual({ key: "PROJ-1" });
    expect(call.context.questions).toEqual({ team: QUESTION });
  });

  it("the openai backend selects the decisions API", async () => {
    const llama = fakeFn({ results: [result({})] });
    const openai = fakeFn({ results: [result({})] });
    const classifier = new PiClassifier({
      kind: "openai",
      model: "gpt-6-luna",
      baseUrl: "https://api.openai.com/v1",
      classifyFns: { llama: llama.fn, openai: openai.fn },
    });
    await classifier.classify({}, {});
    const call = openai.calls[0] as { model: { api: string; provider: string } };
    expect(call.model.api).toBe("openai-decisions");
    expect(call.model.provider).toBe("openai");
  });

  it("passes the API key, timeout, and single attempt", async () => {
    const fn = fakeFn({ results: [result({})] });
    const classifier = classifierWith(fn.fn, fn.fn, { apiKey: "sekrit", timeoutSeconds: 30 });
    await classifier.classify({}, {});
    const options = fn.calls[0].options as {
      apiKey?: string;
      timeoutMs?: number;
      maxRetries?: number;
    };
    expect(options.apiKey).toBe("sekrit");
    expect(options.timeoutMs).toBe(30_000);
    expect(options.maxRetries).toBe(0);
  });

  it("without a key: placeholder key with the auth header suppressed", async () => {
    const fn = fakeFn({ results: [result({})] });
    const classifier = classifierWith(fn.fn, fn.fn);
    await classifier.classify({}, {});
    const options = fn.calls[0].options as {
      apiKey?: string;
      headers?: Record<string, null>;
    };
    expect(options.apiKey).toBe("triager-local");
    expect(options.headers).toEqual({ authorization: null });
  });

  it("a non-stop result raises with a redacted message", async () => {
    registerSecrets("http://sekret-host");
    const scripted = result({}, "error");
    scripted.errorMessage = "fetch failed for http://sekret-host/v1/systemone";
    const fn = fakeFn({ results: [scripted] });
    const classifier = classifierWith(fn.fn, fn.fn);
    await expect(classifier.classify({}, {})).rejects.toThrow("[REDACTED]/v1/systemone");
    resetSecrets();
  });

  it("a thrown transport error becomes a category-only failure", async () => {
    const fn = fakeFn({ error: new Error("fetch failed http://elsewhere") });
    const classifier = classifierWith(fn.fn, fn.fn);
    await expect(classifier.classify({}, {})).rejects.toThrow("classify request failed");
  });
});

describe("buildClassifier wiring", () => {
  it("wires the config fields", async () => {
    const fn = fakeFn({ results: [result({})] });
    const config = loadConfig(
      { CLASSIFIER_API_KEY: "sk-x" },
      {
        yamlText: `${REQUIRED_YAML_NO_CLASSIFIER}classifier:\n  backend: openai\n  model: my-model\n  base_url: https://api.openai.com/v1\n`,
      },
    );
    const classifier = new PiClassifier({
      kind: config.classifierBackend,
      model: config.classifierModel,
      baseUrl: config.classifierBaseUrl,
      apiKey: config.classifierApiKey === "" ? undefined : config.classifierApiKey,
      timeoutSeconds: config.classifierTimeoutSeconds,
      classifyFns: { llama: fn.fn, openai: fn.fn },
    });
    await classifier.classify({}, {});
    const call = fn.calls[0] as { model: { id: string }; options: { apiKey?: string } };
    expect(call.model.id).toBe("my-model");
    expect(call.options.apiKey).toBe("sk-x");
  });
});
