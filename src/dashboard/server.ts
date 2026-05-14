import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { projectPayload } from "./projector.js";
import { createStorage, type Storage } from "./storage.js";
import { renderDetailView, renderListView } from "./views.js";
import type { OtlpTracesPayload } from "./otlp.js";

// VA-389: phase spans we surface on the detail page's timeline.
// Anything else stays in raw_spans for debugging but isn't rendered.
const DETAIL_PHASE_NAMES = ["review", "pushBranch", "openPullRequest"] as const;
const ISSUE_DETAIL_RE = /^\/issue\/([^/?#]+)\/([^/?#]+)\/?$/;

/**
 * VA-386 (dashboard slice 1): the dashboard runs as a single Node HTTP
 * server that fronts both endpoints:
 *
 *   POST /v1/traces  →  OTLP HTTP receiver (JSON encoding); projects
 *                       and persists to SQLite.
 *   GET  /            →  HTML list of issue processes.
 *
 * The OTLP HTTP spec lets the same server host receivers and UI under
 * one port when a reverse-proxy isn't in play. We deliberately keep
 * both on the same listener: docker-compose maps the OTLP port and
 * the dashboard port to the same internal listener, so operators
 * never have to think about which port routes where.
 *
 * Slice-1 caveat (ADR-0002): we use `node:http` directly. The target
 * is @effect/platform HTTP; slice 2 will swap the listener while
 * keeping the projector + storage seams in place.
 */

export interface ServerOptions {
  readonly storage: Storage;
  /** Listening port. Defaults to `OTLP_PORT` (4318). */
  readonly port?: number;
  /** Bind address; defaults to `0.0.0.0` (Docker-friendly). */
  readonly host?: string;
}

export interface RunningServer {
  readonly server: Server;
  readonly port: number;
  readonly close: () => Promise<void>;
}

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MiB — generous; a runway drain is ~kilobytes per emit.

/**
 * Construct a Node HTTP server wired to the given storage. The server
 * is NOT listening yet — call `.listen()` on the returned `server` or
 * use `startServer` for the all-in-one helper.
 */
export function buildServer(storage: Storage): Server {
  return createServer((req, res) => {
    handle(req, res, storage).catch((err) => {
      writeError(res, 500, "internal_error", asMessage(err));
    });
  });
}

/**
 * Bind and start the dashboard server. Returns a handle the caller can
 * use to close it gracefully (used by tests).
 */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const server = buildServer(opts.storage);
  const port = opts.port ?? 4318;
  const host = opts.host ?? "0.0.0.0";

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort =
    addr && typeof addr === "object" ? addr.port : port;

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
  storage: Storage,
): Promise<void> {
  // Route on method + path. Nothing fancy — slice 1 only has two
  // endpoints; a router becomes worth its weight in slice 2.
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  if (method === "POST" && url === "/v1/traces") {
    await handleOtlpTraces(req, res, storage);
    return;
  }

  if (method === "GET" && (url === "/" || url.startsWith("/?"))) {
    handleListView(res, storage);
    return;
  }

  if (method === "GET") {
    const detailMatch = ISSUE_DETAIL_RE.exec(url.split("?")[0] ?? "");
    if (detailMatch) {
      const traceId = decodeURIComponent(detailMatch[1] ?? "");
      const spanId = decodeURIComponent(detailMatch[2] ?? "");
      handleDetailView(res, storage, traceId, spanId);
      return;
    }
  }

  if (method === "GET" && (url === "/api/aggregates" || url.startsWith("/api/aggregates?"))) {
    handleAggregates(res, storage);
    return;
  }

  if (method === "GET" && url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  writeError(res, 404, "not_found", `no route for ${method} ${url}`);
}

/**
 * Read the request body, parse as OTLP HTTP/JSON, project, and
 * persist. Responds with the OTLP success shape (`{ partialSuccess:
 * {} }`) per spec so the SDK exporter doesn't retry.
 *
 * We only accept JSON. The OTLP HTTP/protobuf variant would need a
 * proto parser in this hot path; the runway exporter
 * (`@opentelemetry/exporter-trace-otlp-http`) emits JSON by default,
 * which is the only encoding slice 1 is on the hook for.
 */
async function handleOtlpTraces(
  req: IncomingMessage,
  res: ServerResponse,
  storage: Storage,
): Promise<void> {
  const ct = (req.headers["content-type"] ?? "").toString().toLowerCase();
  if (!ct.includes("application/json")) {
    writeError(
      res,
      415,
      "unsupported_media_type",
      `expected application/json, got "${ct}"`,
    );
    return;
  }

  const body = await readBody(req);
  if (body === undefined) {
    writeError(res, 413, "payload_too_large", `body exceeds ${MAX_BODY_BYTES} bytes`);
    return;
  }

  let payload: OtlpTracesPayload;
  try {
    payload = JSON.parse(body) as OtlpTracesPayload;
  } catch (err) {
    writeError(res, 400, "invalid_json", asMessage(err));
    return;
  }

  const projection = projectPayload(payload);
  for (const d of projection.drains) storage.saveDrain(d);
  for (const p of projection.issueProcesses) storage.saveIssueProcess(p);
  for (const a of projection.agentIterations) storage.saveAgentIteration(a);
  for (const r of projection.rawSpans) storage.saveRawSpan(r);

  // OTLP success body: a small JSON envelope. Required by the spec
  // even on a "we accepted everything" path so SDKs don't treat the
  // empty body as a partial failure.
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ partialSuccess: {} }));
}

