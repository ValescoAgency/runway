import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  createLinearAdapter,
  startLinearSync,
  type LinearSyncHandle,
} from "./linear-sync.js";
import { createEventBus, type EventBus } from "./events.js";
import {
  extractActiveDrainMarkers,
  projectLogs,
  projectPayload,
} from "./projector.js";
import {
  createStorage,
  type IssueProcessFilter,
  type LinearSnapshotRow,
  type MetaReviewKind,
  type OutcomeFilterKind,
  type RecentDrain,
  type Storage,
  type StoredIssueProcess,
} from "./storage.js";
import {
  META_REVIEW_PAGE_SIZE,
  renderDetailView,
  renderIssueProcessRows,
  renderListView,
  renderLogsSection,
  renderMetaReviewDetailView,
  renderMetaReviewListView,
  type ListFilterState,
  type MetaReviewListFilterState,
} from "./views.js";
import type { OtlpLogsPayload, OtlpTracesPayload } from "./otlp.js";

// VA-389: phase spans we surface on the detail page's timeline.
// Anything else stays in raw_spans for debugging but isn't rendered.
const DETAIL_PHASE_NAMES = ["review", "pushBranch", "openPullRequest"] as const;
const ISSUE_DETAIL_RE = /^\/issue\/([^/?#]+)\/([^/?#]+)\/?$/;
// VA-387: canonical detail route. `:id` is the issue process span_id;
// the lookup falls back to the (trace_id, span_id) pair only for
// older `/issue/...` links that still work for back-compat.
const ISSUE_PROCESS_DETAIL_RE = /^\/issue-processes\/([^/?#]+)\/?$/;
// VA-391: SSE detail-pane stream. `:id` is the issue process span_id
// (same as the detail route); the handler resolves it to a trace_id
// and forwards every dashboard event for that trace to the client.
const ISSUE_PROCESS_STREAM_RE = /^\/issue-processes\/([^/?#]+)\/stream\/?$/;
// VA-407: meta-review detail route. `:id` is the meta_reviews row's
// synthetic UUID; resolved via `getMetaReview`.
const META_REVIEW_DETAIL_RE = /^\/meta-reviews\/([^/?#]+)\/?$/;

const META_REVIEW_KIND_VALUES: ReadonlySet<MetaReviewKind> = new Set<MetaReviewKind>([
  "meta-run-review",
  "meta-drain-review",
  "meta-weekly-review",
  "meta-skipped",
  "meta-failed",
]);

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
  /**
   * Bind address. Defaults to `127.0.0.1` per VA-385's security
   * commitment ("Binds to `127.0.0.1` only. No auth in v1."). The
   * Dockerfile overrides this to `0.0.0.0` via `DASHBOARD_HOST` so
   * Docker's port forwarding can reach the listener; docker-compose
   * then gates the host port to loopback via the `127.0.0.1:` prefix
   * on the published port. Stand-alone (non-Docker) operators get
   * loopback-only by default.
   */
  readonly host?: string;
  /**
   * VA-390: when true, the list view renders the "Todo queue (next up)"
   * section and per-row Linear status badges. When false (the default,
   * matching "LINEAR_API_KEY is absent"), the dashboard behaves
   * exactly as before — queue preview hidden, badges fall back to the
   * snapshot-at-emit value (the existing outcome cell).
   */
  readonly linearEnabled?: boolean;
  /**
   * VA-452: Linear workspace slug (e.g. "valescoagency"). When set,
   * the views render a `↗ open in Linear` affordance next to each
   * issue identifier. When omitted/null, the dashboard renders
   * identifiers as before.
   */
  readonly linearWorkspace?: string | null;
  /**
   * VA-391: in-process event bus the OTLP ingest paths publish to.
   * Optional — defaults to a fresh per-server bus, which is what
   * production wants. Tests inject one to assert publish/subscribe
   * behaviour without going through SSE.
   */
  readonly events?: EventBus;
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
export function buildServer(
  storage: Storage,
  opts: {
    readonly linearEnabled?: boolean;
    readonly linearWorkspace?: string | null;
    readonly events?: EventBus;
  } = {},
): Server {
  const linearEnabled = opts.linearEnabled ?? false;
  const linearWorkspace = opts.linearWorkspace ?? null;
  // VA-391: an in-process event bus is plumbed through every request
  // handler so the OTLP ingest paths can publish change events that
  // the SSE detail-pane stream re-emits to the browser. Callers can
  // inject their own (tests use this to assert publish behavior);
  // production gets a fresh per-server bus.
  const events = opts.events ?? createEventBus();
  return createServer((req, res) => {
    handle(req, res, storage, linearEnabled, linearWorkspace, events).catch(
      (err) => {
        writeError(res, 500, "internal_error", asMessage(err));
      },
    );
  });
}

/**
 * Bind and start the dashboard server. Returns a handle the caller can
 * use to close it gracefully (used by tests).
 */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const server = buildServer(opts.storage, {
    linearEnabled: opts.linearEnabled,
    linearWorkspace: opts.linearWorkspace,
    events: opts.events,
  });
  const port = opts.port ?? 4318;
  const host = opts.host ?? "127.0.0.1";

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
  linearEnabled: boolean,
  linearWorkspace: string | null,
  events: EventBus,
): Promise<void> {
  // Route on method + path. Nothing fancy — slice 1 only has two
  // endpoints; a router becomes worth its weight in slice 2.
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  if (method === "POST" && url === "/v1/traces") {
    await handleOtlpTraces(req, res, storage, events);
    return;
  }

  if (method === "POST" && url === "/v1/logs") {
    await handleOtlpLogs(req, res, storage, events);
    return;
  }

  if (method === "GET" && (url === "/" || url.startsWith("/?"))) {
    handleListView(req, res, storage, linearEnabled, linearWorkspace);
    return;
  }

  // VA-391: fragment endpoint returns just the tbody so the list view
  // can poll via htmx without redrawing the rest of the page.
  if (
    method === "GET" &&
    (url === "/issue-processes" || url.startsWith("/issue-processes?"))
  ) {
    handleIssueProcessRowsFragment(
      req,
      res,
      storage,
      linearEnabled,
      linearWorkspace,
    );
    return;
  }

  if (method === "GET") {
    const pathOnly = url.split("?")[0] ?? "";
    // VA-391: SSE stream matches BEFORE the detail route so the
    // `/stream` suffix isn't swallowed as a span_id segment.
    const streamMatch = ISSUE_PROCESS_STREAM_RE.exec(pathOnly);
    if (streamMatch) {
      const spanId = decodeURIComponent(streamMatch[1] ?? "");
      handleIssueProcessStream(req, res, storage, events, spanId);
      return;
    }
    const issueProcessMatch = ISSUE_PROCESS_DETAIL_RE.exec(pathOnly);
    if (issueProcessMatch) {
      const spanId = decodeURIComponent(issueProcessMatch[1] ?? "");
      handleIssueProcessDetailView(res, storage, spanId, linearWorkspace);
      return;
    }
    // VA-407: meta-review list + detail. List matches the bare path or
    // `?...` form; detail matches the `:id` segment. Both come before
    // the legacy `/issue/...` regex below since they share no
    // ambiguity but listing them by specificity keeps the routing
    // table readable.
    if (pathOnly === "/meta-reviews") {
      handleMetaReviewListView(res, storage, url);
      return;
    }
    const metaReviewMatch = META_REVIEW_DETAIL_RE.exec(pathOnly);
    if (metaReviewMatch) {
      const id = decodeURIComponent(metaReviewMatch[1] ?? "");
      handleMetaReviewDetailView(res, storage, id);
      return;
    }
    const detailMatch = ISSUE_DETAIL_RE.exec(pathOnly);
    if (detailMatch) {
      const traceId = decodeURIComponent(detailMatch[1] ?? "");
      const spanId = decodeURIComponent(detailMatch[2] ?? "");
      handleDetailView(res, storage, traceId, spanId, linearWorkspace);
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
  events: EventBus,
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
  for (const p of projection.issueProcesses) {
    storage.saveIssueProcess(p);
    // VA-391: notify SSE subscribers that an issue_processes row
    // changed. Agent iterations and raw spans piggyback on the same
    // issue-process trigger — anything that affects the detail pane
    // is refreshed by re-rendering the page on this event.
    events.publish({
      kind: "issueProcessChanged",
      traceId: p.traceId,
      issueProcessSpanId: p.spanId,
    });
  }
  for (const a of projection.agentIterations) {
    storage.saveAgentIteration(a);
    if (a.issueProcessSpanId) {
      events.publish({
        kind: "issueProcessChanged",
        traceId: a.traceId,
        issueProcessSpanId: a.issueProcessSpanId,
      });
    }
  }
  for (const r of projection.rawSpans) storage.saveRawSpan(r);

  // OTLP success body: a small JSON envelope. Required by the spec
  // even on a "we accepted everything" path so SDKs don't treat the
  // empty body as a partial failure.
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ partialSuccess: {} }));
}

/**
 * VA-388: OTLP HTTP/JSON logs receiver. Same content-type / body /
 * success-envelope contract as `/v1/traces`; the projector hands back
 * `LogRecordRow`s which we persist via `storage.appendLogRecord`. As
 * with traces, retries (the SDK's BatchLogRecordProcessor will re-send
 * on a transient failure) are idempotent — the PK is (trace_id,
 * span_id, timestamp).
 */
async function handleOtlpLogs(
  req: IncomingMessage,
  res: ServerResponse,
  storage: Storage,
  events: EventBus,
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

  let payload: OtlpLogsPayload;
  try {
    payload = JSON.parse(body) as OtlpLogsPayload;
  } catch (err) {
    writeError(res, 400, "invalid_json", asMessage(err));
    return;
  }

  // VA-455: surface in-flight drains the moment the runway process
  // emits its `drain.started` log marker — well before the first
  // processIssue span ends. `markDrainActive` is no-op when the
  // drain has already closed, so reordering across OTLP retries is
  // safe.
  for (const m of extractActiveDrainMarkers(payload)) {
    storage.markDrainActive(m);
  }

  for (const r of projectLogs(payload)) {
    storage.appendLogRecord(r);
    // VA-391: the SSE detail-pane stream live-tails the Logs section
    // on every new log record. Filter by trace_id so a subscriber
    // only sees records for its own issue process.
    events.publish({
      kind: "logRecordAppended",
      traceId: r.traceId,
      spanId: r.spanId,
    });
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ partialSuccess: {} }));
}

/**
 * VA-391: SSE detail-pane stream. Sends an initial `data: ready`
 * frame so the htmx sse extension's `connect` event fires before
 * the first real payload, then forwards every dashboard event for
 * this issue process's trace_id as a typed SSE event. Cleanup runs
 * on either side closing the socket — `req.on("close")` covers both
 * a browser tab close and a server shutdown.
 *
 * Frame format follows htmx's `sse-swap` contract:
 *
 *   event: <type>
 *   data: <html-encoded payload>
 *   <blank line>
 *
 * The htmx sse extension swaps the named target with the frame body
 * verbatim, so the payloads here are HTML fragments — the same
 * `renderLogsSection` the detail page uses for its initial render.
 */
function handleIssueProcessStream(
  req: IncomingMessage,
  res: ServerResponse,
  storage: Storage,
  events: EventBus,
  spanId: string,
): void {
  const ip = storage.getIssueProcessBySpanId(spanId);
  if (!ip) {
    writeError(res, 404, "not_found", `no issue process for span=${spanId}`);
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    // Disable proxy buffering so events flush as they're written —
    // dashboards behind nginx default to buffering text/event-stream
    // unless this is set.
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  // Initial frame — opens the stream and tells the htmx extension the
  // connection is live so its `connect` hook can fire.
  res.write(": runway sse stream open\n\n");

  const subscription = events.subscribe(
    { traceId: ip.traceId },
    (event) => {
      if (event.kind === "logRecordAppended") {
        const logs = storage.streamLogsFor(ip.traceId);
        writeSseFrame(res, "logsRefresh", renderLogsSection(logs));
        return;
      }
      if (event.kind === "issueProcessChanged") {
        // The detail pane re-renders on iteration / phase changes
        // via a full reload — htmx clients can listen for this
        // event name and decide their swap strategy. We don't ship
        // a partial fragment here because the phase timeline +
        // table re-uses every field on the issueProcess row.
        writeSseFrame(res, "issueProcessChanged", "");
        return;
      }
    },
  );

  const cleanup = (): void => {
    subscription.unsubscribe();
    if (!res.writableEnded) res.end();
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
}

/**
 * VA-391: list-view fragment endpoint. Returns just the rendered
 * `<tbody>` for the issue-process table so the page can poll via
 * `hx-trigger="every 3s"` and swap only the rows. The Linear queue
 * preview and drain summary strip stay static between polls — they
 * have their own swap triggers (or sit above the polling target).
 */
function handleIssueProcessRowsFragment(
  req: IncomingMessage,
  res: ServerResponse,
  storage: Storage,
  linearEnabled: boolean,
  linearWorkspace: string | null,
): void {
  // VA-392: the fragment endpoint applies the same filter state as the
  // full list view so a polled refresh doesn't reset the user's chips.
  // The query string is the source of truth — htmx mirrors the page's
  // URL via `hx-include` from the front-end, so a /issue-processes
  // request lands with the same params the list page was rendered
  // against.
  const filterState = parseListFilterState(req.url ?? "/");
  const filter = toIssueProcessFilter(filterState);
  const rows = storage.listIssueProcesses(filter);
  const snapshotsByIdentifier = linearEnabled
    ? new Map<string, LinearSnapshotRow>(
        storage.listLinearSnapshots().map((s) => [s.issueIdentifier, s]),
      )
    : new Map<string, LinearSnapshotRow>();
  const html = renderIssueProcessRows({
    rows,
    linearEnabled,
    snapshotsByIdentifier,
    isFiltered: isFilteredState(filterState),
    linearWorkspace,
  });
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function writeSseFrame(
  res: ServerResponse,
  event: string,
  data: string,
): void {
  // SSE spec: each line in `data` is its own `data:` line. Joining
  // with `\ndata: ` keeps multi-line HTML fragments intact.
  const lines = data.split("\n").map((line) => `data: ${line}`).join("\n");
  res.write(`event: ${event}\n${lines}\n\n`);
}

function handleListView(
  req: IncomingMessage,
  res: ServerResponse,
  storage: Storage,
  linearEnabled: boolean,
  linearWorkspace: string | null,
): void {
  // VA-392: filter chips state is encoded in the URL query string so
  // the view is shareable. Parse once and reuse both for the storage
  // query and the chip render (the latter needs to know which chips
  // are currently active).
  const filterState = parseListFilterState(req.url ?? "/");
  const filter = toIssueProcessFilter(filterState);
  const rows = storage.listIssueProcesses(filter);
  const recentDrains = storage.listRecentDrains();
  // VA-390: only read Linear-side data when the sync is enabled. The
  // tables exist either way (the schema is unconditional), but a
  // disabled dashboard never paid for the poller so the rows would be
  // empty anyway — short-circuiting keeps the list-view path identical
  // to the pre-VA-390 behavior.
  const todoQueue = linearEnabled ? storage.listLinearTodoQueue() : [];
  const snapshotsByIdentifier = linearEnabled
    ? new Map<string, LinearSnapshotRow>(
        storage.listLinearSnapshots().map((s) => [s.issueIdentifier, s]),
      )
    : new Map<string, LinearSnapshotRow>();
  // VA-391: drain summary strip — populated when a drainQueue span
  // hasn't ended yet (inferred by issue_processes with no parent
  // `drains` row). `null` becomes the "Idle — no active drain"
  // state in views.
  const activeDrain = storage.getActiveDrain();
  const html = renderListView({
    rows,
    linearEnabled,
    todoQueue,
    snapshotsByIdentifier,
    activeDrain,
    filterState,
    recentDrains,
    isFiltered: isFilteredState(filterState),
    linearWorkspace,
  });
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

// ---------------------------------------------------------------------------
// VA-392: URL ↔ filter state plumbing.
// ---------------------------------------------------------------------------

const VALID_OUTCOMES: readonly OutcomeFilterKind[] = [
  "opened",
  "hitl",
  "errored",
  "in-flight",
];
const VALID_RANGES: readonly ListFilterState["range"][] = [
  "all",
  "today",
  "7d",
  "30d",
];

/**
 * VA-392: parse the list view's filter state out of the URL query
 * string. The state is intentionally permissive — invalid values
 * silently fall back to "no filter" rather than 400-ing, so a stale
 * bookmark from a previous slice still renders.
 */
export function parseListFilterState(url: string): ListFilterState {
  // `URL` needs a base; the dashboard never cares about it.
  const parsed = new URL(url, "http://localhost");
  const params = parsed.searchParams;

  // `outcome=opened,hitl` or `outcome=opened&outcome=hitl` — both work.
  const rawOutcomes = params
    .getAll("outcome")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  const outcomes = rawOutcomes.filter((v): v is OutcomeFilterKind =>
    (VALID_OUTCOMES as readonly string[]).includes(v),
  );

  const rangeRaw = (params.get("range") ?? "all").trim();
  const range = (VALID_RANGES as readonly string[]).includes(rangeRaw)
    ? (rangeRaw as ListFilterState["range"])
    : "all";

  const drain = params.get("drain")?.trim() || null;

  return { outcomes, range, drain };
}

function isFilteredState(state: ListFilterState): boolean {
  return (
    state.outcomes.length > 0 ||
    state.range !== "all" ||
    state.drain !== null
  );
}

/**
 * VA-392: convert filter state into a storage filter. The date-range
 * chip resolves to an `insertedSince` lower bound; the drain chip to
 * `traceId`; outcomes pass through. `range=all` becomes no lower bound.
 */
function toIssueProcessFilter(state: ListFilterState): IssueProcessFilter {
  const filter: {
    -readonly [K in keyof IssueProcessFilter]: IssueProcessFilter[K];
  } = { limit: 100 };
  if (state.outcomes.length > 0) filter.outcomes = state.outcomes;
  if (state.drain) filter.traceId = state.drain;
  const since = resolveInsertedSince(state.range);
  if (since) filter.insertedSince = since;
  return filter;
}

/**
 * VA-392: translate the date-range chip into a SQLite `datetime('now')`
 * formatted lower bound. The column stores `YYYY-MM-DD HH:MM:SS` in
 * UTC, so the cutoff is computed in UTC too. `today` is the current
 * UTC calendar day's 00:00:00 — matching how an operator typically
 * thinks of "today" when scanning the dashboard.
 */
function resolveInsertedSince(
  range: ListFilterState["range"],
): string | null {
  if (range === "all") return null;
  const now = new Date();
  if (range === "today") {
    return formatSqliteDatetime(
      new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          0,
          0,
          0,
        ),
      ),
    );
  }
  const days = range === "7d" ? 7 : 30;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return formatSqliteDatetime(cutoff);
}

function formatSqliteDatetime(d: Date): string {
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
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
  linearWorkspace: string | null,
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
  renderDetailFor(res, storage, ip, linearWorkspace);
}

/**
 * VA-387: detail-route handler keyed on the issue process span_id
 * alone. Reuses the same view model as the older two-segment route
 * once the row is resolved.
 */
function handleIssueProcessDetailView(
  res: ServerResponse,
  storage: Storage,
  spanId: string,
  linearWorkspace: string | null,
): void {
  const ip = storage.getIssueProcessBySpanId(spanId);
  if (!ip) {
    writeError(res, 404, "not_found", `no issue process for span=${spanId}`);
    return;
  }
  renderDetailFor(res, storage, ip, linearWorkspace);
}

function renderDetailFor(
  res: ServerResponse,
  storage: Storage,
  ip: StoredIssueProcess,
  linearWorkspace: string | null,
): void {
  const iterations = storage.listAgentIterations(ip.traceId, ip.spanId);
  const phaseSpans = storage.listPhaseSpans(ip.traceId, ip.spanId, [
    ...DETAIL_PHASE_NAMES,
  ]);
  // VA-388: log records for the same trace_id, regardless of which
  // span emitted them. The view filters in JS to the records whose
  // span chain falls under this issue process — bounded by a single
  // drain, so the over-fetch is cheap.
  const logs = storage.streamLogsFor(ip.traceId);
  const html = renderDetailView({
    issueProcess: ip,
    iterations,
    phaseSpans,
    logs,
    linearWorkspace,
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

/**
 * VA-407: GET `/meta-reviews` — paginated list view of meta_reviews
 * rows. `?kind=<kind>` narrows to one kind; `?page=N` is 1-based and
 * combined with `META_REVIEW_PAGE_SIZE` to produce the OFFSET. The
 * handler parses the URL, runs both a list + count read against
 * Storage, and hands the projection to `renderMetaReviewListView`.
 */
function handleMetaReviewListView(
  res: ServerResponse,
  storage: Storage,
  url: string,
): void {
  const filterState = parseMetaReviewQuery(url);
  const offset = (filterState.page - 1) * META_REVIEW_PAGE_SIZE;
  const filter = {
    ...(filterState.kind !== null ? { kind: filterState.kind } : {}),
    limit: META_REVIEW_PAGE_SIZE,
    offset,
  };
  const rows = storage.listMetaReviews(filter);
  const totalCount = storage.countMetaReviews(
    filterState.kind !== null ? { kind: filterState.kind } : undefined,
  );
  const html = renderMetaReviewListView({ rows, totalCount, filterState });
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

/**
 * VA-407: GET `/meta-reviews/:id` — render the structured review for
 * one row. Looks up the source `issue_processes` row when applicable
 * (Run Review only) so the detail view can cross-link back to the
 * canonical `/issue-processes/:spanId` route per the AC.
 */
function handleMetaReviewDetailView(
  res: ServerResponse,
  storage: Storage,
  id: string,
): void {
  const metaReview = storage.getMetaReview(id);
  if (!metaReview) {
    writeError(res, 404, "not_found", `no meta-review for id=${id}`);
    return;
  }
  let sourceIssueProcessSpanId: string | null = null;
  if (
    metaReview.kind === "meta-run-review" &&
    metaReview.drainId &&
    metaReview.issueId
  ) {
    const sourceIp = storage.findIssueProcessByIdentifier(
      metaReview.drainId,
      metaReview.issueId,
    );
    sourceIssueProcessSpanId = sourceIp?.spanId ?? null;
  }
  const html = renderMetaReviewDetailView({
    metaReview,
    sourceIssueProcessSpanId,
  });
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

/**
 * VA-407: parse the `/meta-reviews` URL query string into the typed
 * filter state. Unknown `kind` values fall through to `null` (the
 * "all" chip), and a missing / non-positive `page` parameter clamps
 * to 1 — defensive against operator-typed URLs.
 */
function parseMetaReviewQuery(url: string): MetaReviewListFilterState {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return { kind: null, page: 1 };
  const search = new URLSearchParams(url.slice(queryStart + 1));
  const kindRaw = search.get("kind");
  const kind =
    kindRaw !== null && META_REVIEW_KIND_VALUES.has(kindRaw as MetaReviewKind)
      ? (kindRaw as MetaReviewKind)
      : null;
  const pageRaw = search.get("page");
  const pageNum = pageRaw !== null ? Number(pageRaw) : 1;
  const page =
    Number.isFinite(pageNum) && pageNum >= 1 ? Math.floor(pageNum) : 1;
  return { kind, page };
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
  // VA-385/VA-392: explicit security commitment — loopback by default.
  // VA-392 splits the single `DASHBOARD_HOST` into two env vars so the
  // OTLP receiver and dashboard UI can bind independently (e.g. OTLP
  // on the docker bridge interface while the UI stays loopback). The
  // legacy `DASHBOARD_HOST` is honored as a fallback for both so
  // older docker-compose configs keep working. The Dockerfile sets
  // `DASHBOARD_HOST=0.0.0.0` so Docker's port-forward can reach the
  // listener; stand-alone (e.g. `runway dash`) gets 127.0.0.1 without
  // configuration.
  const legacyHost = process.env.DASHBOARD_HOST?.trim() || "127.0.0.1";
  const otlpHost = process.env.OTLP_BIND?.trim() || legacyHost;
  const dashboardHost = process.env.DASHBOARD_BIND?.trim() || legacyHost;
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

  // VA-390: Linear sync is opt-in via LINEAR_API_KEY presence. Absent
  // → no poller, no queue preview, no status badges; the dashboard
  // looks exactly as it did pre-VA-390. Present → wire the adapter
  // and start polling at LINEAR_POLL_INTERVAL_SECONDS (default 300).
  const linearApiKey = process.env.LINEAR_API_KEY;
  const linearEnabled = Boolean(linearApiKey);
  // VA-452: workspace slug for the `↗ open in Linear` affordance.
  // Trim + collapse empty to null so a stray empty env var doesn't
  // produce broken `linear.app//issue/...` URLs.
  const linearWorkspaceRaw = process.env.RUNWAY_LINEAR_WORKSPACE?.trim();
  const linearWorkspace =
    linearWorkspaceRaw && linearWorkspaceRaw.length > 0
      ? linearWorkspaceRaw
      : null;
  let linearSync: LinearSyncHandle | null = null;
  if (linearApiKey) {
    const adapter = createLinearAdapter({
      apiKey: linearApiKey,
      team: process.env.RUNWAY_LINEAR_TEAM,
      readyLabel: process.env.RUNWAY_READY_LABEL,
    });
    const intervalSeconds =
      parsePositiveInt(process.env.LINEAR_POLL_INTERVAL_SECONDS) ?? 300;
    linearSync = startLinearSync({
      adapter,
      storage,
      intervalSeconds,
    });
    console.log(
      `[runway dashboard] linear sync: polling every ${intervalSeconds}s (team=${process.env.RUNWAY_LINEAR_TEAM ?? "VA"} label=${process.env.RUNWAY_READY_LABEL ?? "ready-for-agent"})`,
    );
  } else {
    console.log(
      "[runway dashboard] linear sync: disabled (LINEAR_API_KEY not set)",
    );
  }

  const otlp = await startServer({
    storage,
    port: otlpPort,
    host: otlpHost,
    linearEnabled,
    linearWorkspace,
  });
  // The two listeners can share a server only when both port AND host
  // match — different bind addresses need different listeners.
  const dashboard =
    dashboardPort === otlpPort && dashboardHost === otlpHost
      ? otlp
      : await startServer({
          storage,
          port: dashboardPort,
          host: dashboardHost,
          linearEnabled,
          linearWorkspace,
        });

  console.log(
    `[runway dashboard] OTLP ${otlpHost}:${otlp.port} · dashboard ${dashboardHost}:${dashboard.port}; sqlite=${sqlitePath}`,
  );

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    console.log(`[runway dashboard] ${signal} — shutting down`);
    linearSync?.stop();
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
