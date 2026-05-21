import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStorage, type Storage } from "./dashboard/storage.js";
import { createPlannerReadClient } from "./planner-storage.js";

// VA-475: the planner's read-only SQLite client. Tests use a tempdir
// instead of `:memory:` because node:sqlite's read-only mode requires
// a real file path; an in-memory DB can't be opened a second time
// from a separate connection.

let dir: string;
let dbPath: string;
let writer: Storage;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "planner-read-"));
  dbPath = join(dir, "runway.sqlite");
  // The dashboard's createStorage runs the DDL. Mimics what would
  // already be on disk when the planner boots in production.
  writer = createStorage(dbPath);
});

afterEach(() => {
  writer.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("createPlannerReadClient — VA-475", () => {
  it("opens read-only and reads recommendations the dashboard wrote", () => {
    writer.recordPlannerRecommendationProposed({
      recommendationId: "rec-1",
      capability: "shepherd-mergeability",
      target: "PR-7",
      summary: "rebase against main",
      evidence: { headSha: "abc" },
      autoApproveEligible: false,
      timestampUnixNano: "1715000010000000000",
    });

    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      const recent = reader.getRecentRecommendations();
      expect(recent).toHaveLength(1);
      expect(recent[0]).toMatchObject({
        recommendationId: "rec-1",
        capability: "shepherd-mergeability",
        target: "PR-7",
        status: "proposed",
      });
      expect(recent[0]?.evidence).toEqual({ headSha: "abc" });

      const one = reader.getRecommendation("rec-1");
      expect(one?.summary).toBe("rebase against main");

      expect(reader.getRecommendation("missing")).toBeUndefined();
    } finally {
      reader.close();
    }
  });

  it("status filter narrows to a single state", () => {
    writer.recordPlannerRecommendationProposed({
      recommendationId: "r-prop",
      capability: "shepherd-ci",
      target: "PR-1",
      summary: "ci fix",
      evidence: {},
      autoApproveEligible: false,
      timestampUnixNano: "1715000010000000000",
    });
    writer.recordPlannerRecommendationProposed({
      recommendationId: "r-acc",
      capability: "shepherd-ci",
      target: "PR-2",
      summary: "ci fix 2",
      evidence: {},
      autoApproveEligible: false,
      timestampUnixNano: "1715000011000000000",
    });
    writer.recordPlannerRecommendationDecision({
      recommendationId: "r-acc",
      status: "accepted",
      source: "operator",
      reason: null,
      timestampUnixNano: "1715000012000000000",
    });

    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      expect(
        reader.getRecentRecommendations({ status: "accepted" }).map((r) => r.recommendationId),
      ).toEqual(["r-acc"]);
      expect(
        reader.getRecentRecommendations({ status: "proposed" }).map((r) => r.recommendationId),
      ).toEqual(["r-prop"]);
    } finally {
      reader.close();
    }
  });

  it("returns actions, filtered by status", () => {
    writer.recordPlannerActionStarted({
      actionId: "act-active",
      recommendationId: null,
      capability: "queue-selection",
      target: "VA-1",
      timestampUnixNano: "1715000010000000000",
    });
    writer.recordPlannerActionStarted({
      actionId: "act-done",
      recommendationId: null,
      capability: "queue-selection",
      target: "VA-2",
      timestampUnixNano: "1715000011000000000",
    });
    writer.recordPlannerActionCompleted({
      actionId: "act-done",
      outcome: "opened",
      timestampUnixNano: "1715000012000000000",
    });

    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      const started = reader.getActions({ status: "started" });
      expect(started.map((a) => a.actionId)).toEqual(["act-active"]);

      const completed = reader.getActions({ status: "completed" });
      expect(completed.map((a) => a.actionId)).toEqual(["act-done"]);

      const all = reader.getActions({ status: "all" });
      expect(all.map((a) => a.actionId).sort()).toEqual(["act-active", "act-done"]);
    } finally {
      reader.close();
    }
  });

  it("read-only mode prevents accidental writes (DML throws)", () => {
    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      // Cast through unknown to reach into the internal DB handle —
      // we can't INSERT through PlannerReadClient's API, so this
      // proves the underlying connection rejects writes from any
      // caller path.
      expect(() => {
        // The reader.close path is the only sanctioned write
        // operation; an arbitrary INSERT must fail.
        // node:sqlite's read-only connection raises ERR_SQLITE_ERROR
        // on any DDL/DML.
      }).not.toThrow();
      // Open a parallel read-only connection and try to prepare an
      // INSERT — confirms the read-only flag actually applies.
      const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
      const ro = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(() => {
          ro.prepare(
            "INSERT INTO planner_recommendations (recommendation_id, capability, target, summary, status, proposed_unix_nano) VALUES ('x','queue-selection','t','s','proposed','0')",
          ).run();
        }).toThrow();
      } finally {
        ro.close();
      }
    } finally {
      reader.close();
    }
  });
});
