import { NodeSdk } from "@effect/opentelemetry";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Layer } from "effect";

/**
 * VA-358: OpenTelemetry tracer for the orchestrator.
 *
 * Env-conditional: only wires the OTLP HTTP exporter when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`)
 * is set. Otherwise we provide `NodeSdk.layerEmpty` — `Effect.withSpan`
 * still works in the program but the resulting spans get dropped on the
 * floor rather than spamming the network. Dev-mode default: no traces,
 * no warnings.
 *
 * Standard OpenTelemetry env vars apply (the exporter reads them
 * itself): `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`,
 * `OTEL_SERVICE_NAME`, etc.
 */
const isTracingEnabled = (): boolean => {
  return Boolean(
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  );
};

const liveLayer = NodeSdk.layer(() => ({
  resource: {
    serviceName: process.env.OTEL_SERVICE_NAME ?? "runway",
    serviceVersion: process.env.RUNWAY_VERSION,
  },
  spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter()),
}));

export const TelemetryLive: Layer.Layer<never, never, never> = isTracingEnabled()
  ? (liveLayer as unknown as Layer.Layer<never, never, never>)
  : (NodeSdk.layerEmpty as unknown as Layer.Layer<never, never, never>);
