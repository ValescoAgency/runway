import Anthropic from "@anthropic-ai/sdk";
import { Data, Effect, Schedule } from "effect";
import {
  type DrainReview,
  type ReportParseResult,
  type RunReview,
  parseDrainReview,
  parseRunReview,
} from "./templates.js";

/**
 * VA-402: Anthropic SDK wrapper for the IRA passes. Mirrors the
 * `applyLinearPolicy` / `applyGithubPolicy` shape — a tagged error
 * ADT plus a jittered-exponential retry schedule gated on the
 * retryable tags. The Run Review pass calls one model + parses one
 * structured response per invocation; tying that to the same Effect
 * patterns the rest of runway uses means failures look identical to
 * an operator: a typed error, a retry count, a final state.
 *
 * The structured-output contract is the `runway-run-review` fenced
 * JSON block defined in `meta/templates.ts`. The LLM is instructed
 * (by the pass-level prompt) to emit nothing but that block plus an
 * optional preamble; we parse with the same version-handshake
 * machinery as the in-sandcastle reports for consistency.
 */

// ---------------------------------------------------------------------------
// Error ADT
// ---------------------------------------------------------------------------

export class AnthropicNetworkError extends Data.TaggedError(
  "AnthropicNetworkError",
)<{ readonly message: string }> {}

export class AnthropicRateLimited extends Data.TaggedError(
  "AnthropicRateLimited",
)<{ readonly message: string }> {}

export class AnthropicTimeout extends Data.TaggedError("AnthropicTimeout")<{
  readonly afterMs: number;
  readonly message: string;
}> {}

export class AnthropicUnauthorized extends Data.TaggedError(
  "AnthropicUnauthorized",
)<{ readonly message: string }> {}

export class AnthropicBadRequest extends Data.TaggedError(
  "AnthropicBadRequest",
)<{ readonly message: string }> {}

export class AnthropicServerError extends Data.TaggedError(
  "AnthropicServerError",
)<{ readonly status: number; readonly message: string }> {}

export class AnthropicEmptyResponse extends Data.TaggedError(
  "AnthropicEmptyResponse",
)<{ readonly message: string }> {}

export type AnthropicError =
  | AnthropicNetworkError
  | AnthropicRateLimited
  | AnthropicTimeout
  | AnthropicUnauthorized
  | AnthropicBadRequest
  | AnthropicServerError
  | AnthropicEmptyResponse;

const RETRYABLE_ANTHROPIC_TAGS = new Set<AnthropicError["_tag"]>([
  "AnthropicNetworkError",
  "AnthropicRateLimited",
  "AnthropicTimeout",
  "AnthropicServerError",
  "AnthropicEmptyResponse",
]);

const isRetryableAnthropicError = (err: AnthropicError): boolean =>
  RETRYABLE_ANTHROPIC_TAGS.has(err._tag);

/**
 * VA-402: 1 retry on a 1s base, jittered → ~1–2s extra worst-case
 * before bubbling out. Mirrors the per-pass retry budget the PRD
 * spells out for Run / Drain reviews (single retry, then stub).
 * Weekly Review (VA-408) will use a heavier schedule because that
 * one's the only loud-failure pass.
 */
export const anthropicRetrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.compose(Schedule.recurs(1)),
  Schedule.jittered,
);

export const applyAnthropicPolicy = <A>(
  effect: Effect.Effect<A, AnthropicError>,
  opts: { call: string; timeoutMs?: number },
): Effect.Effect<A, AnthropicError> => {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return effect.pipe(
    Effect.timeoutFail({
      duration: `${timeoutMs} millis`,
      onTimeout: () =>
        new AnthropicTimeout({
          afterMs: timeoutMs,
          message: `Anthropic ${opts.call} timed out after ${timeoutMs}ms`,
        }),
    }),
    Effect.retry({
      schedule: anthropicRetrySchedule,
      while: isRetryableAnthropicError,
    }),
  );
};

// ---------------------------------------------------------------------------
// Structured-output call: ask the IRA for a Run Review
// ---------------------------------------------------------------------------

