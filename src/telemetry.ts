import { NodeSdk } from "@effect/opentelemetry";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Layer } from "effect";

/**
 * VA-358 + VA-388: OpenTelemetry telemetry layer for the orchestrator.
 *
 * Env-conditional: only wires the OTLP HTTP exporters when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` (or one of the signal-specific
 * `_TRACES_ENDPOINT` / `_LOGS_ENDPOINT` overrides) is set. Otherwise
 * we provide `NodeSdk.layerEmpty` — `Effect.withSpan` and
 * `Effect.logInfo` still work in the program but the resulting spans
 * and log records are dropped on the floor rather than spamming the
 * network. Dev-mode default: no traces, no logs, no warnings.
 *
 * VA-388 also bridges Effect's `Logger` to the OTLP logs path. With
 * `OtelLogger.layerLoggerReplace` provided downstream of the configured
 * SDK, every existing `Effect.logInfo` / `logWarning` / `logError`
 * call emits an OTel log record — annotated context (e.g.
 * `Effect.annotateLogs({ issue, branch })`) flows as log-record
 * attributes without changes at the call sites.
 *
 * Standard OpenTelemetry env vars apply (the exporters read them
 * themselves): `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`,
 * `OTEL_SERVICE_NAME`, etc.
 */
const isTelemetryEnabled = (): boolean => {
  return Boolean(
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
      process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
  );
};

const liveLayer = NodeSdk.layer(() => ({
  resource: {
    serviceName: process.env.OTEL_SERVICE_NAME ?? "runway",
    serviceVersion: process.env.RUNWAY_VERSION,
  },
  spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter()),
  // VA-388: pair the trace SDK with a logs SDK so Effect's logger can
  // emit through the OtelLoggerProvider context that `NodeSdk.layer`
  // builds. `OTLPLogExporter` defaults to the same endpoint family as
  // the trace exporter (reading `OTEL_EXPORTER_OTLP_ENDPOINT` and the
  // `_LOGS_ENDPOINT` override), so a single env var lights up both
  // paths.
  logRecordProcessor: new BatchLogRecordProcessor(new OTLPLogExporter()),
}));

// VA-388: when `logRecordProcessor` is set above, `NodeSdk.layer`
// internally composes `Logger.layerLoggerAdd` against an internal
// `OtelLoggerProvider`, so `Effect.log` calls fan out to OTLP in
// addition to the default stderr logger. An earlier revision wrapped
// `Logger.layerLoggerReplace` around `liveLayer` to silence stderr,
// but `NodeSdk.layer` consumes `OtelLoggerProvider` via `Layer.provide`
// internally and does not re-export it — that composition raised
// "Service not found: OtelLoggerProvider" at startup.
export const TelemetryLive: Layer.Layer<never, never, never> =
  isTelemetryEnabled()
    ? (liveLayer as unknown as Layer.Layer<never, never, never>)
    : (NodeSdk.layerEmpty as unknown as Layer.Layer<never, never, never>);
