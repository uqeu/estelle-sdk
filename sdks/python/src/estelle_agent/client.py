"""Typed records, W3C propagation, bounded batching, and transport. No product intelligence."""
from __future__ import annotations

import json
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, field
from typing import Callable, Mapping

_TRACEPARENT = re.compile(r"^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$")
_DEFAULT_ENDPOINT = "https://api.fatelabs.ca/agent/events"


@dataclass(frozen=True)
class TraceContext:
    """A W3C-compatible trace/span identity that can cross process boundaries."""

    trace_id: str
    span_id: str
    sampled: bool = True

    @classmethod
    def new(cls, id_factory: Callable[[], str] | None = None) -> "TraceContext":
        make = id_factory or (lambda: secrets.token_hex(16))
        trace_id = make()
        span_id = make() if id_factory is not None else secrets.token_hex(8)
        return cls._validated(trace_id, span_id, True)

    @classmethod
    def _validated(cls, trace_id: str, span_id: str, sampled: bool) -> "TraceContext":
        if not re.fullmatch(r"[0-9a-f]{32}", str(trace_id)) or int(trace_id, 16) == 0:
            raise ValueError("trace_id must be 16 non-zero bytes encoded as lowercase hex")
        if not re.fullmatch(r"[0-9a-f]{16}", str(span_id)) or int(span_id, 16) == 0:
            raise ValueError("span_id must be 8 non-zero bytes encoded as lowercase hex")
        return cls(str(trace_id), str(span_id), bool(sampled))

    @property
    def traceparent(self) -> str:
        return f"00-{self.trace_id}-{self.span_id}-{'01' if self.sampled else '00'}"

    def inject(self, headers: Mapping[str, str] | None = None) -> dict[str, str]:
        return {**dict(headers or {}), "traceparent": self.traceparent}

    def child(self, id_factory: Callable[[], str] | None = None) -> "TraceContext":
        span_id = (id_factory or (lambda: secrets.token_hex(8)))()
        return self._validated(self.trace_id, span_id, self.sampled)

    @classmethod
    def extract(cls, headers: Mapping[str, str]) -> "TraceContext | None":
        value = next((v for k, v in headers.items() if k.lower() == "traceparent"), "")
        match = _TRACEPARENT.fullmatch(str(value).strip().lower())
        if match is None:
            return None
        try:
            return cls._validated(match.group(1), match.group(2), bool(int(match.group(3), 16) & 1))
        except ValueError:
            return None


@dataclass(frozen=True)
class AgentEvent:
    """One observation. Fields mirror `/agent/events`; absent values are omitted from the wire."""

    kind: str
    event_id: str = ""
    run_id: str = ""
    parent_id: str = ""
    tool: str = ""
    ok: bool = True
    error: str = ""
    claim: str = ""
    evidence: tuple[str, ...] = ()
    symbols: tuple[str, ...] = ()
    at: str = ""
    latency_ms: float = 0.0
    source: dict | None = None
    attributes: dict = field(default_factory=dict)
    subject: str = ""
    subject_type: str = ""

    def to_dict(self) -> dict:
        raw = asdict(self)
        raw["evidence"] = list(self.evidence)
        raw["symbols"] = list(self.symbols)
        return {key: value for key, value in raw.items()
                if value not in ("", None, (), [], {}) and not (key == "latency_ms" and value == 0.0)}


Transport = Callable[[str, dict[str, str], str], None]


#: The doors that are NOT events. Each is a low-volume, correctness-critical declaration, so each is
#: SYNCHRONOUS and each RAISES — deliberately unlike :meth:`EstelleAgent.emit`, which is bounded
#: best-effort because losing one span must never break the host application.
#: 🔴 AN OUTCOME THAT FAILS SILENTLY IS THE PRODUCT FAILING. "The bot got banned" arriving nowhere is
#: indistinguishable from the bot never being banned, and that verdict is the only thing that makes
#: the preceding thousand green events mean anything. So these do not share the drop-on-full queue.
_AGENT_EVENTS_PATH = "/agent/events"


