import { describe, expect, it } from "vitest";
import { Effect, Either, Fiber, Ref, TestClock, TestContext } from "effect";
import {
  applyLinearPolicy,
  LinearNetworkError,
  LinearNotFound,
  LinearRateLimited,
  LinearTimeout,
  LinearUnauthorized,
  type LinearError,
} from "./linear.js";
import {
  applyGithubPolicy,
  GithubTimeout,
  PrCreateFailed,
  PushFailed,
  type GithubError,
} from "./github.js";

// ---------------------------------------------------------------------------
// VA-357 — Schedule-based retries + timeouts on gateway calls
//
// All tests use Effect's `TestClock` so retry timing is deterministic.
// The retry schedule is `Schedule.exponential("1 second").pipe(
//   Schedule.compose(Schedule.recurs(5)), Schedule.jittered )` —
// 5 retries (6 attempts total), worst-case ~31s of cumulative delay
// (jittered from the base 1/2/4/8/16s sequence). We advance the clock
// past that horizon to let every retry fire, then assert the resulting
// attempt count and final error.
// ---------------------------------------------------------------------------

describe("applyLinearPolicy retry behavior (VA-357)", () => {
  it("retries up to 5 times on LinearNetworkError, then surfaces the last failure", async () => {
    const program = Effect.gen(function* () {
      const counter = yield* Ref.make(0);
      const target: Effect.Effect<never, LinearError> = Effect.gen(
        function* () {
          yield* Ref.update(counter, (n) => n + 1);
          return yield* Effect.fail(
            new LinearNetworkError({ cause: null, message: "boom" }),
          );
        },
      );
      const wrapped = applyLinearPolicy(target, { call: "test" });
      const fiber = yield* Effect.fork(wrapped.pipe(Effect.either));
      // 5 retries with base 1s exponential + jitter → max ~46s wall
      // time. 120s is well past that.
      yield* TestClock.adjust("120 seconds");
      const result = yield* Fiber.join(fiber);
      const attempts = yield* Ref.get(counter);
      return { result, attempts };
    }).pipe(Effect.provide(TestContext.TestContext));

    const { result, attempts } = await Effect.runPromise(program);
    expect(attempts).toBe(6); // 1 initial + 5 retries
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("LinearNetworkError");
    }
  });

  it("does NOT retry LinearNotFound — operator-fix errors fail fast", async () => {
    const program = Effect.gen(function* () {
      const counter = yield* Ref.make(0);
      const target: Effect.Effect<never, LinearError> = Effect.gen(
        function* () {
          yield* Ref.update(counter, (n) => n + 1);
          return yield* Effect.fail(
            new LinearNotFound({
              resource: "team",
              identifier: "VA",
              message: "team not found",
            }),
          );
        },
      );
      const fiber = yield* Effect.fork(
        applyLinearPolicy(target, { call: "test" }).pipe(Effect.either),
      );
      yield* TestClock.adjust("120 seconds");
      const result = yield* Fiber.join(fiber);
      const attempts = yield* Ref.get(counter);
      return { result, attempts };
    }).pipe(Effect.provide(TestContext.TestContext));

    const { result, attempts } = await Effect.runPromise(program);
    expect(attempts).toBe(1);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("LinearNotFound");
    }
  });

  it("does NOT retry LinearUnauthorized", async () => {
    const program = Effect.gen(function* () {
      const counter = yield* Ref.make(0);
      const target: Effect.Effect<never, LinearError> = Effect.gen(
        function* () {
          yield* Ref.update(counter, (n) => n + 1);
          return yield* Effect.fail(
            new LinearUnauthorized({ message: "invalid api key" }),
          );
        },
      );
      const fiber = yield* Effect.fork(
        applyLinearPolicy(target, { call: "test" }).pipe(Effect.either),
      );
      yield* TestClock.adjust("120 seconds");
      const result = yield* Fiber.join(fiber);
      const attempts = yield* Ref.get(counter);
      return { result, attempts };
    }).pipe(Effect.provide(TestContext.TestContext));

    const { result, attempts } = await Effect.runPromise(program);
    expect(attempts).toBe(1);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("LinearUnauthorized");
    }
  });

  it("retries LinearRateLimited (transient throttle)", async () => {
    const program = Effect.gen(function* () {
      const counter = yield* Ref.make(0);
      const target: Effect.Effect<never, LinearError> = Effect.gen(
        function* () {
          yield* Ref.update(counter, (n) => n + 1);
          return yield* Effect.fail(
            new LinearRateLimited({ message: "429 rate limited" }),
          );
        },
      );
      const fiber = yield* Effect.fork(
        applyLinearPolicy(target, { call: "test" }).pipe(Effect.either),
      );
      yield* TestClock.adjust("120 seconds");
      const result = yield* Fiber.join(fiber);
      const attempts = yield* Ref.get(counter);
      return { result, attempts };
    }).pipe(Effect.provide(TestContext.TestContext));

    const { result, attempts } = await Effect.runPromise(program);
    expect(attempts).toBe(6);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("LinearRateLimited");
    }
  });

  it("succeeds after a transient failure, returning the successful value", async () => {
    const program = Effect.gen(function* () {
      const counter = yield* Ref.make(0);
      const target = Effect.gen(function* () {
        const n = yield* Ref.updateAndGet(counter, (n) => n + 1);
        if (n < 3) {
          return yield* Effect.fail(
            new LinearNetworkError({ cause: null, message: "transient" }),
          );
        }
        return "ok" as const;
      });
      const fiber = yield* Effect.fork(
        applyLinearPolicy(target, { call: "test" }),
      );
      yield* TestClock.adjust("120 seconds");
      const result = yield* Fiber.join(fiber);
      const attempts = yield* Ref.get(counter);
      return { result, attempts };
    }).pipe(Effect.provide(TestContext.TestContext));

    const { result, attempts } = await Effect.runPromise(program);
    expect(attempts).toBe(3); // 2 failures + 1 success
    expect(result).toBe("ok");
  });

  it("converts a stuck Effect into LinearTimeout via timeoutFail (retried, then bubbles up)", async () => {
    const program = Effect.gen(function* () {
      // `Effect.never` never resolves — without a timeout this would
      // hang forever; the policy must surface it as LinearTimeout
      // after `timeoutMs`. Then the retry policy re-attempts because
      // LinearTimeout is in the retryable set.
      const stuck = Effect.never as Effect.Effect<never, LinearError>;
      const fiber = yield* Effect.fork(
        applyLinearPolicy(stuck, { call: "test", timeoutMs: 5_000 }).pipe(
          Effect.either,
        ),
      );
      // 6 attempts × 5s timeout = 30s + ~31s of jittered delays.
      // 120s is well past that.
      yield* TestClock.adjust("120 seconds");
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestContext.TestContext));

    const result = await Effect.runPromise(program);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("LinearTimeout");
      const tag = result.left as LinearTimeout;
      expect(tag.afterMs).toBe(5_000);
      expect(tag.call).toBe("test");
    }
  });
});

