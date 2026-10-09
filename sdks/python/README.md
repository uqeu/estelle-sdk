# estelle-agent (Python)

Dependency-free instrumentation for production agents. It emits typed records to Estelle, propagates W3C
trace context, and batches transport off the caller thread. It does not inspect repositories, diagnose,
route models, judge output, propose repairs, or decide billing; those remain server responsibilities.

```python
from estelle_agent import AgentEvent, EstelleAgent, TraceContext

agent = EstelleAgent("agent-write-key", repo="acme/service")
trace = TraceContext.new()
agent.emit(AgentEvent(kind="tool_call", run_id=trace.trace_id, tool="lookup_user"))
```

The source is licensed under Apache-2.0. An empty key makes the client inert. Call `flush()` or `close()`
during graceful shutdown; ordinary `emit()` calls only append to a bounded in-memory queue.