def _base_of(endpoint: str) -> str:
    """The server root the non-event doors hang off, derived from the events endpoint.

    ONE OWNER for "where does this client send things". A caller who overrides ``endpoint`` to reach a
    staging server must not have to override three more URLs and keep them consistent — two owners of
    one fact disagree eventually, and the disagreement here means outcomes land on a different server
    from the events they explain.
    """
    text = str(endpoint or "").rstrip("/")
    if text.endswith(_AGENT_EVENTS_PATH):
        return text[: -len(_AGENT_EVENTS_PATH)]
    return text.rsplit("/", 1)[0] if "/" in text.split("://", 1)[-1] else text


class EstelleAgentError(RuntimeError):
    """A declaration door refused or could not be reached. Carries the HTTP status when there was one."""

    def __init__(self, message: str, *, status: int = 0, body: str = "") -> None:
        super().__init__(message)
        self.status = int(status)
        self.body = str(body)


def _request(url: str, headers: dict[str, str], body: "str | None",
             method: str) -> dict:  # pragma: no cover - network edge
    data = body.encode("utf-8") if body is not None else None
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            raw = response.read().decode("utf-8") or "{}"
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise EstelleAgentError(f"{method} {url} refused with {exc.code}",
                                status=exc.code, body=detail) from exc
    except Exception as exc:
        raise EstelleAgentError(f"{method} {url} could not be reached: {exc}") from exc
    try:
        return json.loads(raw)
    except ValueError as exc:
        raise EstelleAgentError(f"{method} {url} answered with non-JSON", body=raw[:500]) from exc


def _post(url: str, headers: dict[str, str], body: str) -> None:  # pragma: no cover - network edge
    request = urllib.request.Request(url, data=body.encode("utf-8"), headers=headers, method="POST")
    urllib.request.urlopen(request, timeout=2).close()


