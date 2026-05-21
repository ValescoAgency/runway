import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type {
  PlannerActionStatus,
  RecommendationStatus,
} from "./dashboard/storage.js";
import type { PlannerReadClient } from "./planner-storage.js";

/**
 * VA-475: planner HTTP API (ADR 0004 § HTTP API surface). Six
 * endpoints on `RUNWAY_PLANNER_HOST:RUNWAY_PLANNER_PORT`,
 * Tailscale-ACL-gated by binding the listener to a tailnet IP. No
 * application-layer auth — the network layer does the auth job.
 *
 * GET  /planner/health                                 → liveness probe
 * GET  /planner/recommendations?status=…&limit=N       → list
 * GET  /planner/recommendations/:id                    → single
 * POST /planner/recommendations/:id/accept             → emit accepted
 * POST /planner/recommendations/:id/reject             → emit rejected
 * GET  /planner/actions?status=…                       → list actions
 *
 * Writes go through OTLP emit (which projects back into SQLite via
 * the dashboard's VA-474 projector); the planner never writes
 * SQLite. Read-after-write is eventual — clients should refetch
 * after POSTing rather than relying on the response payload
 * reflecting the new state.
 */

export interface PlannerHealth {
  readonly uptimeSeconds: number;
  readonly tickCount: number;
  readonly lastTickAtUnixMs: number | null;
  readonly version: string;
}

export interface DecisionEmitter {
  readonly emitAccepted: (input: {
    readonly recommendationId: string;
    readonly source: "operator";
    readonly reason: string | null;
    readonly timestampUnixNano: string;
  }) => void;
  readonly emitRejected: (input: {
    readonly recommendationId: string;
    readonly source: "operator";
    readonly reason: string;
    readonly timestampUnixNano: string;
  }) => void;
}

export interface PlannerHttpDeps {
  readonly host: string;
  readonly port: number;
  /**
   * Read-only SQLite client wrapping the dashboard's
   * `planner_recommendations` / `planner_actions` tables. May be
   * `null` if `RUNWAY_PLANNER_SQLITE_PATH` was unset at boot — in
   * that case all GET endpoints that read SQLite return 503 with
   * `planner_sqlite_not_configured`.
   */
  readonly readClient: PlannerReadClient | null;
  readonly getHealth: () => PlannerHealth;
  readonly emitter: DecisionEmitter;
}

export interface RunningPlannerHttpServer {
  readonly server: Server;
  readonly port: number;
  readonly close: () => Promise<void>;
}

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB — request payloads are tiny JSON objects.

const RECOMMENDATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export async function startPlannerHttpServer(
  deps: PlannerHttpDeps,
): Promise<RunningPlannerHttpServer> {
  const server = createServer((req, res) => {
    handle(req, res, deps).catch((err) => {
      writeError(res, 500, "internal_error", asMessage(err));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.port, deps.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort = addr && typeof addr === "object" ? addr.port : deps.port;

  return {
    server,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PlannerHttpDeps,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";
  // Parse URL — keep it small, no router framework.
  const [pathRaw, queryRaw = ""] = url.split("?", 2);
  const path = pathRaw ?? "/";

  // VA-475 § Scope: same-origin-only CORS. The planner has no
  // browser UI of its own — the dashboard at a different origin
  // proxies through its own backend to reach us. Cross-origin
  // browser requests are rejected at the listener boundary so the
  // Tailscale-ACL-gated surface stays tight. Non-browser callers
  // (curl, the dashboard's backend) never send an Origin header
  // and pass through unchanged.
  if (!isSameOrigin(req)) {
    writeError(
      res,
      403,
      "cross_origin_blocked",
      "planner API is same-origin only; cross-origin browser requests are not supported. Proxy through the dashboard's backend.",
    );
    return;
  }
  // Browser CORS preflight against the same origin is unusual but
  // valid (e.g., custom headers). Respond 204; no Access-Control-*
  // headers needed for same-origin.
  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (method === "GET" && path === "/planner/health") {
    writeJson(res, 200, deps.getHealth());
    return;
  }

  if (method === "GET" && path === "/planner/recommendations") {
    if (!deps.readClient) {
      writeError(
        res,
        503,
        "planner_sqlite_not_configured",
        "Set RUNWAY_PLANNER_SQLITE_PATH to the dashboard's SQLite file path so the planner can read recommendations.",
      );
      return;
    }
    const params = new URLSearchParams(queryRaw);
    const status = parseRecommendationStatusFilter(params.get("status"));
    const limit = parseLimit(params.get("limit"), 50);
    if (status === "invalid" || limit === "invalid") {
      writeError(
        res,
        400,
        "invalid_query",
        "status must be one of proposed|accepted|rejected|all; limit must be a positive integer ≤ 250.",
      );
      return;
    }
    const rows = deps.readClient.getRecentRecommendations({
      status,
      limit,
    });
    writeJson(res, 200, { recommendations: rows });
    return;
  }

  const recDetailMatch = path.match(
    /^\/planner\/recommendations\/([^/]+)$/,
  );
  if (method === "GET" && recDetailMatch) {
    if (!deps.readClient) {
      writeError(
        res,
        503,
        "planner_sqlite_not_configured",
        "Set RUNWAY_PLANNER_SQLITE_PATH to read this resource.",
      );
      return;
    }
    const id = decodeURIComponent(recDetailMatch[1] ?? "");
    if (!RECOMMENDATION_ID_PATTERN.test(id)) {
      writeError(res, 400, "invalid_id", "recommendation id is not a valid identifier");
      return;
    }
    const row = deps.readClient.getRecommendation(id);
    if (!row) {
      writeError(res, 404, "not_found", `no recommendation with id=${id}`);
      return;
    }
    writeJson(res, 200, row);
    return;
  }

  const recAcceptMatch = path.match(
    /^\/planner\/recommendations\/([^/]+)\/accept$/,
  );
  if (method === "POST" && recAcceptMatch) {
    const id = decodeURIComponent(recAcceptMatch[1] ?? "");
    if (!RECOMMENDATION_ID_PATTERN.test(id)) {
      writeError(res, 400, "invalid_id", "recommendation id is not a valid identifier");
      return;
    }
    const body = await parseDecisionBody(req, res);
    if (body === "error") return;

    // When the planner has a SQLite read client, do an existence
    // pre-check so the operator gets immediate 404/409 feedback. When
    // unset, the planner still emits the OTLP event — the dashboard's
    // projector will validate against its own SQLite on receive.
    if (deps.readClient) {
      const existing = deps.readClient.getRecommendation(id);
      if (!existing) {
        writeError(res, 404, "not_found", `no recommendation with id=${id}`);
        return;
      }
      if (existing.status !== "proposed") {
        writeError(
          res,
          409,
          "already_decided",
          `recommendation ${id} is already ${existing.status}`,
        );
        return;
      }
    }
    deps.emitter.emitAccepted({
      recommendationId: id,
      source: "operator",
      reason: body.reason,
      timestampUnixNano: nowUnixNano(),
    });
    // 202 communicates "we got it; the projection happens
    // asynchronously". A subsequent GET may briefly return the old
    // status — see ADR 0004 § Writer model on the read-after-write
    // gap.
    writeJson(res, 202, { recommendationId: id, status: "accepted" });
    return;
  }

  const recRejectMatch = path.match(
    /^\/planner\/recommendations\/([^/]+)\/reject$/,
  );
  if (method === "POST" && recRejectMatch) {
    const id = decodeURIComponent(recRejectMatch[1] ?? "");
    if (!RECOMMENDATION_ID_PATTERN.test(id)) {
      writeError(res, 400, "invalid_id", "recommendation id is not a valid identifier");
      return;
    }
    const body = await parseDecisionBody(req, res);
    if (body === "error") return;
    if (!body.reason) {
      writeError(
        res,
        400,
        "missing_reason",
        "reject requires a non-empty `reason` so the audit log carries motivation.",
      );
      return;
    }
    if (deps.readClient) {
      const existing = deps.readClient.getRecommendation(id);
      if (!existing) {
        writeError(res, 404, "not_found", `no recommendation with id=${id}`);
        return;
      }
      if (existing.status !== "proposed") {
        writeError(
          res,
          409,
          "already_decided",
          `recommendation ${id} is already ${existing.status}`,
        );
        return;
      }
    }
    deps.emitter.emitRejected({
      recommendationId: id,
      source: "operator",
      reason: body.reason,
      timestampUnixNano: nowUnixNano(),
    });
    writeJson(res, 202, { recommendationId: id, status: "rejected" });
    return;
  }

  if (method === "GET" && path === "/planner/actions") {
    if (!deps.readClient) {
      writeError(
        res,
        503,
        "planner_sqlite_not_configured",
        "Set RUNWAY_PLANNER_SQLITE_PATH to read this resource.",
      );
      return;
    }
    const params = new URLSearchParams(queryRaw);
    const statusParam = params.get("status");
    const status =
      statusParam === null || statusParam === "all"
        ? "all"
        : isPlannerActionStatus(statusParam)
          ? statusParam
          : "invalid";
    if (status === "invalid") {
      writeError(
        res,
        400,
        "invalid_query",
        "status must be one of started|completed|failed|all.",
      );
      return;
    }
    const rows = deps.readClient.getActions({ status });
    writeJson(res, 200, { actions: rows });
    return;
  }

  writeError(res, 404, "not_found", `no route for ${method} ${path}`);
}

interface DecisionBody {
  readonly reason: string | null;
}

async function parseDecisionBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<DecisionBody | "error"> {
  // The body is optional for /accept and required (with `reason`) for
  // /reject. Empty body is fine — clients can send no Content-Type
  // and no body at all.
  const ct = (req.headers["content-type"] ?? "").toString().toLowerCase();
  const body = await readBody(req);
  if (body === undefined) {
    writeError(
      res,
      413,
      "payload_too_large",
      `body exceeds ${MAX_BODY_BYTES} bytes`,
    );
    return "error";
  }
  if (body.length === 0) {
    return { reason: null };
  }
  if (!ct.includes("application/json")) {
    writeError(
      res,
      415,
      "unsupported_media_type",
      "POST body must be application/json",
    );
    return "error";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    writeError(res, 400, "invalid_json", asMessage(err));
    return "error";
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const reason = (parsed as { reason?: unknown }).reason;
    if (reason === undefined || reason === null) return { reason: null };
    if (typeof reason !== "string") {
      writeError(res, 400, "invalid_body", "reason must be a string");
      return "error";
    }
    return { reason: reason.trim().length === 0 ? null : reason.trim() };
  }
  writeError(res, 400, "invalid_body", "body must be a JSON object");
  return "error";
}

function parseRecommendationStatusFilter(
  raw: string | null,
):
  | RecommendationStatus
  | "all"
  | "invalid" {
  if (raw === null || raw === "all") return "all";
  if (raw === "proposed" || raw === "accepted" || raw === "rejected") return raw;
  return "invalid";
}

function parseLimit(raw: string | null, fallback: number): number | "invalid" {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 250) return "invalid";
  return n;
}

function isPlannerActionStatus(s: string): s is PlannerActionStatus {
  return s === "started" || s === "completed" || s === "failed";
}

/**
 * VA-475: same-origin check. Returns true when the request either
 * has no `Origin` header (non-browser caller) or has an `Origin`
 * whose host:port matches the request's `Host` header. Cross-origin
 * browser requests fail closed. Comparison is case-insensitive and
 * tolerates the standard browser quirks (no trailing slash on
 * Origin, port-stripped Host on standard ports).
 */
function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin.length === 0) return true;
  const host = req.headers.host;
  if (typeof host !== "string" || host.length === 0) return false;
  let originHost: string;
  try {
    const url = new URL(origin);
    originHost = url.host.toLowerCase();
  } catch {
    return false;
  }
  return originHost === host.toLowerCase();
}

function nowUnixNano(): string {
  return String(Date.now() * 1_000_000);
}

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > MAX_BODY_BYTES) return undefined;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function writeError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  writeJson(res, status, { error: { code, message } });
}

function asMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}
