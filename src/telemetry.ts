import { NodeSdk } from "@effect/opentelemetry";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Layer } from "effect";

/**
 * VA-358 / VA-388: OpenTelemetry tracer + OTLP-logs bridge for the
 * orchestrator.
 *
 * Env-conditional: only wires the OTLP HTTP exporters when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` (or one of the signal-specific
 * `…_TRACES_ENDPOINT` / `…_LOGS_ENDPOINT` overrides) is set. Otherwise
 * we provide `NodeSdk.layerEmpty` — `Effect.withSpan` / `Effect.logInfo`
 * still work in the program but the resulting spans and logs get
 * dropped on the floor rather than spamming the network. Dev-mode
 * default: no traces, no logs, no warnings.
 *
 * Standard OpenTelemetry env vars apply (the exporters read them
 * themselves): `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`,
 * `OTEL_SERVICE_NAME`, etc.
 *
 * The logs path uses `@effect/opentelemetry`'s built-in bridge: when
 * `logRecordProcessor` is wired into `NodeSdk.layer`, every
 * `Effect.logInfo` / `logWarning` / `logError` flows through an OTel
 * Logger that emits OTLP log records with the active span's
 * `traceId` / `spanId` and any `Effect.annotateLogs` context attached
 * as attributes. No call-site changes required.
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
  logRecordProcessor: new BatchLogRecordProcessor(new OTLPLogExporter()),
}));

export const TelemetryLive: Layer.Layer<never, never, never> = isTelemetryEnabled()
  ? (liveLayer as unknown as Layer.Layer<never, never, never>)
  : (NodeSdk.layerEmpty as unknown as Layer.Layer<never, never, never>);