class EstelleAgent:
    """A bounded best-effort sender. `emit` never performs encoding or network I/O."""

    def __init__(self, key: str, *, repo: str = "", endpoint: str = _DEFAULT_ENDPOINT,
                 max_queue: int = 1000, max_batch: int = 100, flush_interval: float = 1.0,
                 transport: Transport | None = None, autostart: bool = True) -> None:
        self._key = str(key or "")
        self._repo = str(repo or "")
        self._endpoint = endpoint
        self._base = _base_of(endpoint)
        self._max_queue = max(1, int(max_queue))
        self._max_batch = max(1, int(max_batch))
        self._interval = max(0.001, float(flush_interval))
        self._transport = transport or _post
        self._autostart = autostart
        self._queue: list[dict] = []
        self._dropped = 0
        self._inflight = 0
        self._flushing = False
        self._stopping = False
        self._condition = threading.Condition()
        self._worker: threading.Thread | None = None

    @property
    def dropped(self) -> int:
        with self._condition:
            return self._dropped

    @property
    def queued(self) -> int:
        with self._condition:
            return len(self._queue)

    def emit(self, event: AgentEvent) -> bool:
        if not self._key:
            return False
        if not isinstance(event, AgentEvent):
            raise TypeError("emit expects AgentEvent")
        record = event.to_dict()
        with self._condition:
            if len(self._queue) >= self._max_queue:
                del self._queue[0]
                self._dropped += 1
            self._queue.append(record)
            if self._autostart:
                self._start_locked()
            if len(self._queue) >= self._max_batch:
                self._condition.notify_all()
        return True

    def _start_locked(self) -> None:
        if self._worker is None:
            self._worker = threading.Thread(target=self._run, name="estelle-agent-sender", daemon=True)
            self._worker.start()

    def _run(self) -> None:
        while True:
            with self._condition:
                while not self._queue and not self._stopping:
                    self._condition.wait()
                if self._stopping and not self._queue:
                    return
                if len(self._queue) < self._max_batch and not self._flushing:
                    self._condition.wait(self._interval)
                batch = self._queue[:self._max_batch]
                del self._queue[:len(batch)]
                self._inflight += bool(batch)
            if not batch:
                continue
            try:
                body = json.dumps({"repo": self._repo, "events": batch}, separators=(",", ":"))
                self._transport(self._endpoint, {
                    "Authorization": f"Bearer {self._key}",
                    "Content-Type": "application/json",
                }, body)
            except Exception:  # best-effort instrumentation never breaks its host
                with self._condition:
                    self._dropped += len(batch)
            finally:
                with self._condition:
                    self._inflight -= 1
                    self._condition.notify_all()

    # ── the three doors that are not events ──────────────────────────────────────────────────────
    # 🔴 THESE RAISE. `emit` is bounded best-effort on purpose; these are not, and the difference is
    # the product. An outcome that fails silently is indistinguishable from an outcome that never
    # happened, and it is the verdict that makes the preceding thousand green events mean anything.

    def _call(self, method: str, path: str, payload: "dict | None" = None) -> dict:
        if not self._key:
            raise EstelleAgentError("no agent key: this client cannot reach a declaration door")
        headers = {"Authorization": f"Bearer {self._key}"}
        body = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(payload, separators=(",", ":"))
        return _request(f"{self._base}{path}", headers, body, method)

    def report_outcome(self, subject: str, verdict: str, *, subject_type: str = "",
                       observed_at: str = "", source: str = "", detail: str = "") -> dict:
        """POST /agent/outcome — what ACTUALLY happened to a subject, in the operator's own words.

        ``verdict`` is the customer's vocabulary (``banned``, ``churned``, ``refunded``), never an enum
        this client defines. Both ``subject`` and ``verdict`` are required server-side: an outcome that
        names no subject joins no history, and one with no verdict says nothing. Validated here too, so
        the failure names the missing field instead of arriving as a 400 from three layers away.

        Call it WHEN THE VERDICT ARRIVES — hours or days after every event succeeded — not at the end
        of the run. The run already returned 200; that is the whole point of the primitive.
        """
        subject, verdict = str(subject or "").strip(), str(verdict or "").strip()
        if not subject:
            raise ValueError("report_outcome needs a subject — the durable id the outcome is about")
        if not verdict:
            raise ValueError("report_outcome needs a verdict — what happened, in your own vocabulary")
        payload = {"subject": subject, "verdict": verdict}
        for key, value in (("subject_type", subject_type), ("observed_at", observed_at),
                           ("source", source), ("detail", detail)):
            if str(value or "").strip():
                payload[key] = str(value).strip()
        return self._call("POST", "/agent/outcome", payload)

    def declare_objective(self, subject_type: str, outcome_class: str, text: str) -> dict:
        """POST /agent/objective — what must never happen, in the operator's own words.

        All three are required; the server refuses a half-declared trigger rather than landing one that
        carves out nothing and tells nobody. ``text`` is stored verbatim and never paraphrased into a
        metric — the wording IS the data, and it is what decides which raw events survive the trim.
        """
        fields = {"subject_type": str(subject_type or "").strip(),
                  "outcome_class": str(outcome_class or "").strip(),
                  "text": str(text or "").strip()}
        missing = sorted(name for name, value in fields.items() if not value)
        if missing:
            raise ValueError(f"declare_objective needs {', '.join(missing)} — a half-declared "
                             f"objective carves out nothing and warns no one")
        return self._call("POST", "/agent/objective", fields)

    def objectives(self) -> dict:
        """GET /agent/objectives — the declare door's read-back. The only proof a declaration landed."""
        return self._call("GET", "/agent/objectives")

    def subject_history(self, subject: str) -> dict:
        """GET /agent/subject/{subject} — everything this subject ever did, actions and outcomes in one
        append-ordered stream.

        ⚠️ A missing subject and another tenant's subject read IDENTICALLY, deliberately: this door is
        never an oracle for whether an id exists somewhere else on the platform.
        """
        subject = str(subject or "").strip()
        if not subject:
            raise ValueError("subject_history needs a subject")
        return self._call("GET", f"/agent/subject/{urllib.parse.quote(subject, safe='')}")

    def flush(self, timeout: float = 5.0) -> bool:
        if not self._key:
            return True
        deadline = time.monotonic() + max(0.0, timeout)
        with self._condition:
            self._start_locked()
            self._flushing = True
            self._condition.notify_all()
            while self._queue or self._inflight:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._flushing = False
                    return False
                self._condition.wait(remaining)
            self._flushing = False
            return True

    def close(self, *, flush: bool = True, timeout: float = 5.0) -> bool:
        complete = self.flush(timeout) if flush else True
        with self._condition:
            self._stopping = True
            if not flush:
                self._dropped += len(self._queue)
                self._queue.clear()
            self._condition.notify_all()
            worker = self._worker
        if worker is not None:
            worker.join(max(0.0, timeout))
        return complete
