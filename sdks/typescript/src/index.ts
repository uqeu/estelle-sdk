/** Typed records, W3C propagation, bounded batching, and transport. No product intelligence. */

export interface AgentEvent {
  kind: string;
  event_id?: string;
  run_id?: string;
  parent_id?: string;
  subject?: string;
  subject_type?: string;
  tool?: string;
  ok?: boolean;
  error?: string;
  claim?: string;
  evidence?: readonly string[];
  symbols?: readonly string[];
  at?: string;
  latency_ms?: number;
  source?: { kind: "file" | "memory" | "research" | "model" | "unknown"; ref: string; line?: number };
  attributes?: Readonly<Record<string, unknown>>;
}

export type Transport = (
  url: string,
  request: { headers: Record<string, string>; body: string },
) => Promise<void> | void;

export interface AgentClientOptions {
  key: string;
  repo?: string;
  endpoint?: string;
  maxQueue?: number;
  maxBatch?: number;
  flushIntervalMs?: number;
  transport?: Transport;
  request?: RequestFn;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const DEFAULT_ENDPOINT = "https://api.fatelabs.ca/agent/events";
const AGENT_EVENTS_PATH = "/agent/events";

/**
 * A declaration door refused or could not be reached.
 *
 * 🔴 The three doors below THROW, unlike `emit`, which is bounded best-effort on purpose. Losing one
 * span must never break the host application; losing an OUTCOME is the product failing, because a
 * verdict that arrives nowhere is indistinguishable from a verdict that never happened.
 */
export class EstelleAgentError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status = 0, body = "") {
    super(message);
    this.name = "EstelleAgentError";
    this.status = status;
    this.body = body;
  }
}

export type RequestFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<unknown>;

/**
 * The server root the non-event doors hang off, derived from the events endpoint — ONE owner for
 * "where does this client send things". A caller pointing `endpoint` at staging must not have to
 * override three more URLs and keep them consistent; two owners of one fact disagree eventually, and
 * here the disagreement means outcomes land on a different server from the events they explain.
 */
export function baseOf(endpoint: string): string {
  const text = String(endpoint ?? "").replace(/\/+$/, "");
  if (text.endsWith(AGENT_EVENTS_PATH)) return text.slice(0, -AGENT_EVENTS_PATH.length);
  const afterScheme = text.split("://")[1] ?? text;
  return afterScheme.includes("/") ? text.slice(0, text.lastIndexOf("/")) : text;
}

async function defaultRequest(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    throw new EstelleAgentError(`${init.method} ${url} could not be reached: ${String(cause)}`);
  }
  const raw = await response.text();
  if (!response.ok) {
    throw new EstelleAgentError(
      `${init.method} ${url} refused with ${response.status}`, response.status, raw.slice(0, 500));
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new EstelleAgentError(`${init.method} ${url} answered with non-JSON`, 0, raw.slice(0, 500));
  }
}

function randomHex(bytes: number): string {
  const data = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(data);
  return Array.from(data, (value) => value.toString(16).padStart(2, "0")).join("");
}

function validId(value: string, length: number, label: string): string {
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(value) || /^0+$/.test(value)) {
    throw new Error(`${label} must be non-zero lowercase hex`);
  }
  return value;
}

export class TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled: boolean;

  constructor(traceId: string, spanId: string, sampled = true) {
    this.traceId = validId(traceId, 32, "traceId");
    this.spanId = validId(spanId, 16, "spanId");
    this.sampled = sampled;
  }

  static create(idFactory?: (bytes: number) => string | undefined): TraceContext {
    const traceId = idFactory?.(16) ?? randomHex(16);
    const spanId = idFactory?.(8) ?? randomHex(8);
    return new TraceContext(traceId, spanId);
  }

  static extract(headers: Readonly<Record<string, string>>): TraceContext | undefined {
    const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === "traceparent");
    const match = TRACEPARENT.exec((entry?.[1] ?? "").trim().toLowerCase());
    if (!match) return undefined;
    try {
      return new TraceContext(match[1], match[2], (Number.parseInt(match[3], 16) & 1) === 1);
    } catch {
      return undefined;
    }
  }

  get traceparent(): string {
    return `00-${this.traceId}-${this.spanId}-${this.sampled ? "01" : "00"}`;
  }

  inject(headers: Readonly<Record<string, string>> = {}): Record<string, string> {
    return { ...headers, traceparent: this.traceparent };
  }

  child(idFactory?: (bytes: number) => string | undefined): TraceContext {
    return new TraceContext(this.traceId, idFactory?.(8) ?? randomHex(8), this.sampled);
  }
}

async function defaultTransport(
  url: string,
  request: { headers: Record<string, string>; body: string },
): Promise<void> {
  const response = await fetch(url, { method: "POST", headers: request.headers, body: request.body });
  if (!response.ok) throw new Error(`Estelle ingest returned HTTP ${response.status}`);
}

export class AgentClient {
  private readonly key: string;
  private readonly repo: string;
  private readonly endpoint: string;
  private readonly maxQueue: number;
  private readonly maxBatch: number;
  private readonly flushIntervalMs: number;
  private readonly transport: Transport;
  private readonly base: string;
  private readonly request: RequestFn;
  private queue: AgentEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private drainTail: Promise<void> = Promise.resolve();
  private droppedCount = 0;
  private closed = false;

