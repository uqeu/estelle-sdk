/**
 * `estelle-wizard audit` — prove telemetry ARRIVES, not that a file exists.
 *
 * 🔴 **THIS IS THE HALF THAT MAKES COMMITTED INSTRUMENTATION SAFE, AND IT IS NOT OPTIONAL.** Code we
 * write into someone's repository can be edited, partially deleted or disabled, and we would never
 * know — their traces simply get quieter. PostHog shipped `wizard audit` for exactly this reason.
 *
 * ⛔ And it must be BEHAVIOURAL. A grep for `EstelleAgent(` proves the text exists; it cannot prove
 * the call runs, and a call sitting below a `return` never will. So this sends a span with a sentinel
 * name through the real ingest endpoint and then READS IT BACK from the server. Only the running
 * service can produce that read-back — no file check, no import check and no status code can fake it.
 *
 * The round trip is the assertion. A 200 from ingest is a claim about ACCEPTANCE and says nothing
 * about whether the span is retrievable; this repository has paid for that distinction more than once.
 */

/** Bounded before the call, not discovered during it. */
const INGEST_TIMEOUT_MS = 15_000;
const READBACK_TIMEOUT_MS = 15_000;
/** The store is eventually consistent by a second or two; poll a FIXED number of times, never spin. */
const READBACK_ATTEMPTS = 6;
const READBACK_DELAY_MS = 1_500;

export interface AuditResult {
  ok: boolean;
  /** What actually happened, in one sentence a human can act on. */
  detail: string;
  traceId: string;
  ingestStatus: number | null;
  readBackAttempts: number;
  /** Present only on success: what the server gave back, so the caller can show it. */
  observed?: { root: string; service: string; durationMs: number; spanCount: number };
}

function hex(bytes: number): string {
  const out: string[] = [];
  for (let i = 0; i < bytes; i++) out.push(Math.floor(Math.random() * 256).toString(16).padStart(2, "0"));
  return out.join("");
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), ms);
  try {
    return await work(control.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send one span and read it back.
 *
 * `endpoint` is the Estelle base URL (no path). `key` is the monitor key; it is sent as a bearer and
 * is NEVER logged, echoed or included in the result — a diagnostic that prints a credential has
 * created the incident it was meant to detect.
 */
export async function audit(endpoint: string, key: string): Promise<AuditResult> {
  const base = endpoint.replace(/\/+$/, "");
  const traceId = hex(16);
  const spanId = hex(8);
  const sentinel = `estelle_wizard_audit_${Date.now()}`;
  const start = Date.now() * 1e6;
  const durationNs = 42e6;

  const payload = {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "estelle-wizard-audit" } }] },
      scopeSpans: [{
        scope: { name: "estelle-wizard" },
        spans: [{
          traceId, spanId, name: sentinel, kind: 1,
          startTimeUnixNano: String(start),
          endTimeUnixNano: String(start + durationNs),
        }],
      }],
    }],
  };

  let ingestStatus: number | null = null;
  try {
    const response = await withTimeout((signal) => fetch(`${base}/v1/traces`, {
      method: "POST", signal,
      headers: { "authorization": `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    }), INGEST_TIMEOUT_MS);
    ingestStatus = response.status;
    if (response.status === 401 || response.status === 403) {
      return { ok: false, traceId, ingestStatus, readBackAttempts: 0,
               detail: `the monitor key was refused (HTTP ${response.status}). Check ESTELLE_MONITOR_KEY.` };
    }
    if (response.status >= 400) {
      return { ok: false, traceId, ingestStatus, readBackAttempts: 0,
               detail: `ingest refused the span with HTTP ${response.status}.` };
    }
  } catch (error) {
    return { ok: false, traceId, ingestStatus, readBackAttempts: 0,
             detail: `could not reach ${base}/v1/traces (${(error as Error).message}).` };
  }

  // ▶ The read-back. A 2xx above means ACCEPTED; only this loop means STORED AND RETRIEVABLE.
  for (let attempt = 1; attempt <= READBACK_ATTEMPTS; attempt++) {
    await sleep(READBACK_DELAY_MS);
    try {
      const response = await withTimeout((signal) => fetch(`${base}/monitor/trace/${traceId}`, {
        headers: { "authorization": `Bearer ${key}` }, signal,
      }), READBACK_TIMEOUT_MS);
      if (!response.ok) continue;
      const body = await response.json() as { trace?: Record<string, unknown> };
      const trace = body?.trace;
      if (!trace) continue;
      // 🔴 THE SENTINEL IS THE TRACE ID, NOT THE SPAN NAME — measured against production 2026-10-09.
      // Estelle redacts span names on ingest (it is content-free by construction), so a read-back
      // returns `root: "[redacted]"` and a name comparison can NEVER match. The first version of this
      // audit compared names and reported a healthy server as broken. A 128-bit id this process chose
      // at random and the server handed back is a stronger sentinel anyway: it cannot collide, and
      // unlike a name it cannot be rewritten in transit.
      if (String(trace["trace_id"]) !== traceId) {
        return { ok: false, traceId, ingestStatus, readBackAttempts: attempt,
                 detail: `the server returned trace ${String(trace["trace_id"])}, not the one we sent.` };
      }
      if (Number(trace["span_count"]) < 1) {
        return { ok: false, traceId, ingestStatus, readBackAttempts: attempt,
                 detail: "the trace came back with no spans in it." };
      }
      return {
        ok: true, traceId, ingestStatus, readBackAttempts: attempt,
        detail: "a span sent through /v1/traces was read back from the server by its trace id.",
        observed: {
          root: String(trace["root"]), service: String(trace["service"]),
          durationMs: Number(trace["duration_ms"]), spanCount: Number(trace["span_count"]),
        },
      };
    } catch { /* a transient read failure is not a verdict; the attempt bound is */ }
  }

  // ⛔ A capped read means "could not confirm", NEVER "it is not there".
  return {
    ok: false, traceId, ingestStatus, readBackAttempts: READBACK_ATTEMPTS,
    detail: `ingest accepted the span (HTTP ${ingestStatus}) but it was not readable after ` +
            `${READBACK_ATTEMPTS} attempts over ${(READBACK_ATTEMPTS * READBACK_DELAY_MS) / 1000}s. ` +
            `This is "could not confirm", not "not stored" — retry, and if it persists the ingest path ` +
            `is accepting spans it does not retain.`,
  };
}