describe("applyGithubPolicy retry behavior (VA-357)", () => {
  it("pushBranch retries on GithubTimeout (push is idempotent)", async () => {
    const program = Effect.gen(function* () {
      const counter = yield* Ref.make(0);
      // Simulate pushBranch: Effect.never inside, wrapped with the push
      // policy (60s timeout, retry on timeout).
      const stuck = Effect.gen(function* () {
        yield* Ref.update(counter, (n) => n + 1);
        return yield* (Effect.never as Effect.Effect<never, GithubError>);
      });
      const wrapped = applyGithubPolicy(stuck, {
        call: "pushBranch(test)",
        timeoutMs: 5_000,
        retryOn: (err) => err._tag === "GithubTimeout",
      });
      const fiber = yield* Effect.fork(wrapped.pipe(Effect.either));
      yield* TestClock.adjust("240 seconds");
      const result = yield* Fiber.join(fiber);
      const attempts = yield* Ref.get(counter);
      return { result, attempts };
    }).pipe(Effect.provide(TestContext.TestContext));

    const { result, attempts } = await Effect.runPromise(program);
    expect(attempts).toBe(6); // 1 + 5 retries
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("GithubTimeout");
    }
  });

  it("pushBranch does NOT retry PushFailed (real failure, not transient)", async () => {
    const program = Effect.gen(function* () {
      const counter = yield* Ref.make(0);
      const target: Effect.Effect<never, GithubError> = Effect.gen(
        function* () {
          yield* Ref.update(counter, (n) => n + 1);
          return yield* Effect.fail(
            new PushFailed({
              branch: "agent/va-1",
              stderr: "non-fast-forward",
              message: "push failed",
            }),
          );
        },
      );
      const wrapped = applyGithubPolicy(target, {
        call: "pushBranch(agent/va-1)",
        timeoutMs: 60_000,
        retryOn: (err) => err._tag === "GithubTimeout",
      });
      const fiber = yield* Effect.fork(wrapped.pipe(Effect.either));
      yield* TestClock.adjust("120 seconds");
      const result = yield* Fiber.join(fiber);
      const attempts = yield* Ref.get(counter);
      return { result, attempts };
    }).pipe(Effect.provide(TestContext.TestContext));

    const { result, attempts } = await Effect.runPromise(program);
    expect(attempts).toBe(1);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("PushFailed");
    }
  });

  it("openPullRequest does NOT retry on any error (gh pr create is not idempotent)", async () => {
    const program = Effect.gen(function* () {
      const counter = yield* Ref.make(0);
      const target: Effect.Effect<never, GithubError> = Effect.gen(
        function* () {
          yield* Ref.update(counter, (n) => n + 1);
          return yield* Effect.fail(
            new PrCreateFailed({
              branch: "agent/va-1",
              stderr: "network blip",
              message: "gh pr create failed",
            }),
          );
        },
      );
      // No retryOn → timeout-only, never retries.
      const wrapped = applyGithubPolicy(target, {
        call: "openPullRequest(agent/va-1)",
        timeoutMs: 30_000,
      });
      const fiber = yield* Effect.fork(wrapped.pipe(Effect.either));
      yield* TestClock.adjust("120 seconds");
      const result = yield* Fiber.join(fiber);
      const attempts = yield* Ref.get(counter);
      return { result, attempts };
    }).pipe(Effect.provide(TestContext.TestContext));

    const { result, attempts } = await Effect.runPromise(program);
    expect(attempts).toBe(1);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("PrCreateFailed");
    }
  });

  it("openPullRequest still produces GithubTimeout on stuck Effects (no retry, just bound)", async () => {
    const program = Effect.gen(function* () {
      const stuck = Effect.never as Effect.Effect<never, GithubError>;
      const wrapped = applyGithubPolicy(stuck, {
        call: "openPullRequest(test)",
        timeoutMs: 30_000,
      });
      const fiber = yield* Effect.fork(wrapped.pipe(Effect.either));
      yield* TestClock.adjust("60 seconds");
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestContext.TestContext));

    const result = await Effect.runPromise(program);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("GithubTimeout");
      expect((result.left as GithubTimeout).afterMs).toBe(30_000);
    }
  });
});