  constructor(options: AgentClientOptions) {
    this.key = options.key ?? "";
    this.repo = options.repo ?? "";
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.maxQueue = Math.max(1, Math.floor(options.maxQueue ?? 1000));
    this.maxBatch = Math.max(1, Math.floor(options.maxBatch ?? 100));
    this.flushIntervalMs = Math.max(1, Math.floor(options.flushIntervalMs ?? 1000));
    this.transport = options.transport ?? defaultTransport;
    this.base = baseOf(this.endpoint);
    this.request = options.request ?? defaultRequest;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  get queued(): number {
    return this.queue.length;
  }

  emit(event: AgentEvent): boolean {
    if (!this.key || this.closed) return false;
    if (this.queue.length >= this.maxQueue) {
      this.queue.shift();
      this.droppedCount += 1;
    }
    this.queue.push({ ...event });
    if (this.queue.length >= this.maxBatch) {
      void this.enqueueDrain(false);
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.enqueueDrain(false);
      }, this.flushIntervalMs);
    }
    return true;
  }

  private enqueueDrain(all: boolean): Promise<void> {
    const run = async (): Promise<void> => {
      do {
        const batch = this.queue.splice(0, this.maxBatch);
        if (batch.length === 0) return;
        try {
          await this.transport(this.endpoint, {
            headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
            body: JSON.stringify({ repo: this.repo, events: batch }),
          });
        } catch {
          this.droppedCount += batch.length;
        }
      } while (all && this.queue.length > 0);
    };
    this.drainTail = this.drainTail.then(run, run);
    return this.drainTail;
  }

  // ── the three doors that are not events ─────────────────────────────────────────────────────
  // These THROW. `emit` drops on a full queue by design; an outcome must never fail quietly.

  private async call(method: string, path: string, payload?: unknown): Promise<unknown> {
    if (!this.key) {
      throw new EstelleAgentError("no agent key: this client cannot reach a declaration door");
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${this.key}` };
    let body: string | undefined;
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(payload);
    }
    return this.request(`${this.base}${path}`, { method, headers, body });
  }

  /**
   * POST /agent/outcome — what ACTUALLY happened to a subject, in the operator's own words.
   *
   * `verdict` is the customer's vocabulary (`banned`, `churned`, `refunded`), never an enum this
   * client defines. Call it WHEN THE VERDICT ARRIVES — hours or days after every event succeeded —
   * not at the end of the run. The run already returned 200; that is the whole point.
   */
  async reportOutcome(
    subject: string,
    verdict: string,
    extra: { subjectType?: string; observedAt?: string; source?: string; detail?: string } = {},
  ): Promise<unknown> {
    const id = String(subject ?? "").trim();
    const what = String(verdict ?? "").trim();
    if (!id) throw new Error("reportOutcome needs a subject — the durable id the outcome is about");
    if (!what) throw new Error("reportOutcome needs a verdict — what happened, in your own words");
    const payload: Record<string, string> = { subject: id, verdict: what };
    const optional: Array<[string, string | undefined]> = [
      ["subject_type", extra.subjectType], ["observed_at", extra.observedAt],
      ["source", extra.source], ["detail", extra.detail],
    ];
    for (const [key, value] of optional) {
      const text = String(value ?? "").trim();
      if (text) payload[key] = text;
    }
    return this.call("POST", "/agent/outcome", payload);
  }

  /**
   * POST /agent/objective — what must never happen, in the operator's own words. All three fields are
   * required; the server refuses a half-declared trigger rather than landing one that carves out
   * nothing and tells nobody. `text` is stored verbatim — the wording IS the data.
   */
  async declareObjective(subjectType: string, outcomeClass: string, text: string): Promise<unknown> {
    const fields: Record<string, string> = {
      subject_type: String(subjectType ?? "").trim(),
      outcome_class: String(outcomeClass ?? "").trim(),
      text: String(text ?? "").trim(),
    };
    const missing = Object.keys(fields).filter((key) => !fields[key]).sort();
    if (missing.length) {
      throw new Error(
        `declareObjective needs ${missing.join(", ")} — a half-declared objective carves out ` +
        "nothing and warns no one");
    }
    return this.call("POST", "/agent/objective", fields);
  }

  /** GET /agent/objectives — the declare door's read-back. The only proof a declaration landed. */
  async objectives(): Promise<unknown> {
    return this.call("GET", "/agent/objectives");
  }

  /**
   * GET /agent/subject/{subject} — everything this subject ever did, actions and outcomes in one
   * append-ordered stream.
   *
   * ⚠️ A missing subject and another tenant's subject read IDENTICALLY, deliberately: this door is
   * never an oracle for whether an id exists somewhere else on the platform.
   */
  async subjectHistory(subject: string): Promise<unknown> {
    const id = String(subject ?? "").trim();
    if (!id) throw new Error("subjectHistory needs a subject");
    return this.call("GET", `/agent/subject/${encodeURIComponent(id)}`);
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.enqueueDrain(true);
  }

  async close(options: { flush?: boolean } = {}): Promise<void> {
    if (options.flush !== false) await this.flush();
    else {
      this.droppedCount += this.queue.length;
      this.queue = [];
    }
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.closed = true;
  }
}