export interface RunReviewLlmArgs {
  readonly apiKey: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  /** Optional override; defaults to 4096 — enough for a structured Review. */
  readonly maxTokens?: number;
}

/**
 * One Run Review LLM round-trip. Returns the structured `RunReview`
 * parsed off the model's response, or the parse error tag if the
 * model produced a malformed payload. Distinct from a network /
 * rate-limit / timeout error (those land in the `AnthropicError`
 * channel and get retried). A parse error is NOT retryable — the
 * model said something we don't understand, retrying with the same
 * prompt would say it again.
 */
export const callRunReview = (
  args: RunReviewLlmArgs,
): Effect.Effect<ReportParseResult<RunReview>, AnthropicError> =>
  Effect.gen(function* () {
    const client = new Anthropic({ apiKey: args.apiKey });
    const text = yield* applyAnthropicPolicy(
      Effect.tryPromise({
        try: async () => {
          const res = await client.messages.create({
            model: args.model,
            max_tokens: args.maxTokens ?? 4096,
            system: args.systemPrompt,
            messages: [{ role: "user", content: args.userPrompt }],
          });
          return collectText(res.content);
        },
        catch: (err) => classifyAnthropicError(err),
      }),
      { call: "messages.create(run-review)" },
    );
    return parseRunReview(text);
  });

/**
 * VA-406: one Drain Review LLM round-trip. Same shape as
 * `callRunReview` — the Anthropic call + retry policy + structured
 * parse are identical, only the parser differs. Kept as a separate
 * function (rather than parameterizing `callRunReview`) so the LLM
 * span name stays distinct in the OTel trace and the per-pass error
 * paths can fork cleanly. Default max_tokens is bumped to 6144 because
 * Drain Reviews summarise N issue processes plus cross-issue patterns
 * — the payload is correspondingly larger than a single Run Review.
 */
export const callDrainReview = (
  args: RunReviewLlmArgs,
): Effect.Effect<ReportParseResult<DrainReview>, AnthropicError> =>
  Effect.gen(function* () {
    const client = new Anthropic({ apiKey: args.apiKey });
    const text = yield* applyAnthropicPolicy(
      Effect.tryPromise({
        try: async () => {
          const res = await client.messages.create({
            model: args.model,
            max_tokens: args.maxTokens ?? 6144,
            system: args.systemPrompt,
            messages: [{ role: "user", content: args.userPrompt }],
          });
          return collectText(res.content);
        },
        catch: (err) => classifyAnthropicError(err),
      }),
      { call: "messages.create(drain-review)" },
    );
    return parseDrainReview(text);
  });

// ---------------------------------------------------------------------------
// Internals — error classification + content extraction
// ---------------------------------------------------------------------------

/**
 * Collect the agent's text response from the Anthropic content
 * array. Tool-use blocks and other non-text content are ignored —
 * the Run Review prompt instructs the model to emit a single
 * fenced JSON block, so a multi-block response is treated as
 * concatenated text.
 */
function collectText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  return parts.join("\n");
}

/**
 * Best-effort classification of SDK throws into our typed error ADT.
 * Anthropic's SDK throws `APIError` subclasses with a numeric
 * `status` and a string `message`; older shapes that don't expose
 * those get bucketed as NetworkError so the retry schedule still
 * kicks in.
 */
function classifyAnthropicError(err: unknown): AnthropicError {
  const e = err as {
    status?: number;
    message?: string;
    name?: string;
  };
  const status = typeof e.status === "number" ? e.status : 0;
  const message = e.message ?? String(err);

  if (status === 401 || status === 403) {
    return new AnthropicUnauthorized({ message });
  }
  if (status === 429) {
    return new AnthropicRateLimited({ message });
  }
  if (status >= 400 && status < 500) {
    return new AnthropicBadRequest({ message });
  }
  if (status >= 500) {
    return new AnthropicServerError({ status, message });
  }
  return new AnthropicNetworkError({ message });
}
