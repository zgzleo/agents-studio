import type { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { expect } from "vitest";

type FinishedSpans = ReturnType<InMemorySpanExporter["getFinishedSpans"]>;

export function expectPreparationSpanParents(spans: FinishedSpans, requiredNames: readonly string[]): void {
  const attempts = spans.filter(span => span.name === "task.execution_attempt");
  expect(attempts).toHaveLength(1);
  const preparation = spans.filter(span => requiredNames.includes(span.name));
  for (const span of preparation) {
    expect(["paperclip.heartbeat-preparation", "paperclip.native-runner"], span.name).toContain(span.instrumentationScope.name);
  }
  const immediate = preparation.filter(span => span.instrumentationScope.name === "paperclip.heartbeat-preparation");
  for (const name of requiredNames) {
    expect(immediate.some(span => span.name === name), `immediate ${name}`).toBe(true);
  }
  for (const span of immediate) {
    expect(span.parentSpanContext?.spanId, span.name).toBe(attempts[0]!.spanContext().spanId);
    expect(span.parentSpanContext?.traceId, span.name).toBe(attempts[0]!.spanContext().traceId);
  }
  // Slow phases are also replayed into the native session's historical trace.
  // Their causal parent is task.prepare, not the execution-attempt span.
  for (const span of preparation.filter(span => span.instrumentationScope.name === "paperclip.native-runner")) {
    const parent = spans.find(candidate => candidate.spanContext().spanId === span.parentSpanContext?.spanId
      && candidate.spanContext().traceId === span.parentSpanContext?.traceId);
    expect(parent?.name, `historical ${span.name}`).toBe("task.prepare");
    expect(parent?.instrumentationScope.name, `historical ${span.name}`).toBe("paperclip.native-runner");
  }
}
