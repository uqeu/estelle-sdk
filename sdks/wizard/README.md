# @fatelabs/estelle-wizard

Installs Estelle monitoring into your repository, and proves it actually reports.

```bash
npx @fatelabs/estelle-wizard          # detect, plan, write on your say-so
npx @fatelabs/estelle-wizard audit    # send a span and read it back
```

## It checks its own output against your real code

Every wizard generates code. Sentry's is template-driven, PostHog's drives a model over your codebase,
and both then write the files. Neither can tell you whether what it just wrote refers to symbols that
actually exist at the version you have installed — generated code is a *claim* about an API, and a model
is exactly as confident about a constructor that was renamed two minors ago.

Before this wizard writes a byte, it sends the diff it is about to apply to Estelle's merge gate, which
checks it against your repository's indexed symbol graph. The gate is deterministic and makes no model
call, so it cannot be talked round. If it refuses, nothing is written.

```
$ npx @fatelabs/estelle-wizard

checking the generated code against your indexed repository…

Checked against your real code.
  every symbol in the generated code was checked against your indexed repository.
  graph: your-org/your-repo
```

**Three outcomes, printed differently, because two of them are not proof.**

| outcome | what it means | what happens |
|---|---|---|
| `Checked against your real code` | the gate ran and every symbol resolved | files are written |
| `The gate refused this code` | the gate ran and a symbol does not exist | **nothing is written** — that is our bug, report it |
| `Not checked` | the gate could not run | files are written, and we say so |

That third row is the important one. `Not checked` happens when you have no `ESTELLE_API_KEY`, when the
network is unreachable, or — most often — when Estelle has never indexed this repository, because the
gate grounds against a swept graph and a repo it has not seen produces a refusal rather than a pass.
A refusal means *no evidence*, never *no problem*, so it is never rendered as a pass. Set
`ESTELLE_API_KEY` and sweep the repo to turn it into a real check.

## What it writes, and what it does not

It generates **glue** and keeps the **dependency**. Config, the composition-root wiring, the `.gitignore`
line. The telemetry logic stays in `@fatelabs/estelle-agent`, a versioned package, so a fix reaches you
with a version bump instead of N pull requests that N humans must review. Vendoring the logic would
remove the only upgrade channel there is; Datadog documents where that ends — a version skew where all
traces are dropped, silently.

So: there is still a package. We removed the `init()` call, not the SDK.

## It writes the glue and keeps the dependency

The wizard generates configuration and wiring. The telemetry logic stays in a versioned package
(`@fatelabs/estelle-agent` or `estelle-agent` on PyPI), so a fix reaches you with a version bump
rather than a pull request, it has an SBOM entry and a CVE feed, and uninstalling is one command.

It will not edit your composition root. If `next.config.ts` or `manage.py` already exists the plan
says so and leaves it alone — a generator editing the file you also edit is the highest-conflict
change it can make.

It never runs your package manager. It prints the one command and you run it.

## If you already emit OpenTelemetry, you need none of this

The wizard checks first, and says so. Point your existing exporter at us:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.fatelabs.ca
OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer <your-monitor-key>"
```

Spans, logs, metrics, errors and GenAI facts, with errors bound to symbols in your indexed code
graph. No SDK, no init, no code change.

## `audit` proves arrival, not presence

A check that greps for `AgentClient(` proves the text exists. It cannot prove the call runs, and if
it sits below a `return` it never will. So `audit` sends a span through the real ingest endpoint and
reads it back from the server by trace id — a fact only the running service can produce.

```
Monitoring is working.
  a span sent through /v1/traces was read back from the server by its trace id.
  trace 2dd3871c… · 1 span · 42ms · service estelle-wizard-audit · read back on attempt 1
```

Exit `0` confirmed, `1` could not confirm, `2` not configured. A failed read-back reports
*"could not confirm"*, never *"not stored"* — a capped read is not an absence.

## Order of operations

`.gitignore` is written **before** the file that holds your key. A generator that writes a credential
into a tracked file has created a secret-in-git incident on your behalf.

## Detected today

Next.js, Express, Fastify, generic Node · FastAPI, Django, Flask, generic Python.
Anything else reports `unknown` and writes the generic wiring rather than guessing.

Apache-2.0.