function handleListView(res: ServerResponse, storage: Storage): void {
  const rows = storage.listIssueProcesses({ limit: 100 });
  const html = renderListView(rows);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

/**
 * VA-389: per-issue detail page. Composes the issue_process row,
 * iteration list, and review/finalize phase spans into a single view
 * model and hands it to `renderDetailView`. Returns 404 when the
 * (trace_id, span_id) pair doesn't match a known issue process — the
 * dashboard never auto-creates rows from a URL.
 */
function handleDetailView(
  res: ServerResponse,
  storage: Storage,
  traceId: string,
  spanId: string,
): void {
  const ip = storage.getIssueProcess(traceId, spanId);
  if (!ip) {
    writeError(
      res,
      404,
      "not_found",
      `no issue process for trace=${traceId} span=${spanId}`,
    );
    return;
  }
  const iterations = storage.listAgentIterations(traceId, spanId);
  const phaseSpans = storage.listPhaseSpans(traceId, spanId, [
    ...DETAIL_PHASE_NAMES,
  ]);
  const html = renderDetailView({
    issueProcess: ip,
    iterations,
    phaseSpans,
  });
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

/**
 * VA-399: JSON snapshot of the evaluator-facing aggregates read-model.
 * The shape mirrors `EvaluatorAggregate` (snake_case → camelCase) so
 * IRA prompts and the dashboard UI can reference the same field names
 * regardless of access path. See `read-model.md` for the field
 * contract + versioning policy.
 */
function handleAggregates(res: ServerResponse, storage: Storage): void {
  const rows = storage.listAggregates();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ view: "evaluator_aggregates_v1", rows }));
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

function writeError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code, message } }));
}

function asMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}

/**
 * Default entry point invoked by the docker container. Resolves
 * `SQLITE_PATH`, `OTLP_PORT`, and `DASHBOARD_PORT` from env, opens
 * storage, and binds two listeners against the same handler — the
 * OTLP receiver and the dashboard UI both speak the same set of
 * routes; the dual ports are conventional, not enforced. Exits the
 * process on a SIGINT/SIGTERM after closing the DB.
 */
export async function main(): Promise<void> {
  const sqlitePath = process.env.SQLITE_PATH ?? "/data/runway.sqlite";
  const otlpPort = parsePort("OTLP_PORT", "4318");
  const dashboardPort = parsePort("DASHBOARD_PORT", "3001");
  // VA-399: rolling-window size for the evaluator aggregates view.
  // Defaults to 30 drains; operators bump it for longer-baseline IRA
  // comparisons. Missing/invalid → fall through to the storage layer's
  // default rather than crashing the dashboard at boot.
  const aggregateWindow = parsePositiveInt(
    process.env.DASHBOARD_AGGREGATE_WINDOW,
  );

  const storage = createStorage(sqlitePath, {
    aggregateWindowDrains: aggregateWindow,
  });
  const otlp = await startServer({ storage, port: otlpPort });
  const dashboard =
    dashboardPort === otlpPort
      ? otlp
      : await startServer({ storage, port: dashboardPort });

  console.log(
    `[runway dashboard] OTLP :${otlp.port} · dashboard :${dashboard.port}; sqlite=${sqlitePath}`,
  );

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    console.log(`[runway dashboard] ${signal} — shutting down`);
    await otlp.close();
    if (dashboard !== otlp) await dashboard.close();
    storage.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function parsePort(envName: string, fallback: string): number {
  const raw = process.env[envName] ?? fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid ${envName}: "${raw}"`);
  }
  return n;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// Run as a script when executed directly (e.g. inside the Docker
// container's CMD). Skipped when imported by tests.
const isMain = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    // Match either the compiled `dist/dashboard/server.js` or the
    // tsx-source `src/dashboard/server.ts`, so both `runway dash` and
    // `tsx src/dashboard/server.ts` work.
    return /[/\\]dashboard[/\\]server\.(js|ts)$/.test(argv1);
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error("[runway dashboard] fatal:", asMessage(err));
    process.exit(1);
  });
}
