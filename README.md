# Estelle SDKs

The monitoring agent for TypeScript and Python, and the wizard that installs it.

| package | registry | what it is |
|---|---|---|
| [`@fatelabs/estelle-agent`](sdks/typescript) | npm | TypeScript client. Declares subjects, outcomes and objectives; batches and ships them. |
| [`estelle-agent`](sdks/python) | PyPI | The same contract in Python. |
| [`@fatelabs/estelle-wizard`](sdks/wizard) | npm | Installs the above into your repo — and checks its own generated code before writing it. |

```bash
npx @fatelabs/estelle-wizard          # detect, plan, check, write
npx @fatelabs/estelle-wizard audit    # send a span and read it back
```

## Two things that are not standard

**The wizard checks its own output before it writes.** Generated code is a *claim* about an API, and a
generator is exactly as confident about a constructor that was renamed two minors ago. Before anything
reaches disk, the planned diff goes to Estelle's merge gate, which resolves it against your
repository's indexed symbol graph — deterministically, with no model in the verdict. If a symbol does
not exist, nothing is written.

It reports three outcomes and they are not interchangeable:

| | meaning | result |
|---|---|---|
| **Checked against your real code** | the gate ran, every symbol resolved | files written |
| **The gate refused this code** | the gate ran and named a symbol you do not have | **nothing written** |
| **Not checked** | the gate could not run | files written, and we say so |

The third row is the one that matters. No key, no network, or a repository Estelle has not indexed all
land there — because a refusal means *no evidence*, never *no problem*. We do not render it as a pass.

**`audit` proves telemetry arrives, not that a file exists.** It sends a span through the real ingest
endpoint and then reads it back from the server by trace id. A 200 from ingest is a claim about
acceptance; only the read-back shows the span is stored and retrievable.

## It generates glue and keeps the dependency

The wizard writes config, composition-root wiring and a `.gitignore` line. The telemetry logic stays in
a versioned package, so a fix reaches you with a version bump instead of N pull requests that N humans
must review. Vendoring it would remove the only upgrade channel there is.

So there is still a package. We removed the `init()` call, not the SDK.

## Licence

Apache-2.0. Source of truth for these packages lives in Fate Labs' main repository and is mirrored
here; issues and pull requests are welcome on this repo.
