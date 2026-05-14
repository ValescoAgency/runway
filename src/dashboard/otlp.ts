/**
 * OTLP HTTP/JSON wire types — just enough of the
 * `opentelemetry.proto.trace.v1` shape to project runway's spans. The
 * full proto schema is much larger; we model only the fields we read.
 *
 * Reference: https://opentelemetry.io/docs/specs/otlp/#otlphttp-request
 * The JSON encoding for int64 fields (timestamps, intValue) is
 * `string` per the proto3 JSON mapping — we keep them as strings so
 * we never lose precision through `number`.
 */

export interface OtlpAttribute {
  readonly key: string;
  readonly value: OtlpAttributeValue;
}

export interface OtlpAttributeValue {
  readonly stringValue?: string;
  readonly intValue?: string | number;
  readonly boolValue?: boolean;
  readonly doubleValue?: number;
  readonly arrayValue?: { readonly values: readonly OtlpAttributeValue[] };
}

export interface OtlpSpanEvent {
  readonly timeUnixNano: string;
  readonly name: string;
  readonly attributes?: readonly OtlpAttribute[];
}

export interface OtlpSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind?: number;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes?: readonly OtlpAttribute[];
  readonly events?: readonly OtlpSpanEvent[];
  readonly status?: { readonly code?: number; readonly message?: string };
}

export interface OtlpScope {
  readonly name?: string;
  readonly version?: string;
}

export interface OtlpScopeSpans {
  readonly scope?: OtlpScope;
  readonly spans: readonly OtlpSpan[];
}

export interface OtlpResource {
  readonly attributes?: readonly OtlpAttribute[];
}

export interface OtlpResourceSpans {
  readonly resource?: OtlpResource;
  readonly scopeSpans: readonly OtlpScopeSpans[];
}

export interface OtlpTracesPayload {
  readonly resourceSpans: readonly OtlpResourceSpans[];
}

export type AttrScalar = string | number | boolean | readonly string[];

/**
 * Coerce an OTLP attribute value to a plain JS scalar. We collapse
 * the typed wire variants (`stringValue` / `intValue` / `boolValue` /
 * `doubleValue` / `arrayValue`) into one return path so callers
 * downstream can pattern-match without knowing the OTLP shape.
 *
 * `intValue` round-trips as a string to preserve int64 precision.
 * Callers that want a `number` (e.g. for counters under 2^53) should
 * `Number(...)` it themselves.
 *
 * VA-387: `arrayValue` collapses to a `readonly string[]` so the
 * dashboard's label-style attributes (`runway.issue.labels`) survive
 * the wire trip with their structure intact. Non-string array
 * elements drop silently — projector callers only ever ask for
 * string arrays today.
 */
export function attrValue(
  attr: OtlpAttribute | undefined,
): AttrScalar | undefined {
  if (!attr) return undefined;
  const v = attr.value;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.intValue !== undefined) {
    // OTLP int64 — JSON form is string per proto3, but the SDK
    // sometimes emits as number for small ints. Accept both.
    return typeof v.intValue === "string"
      ? v.intValue
      : v.intValue;
  }
  if (v.arrayValue !== undefined) {
    const items: string[] = [];
    for (const inner of v.arrayValue.values) {
      if (inner.stringValue !== undefined) items.push(inner.stringValue);
    }
    return items;
  }
  return undefined;
}

/**
 * Build a key → scalar map from an OTLP attribute list. Unknown
 * variants drop silently — projector code shouldn't crash on a span
 * with an attribute shape we haven't enumerated.
 */
export function attrMap(
  attrs: readonly OtlpAttribute[] | undefined,
): Record<string, AttrScalar> {
  const out: Record<string, AttrScalar> = {};
  if (!attrs) return out;
  for (const a of attrs) {
    const v = attrValue(a);
    if (v !== undefined) out[a.key] = v;
  }
  return out;
}
