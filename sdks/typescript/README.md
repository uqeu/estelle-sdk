# @fatelabs/estelle-agent

Zero-runtime-dependency instrumentation for production agents. It emits typed records to Estelle,
propagates W3C trace context, and batches transport away from the caller. It does not inspect repositories,
diagnose, route models, judge output, propose repairs, or decide billing; those remain server responsibilities.

```ts
import { AgentClient, TraceContext } from "@fatelabs/estelle-agent";

const agent = new AgentClient({ key: "agent-write-key", repo: "acme/service" });
const trace = TraceContext.create();
agent.emit({ kind: "tool_call", run_id: trace.traceId, tool: "lookup_user" });
```

The source is licensed under Apache-2.0. An empty key makes the client inert. Call `flush()` or `close()`
during graceful shutdown; ordinary `emit()` calls only append to a bounded in-memory queue.
