/**
 * Prove the generated instrumentation against the repository's REAL symbol graph, before writing it.
 *
 * 🔴 **THIS IS THE HALF NOBODY ELSE HAS, AND IT IS ONLY WORTH HAVING IF IT CAN SAY "NO".** Every
 * wizard on the market generates code: Sentry's is template-driven, PostHog's drives a model over your
 * codebase, and both then WRITE. Neither can tell you whether what it just wrote refers to symbols that
 * actually exist at the version you have installed — a generator's output is a claim about an API, and a
 * model that is confident about `new AgentClient({...})` is exactly as confident when the constructor was
 * renamed two minors ago. Estelle already owns the instrument that settles that: `POST /gate` runs a
 * DETERMINISTIC check against the caller's own indexed graph, with NO model call, so it cannot be argued
 * into agreeing. This module points it at our own output.
 *
 * ⛔ **THREE OUTCOMES, AND COLLAPSING THE THIRD INTO THE FIRST WOULD BE THE WHOLE LIE.** The gate grounds
 * against a SWEPT repository. A repo Estelle has never indexed produces a REFUSAL, not a pass — and a
 * refusal means *no evidence*, never *no problem*. So a network failure, a missing key, an unswept repo
 * and a gate that could not run all land in `UNVERIFIED`, which the CLI must print differently from
 * `VERIFIED`. The claim we are allowed to make is "verified against your indexed symbol graph" and it is
 * only true in one of the three branches. Saying it in the other two is the failure this whole product
 * exists to prevent, committed by the feature named after preventing it.
 */

/** Bounded before the call, never discovered during it. */
const GATE_TIMEOUT_MS = 30_000;
/** A diff larger than this is not sent — the gate is a check, not an upload channel. */
const MAX_DIFF_BYTES = 256 * 1024;

export type GateOutcome = "verified" | "blocked" | "unverified";

export interface GateVerdict {
  outcome: GateOutcome;
  /** One sentence a human can act on. Never empty, including on success. */
  detail: string;
  /** The gate's own findings, when it produced any. Shown verbatim; we do not re-word its verdict. */
  findings: string[];
  /** Which repository the verdict is ABOUT, as the gate reported it — never as we assumed it. */
  scope?: string;
}

/**
 * A unified diff for files that do not exist yet.
 *
 * Deliberately minimal and deliberately honest about it: every write the wizard plans is either a NEW
 * file or an APPEND, so `/dev/null` → `b/<path>` covers the real cases and we never hand the gate a
 * hunk we synthesised from a file we did not read. If a future write edits in place, build its diff from
 * the real before-image or do not send it at all — a diff whose before-image was guessed would have the
 * gate certify a change nobody is making.
 */
export function unifiedDiff(writes: { path: string; contents: string; kind: string }[]): string {
  const parts: string[] = [];
  for (const write of writes) {
    if (write.kind !== "create" && write.kind !== "append") continue;
    const lines = write.contents.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    parts.push(
      `diff --git a/${write.path} b/${write.path}`,
      write.kind === "create" ? "new file mode 100644" : `--- a/${write.path}`,
      write.kind === "create" ? "--- /dev/null" : "",
      `+++ b/${write.path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((l) => `+${l}`),
    );
  }
  return parts.filter((p) => p !== "").join("\n") + "\n";
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), ms);
  try { return await work(control.signal); } finally { clearTimeout(timer); }
}

function findingsOf(body: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["hallucinated", "findings", "errors", "blocking"]) {
    const value = body[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") out.push(item);
        else if (item && typeof item === "object") {
          const o = item as Record<string, unknown>;
          const msg = o["message"] ?? o["detail"] ?? o["symbol"] ?? JSON.stringify(o);
          out.push(String(msg));
        }
      }
    }
  }
  return out;
}

/**
 * Send the planned diff to the gate.
 *
 * `key` is the caller's Estelle key. It is sent as a bearer and NEVER logged, echoed or returned — a
 * diagnostic that prints a credential has created the incident it was meant to detect.
 */
export async function gateWrites(
  endpoint: string, key: string, diff: string, repo: string,
): Promise<GateVerdict> {
  if (!key) {
    return { outcome: "unverified", findings: [],
             detail: "no Estelle key, so the generated code was not checked against your symbol graph." };
  }
  if (!diff.trim()) {
    return { outcome: "unverified", findings: [], detail: "nothing to check — the plan writes no code." };
  }
  if (Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES) {
    // ⛔ A capped read means "cannot answer", never "that's all there is".
    return { outcome: "unverified", findings: [],
             detail: `the generated diff is larger than ${MAX_DIFF_BYTES} bytes and was not sent.` };
  }

  const base = endpoint.replace(/\/+$/, "");
  let body: Record<string, unknown>;
  try {
    const response = await withTimeout((signal) => fetch(`${base}/gate`, {
      method: "POST", signal,
      headers: { "authorization": `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(repo ? { diff, repo } : { diff }),
    }), GATE_TIMEOUT_MS);
    if (response.status === 401 || response.status === 403) {
      return { outcome: "unverified", findings: [],
               detail: `the Estelle key was refused (HTTP ${response.status}); the code was not checked.` };
    }
    body = await response.json() as Record<string, unknown>;
    if (response.status >= 400 && body?.["merge"] === undefined) {
      const msg = (body?.["error"] as Record<string, unknown>)?.["message"] ?? `HTTP ${response.status}`;
      return { outcome: "unverified", findings: [], detail: `the gate could not run: ${String(msg)}.` };
    }
  } catch (error) {
    // ⛔ A gate that could not be reached is UNVERIFIED. Reading it as clean is the fail-open this
    // repository has paid for more than once — a capped or failed check is "cannot answer".
    return { outcome: "unverified", findings: [],
             detail: `could not reach the gate (${(error as Error).message}); the code was not checked.` };
  }

  const scope = typeof body["scope_repo"] === "string" ? body["scope_repo"] as string
              : typeof body["repo"] === "string" ? body["repo"] as string : undefined;

  // 🔴 ABSENT IS NOT FALSE AND IT IS NOT TRUE. A body with no `merge` field is a gate that did not
  // reach a verdict — most often because this repo has never been swept, which is a refusal carrying
  // no evidence either way. Reading a missing field as a pass is the "absent field read as no data"
  // defect; reading it as a block would refuse to install over a check that never ran.
  const merge = body["merge"];
  if (typeof merge !== "boolean") {
    return { outcome: "unverified", scope, findings: findingsOf(body),
             detail: "Estelle has not indexed this repository, so there was nothing to check the "
                   + "generated code against. Run a sweep and re-run the wizard to get the check." };
  }
  if (!merge) {
    // 🔴 A `merge: false` IS NOT AUTOMATICALLY A VERDICT ABOUT THE CODE, AND TREATING IT AS ONE IS THE
    // EXACT DEFECT THIS FEATURE EXISTS TO PREVENT. Measured against production on 2026-10-09: the gate
    // answered `merge: false` with NO findings and
    //     reason: "multi-repo account, no scope signal — ask which repo"
    // — it could not tell which repository to ground against, so it refused. The first version of this
    // function rendered that as "it names a symbol your indexed repository does not have", which the
    // gate had not said and could not have said. A refusal means NO EVIDENCE, never NO PROBLEM, and
    // the anti-hallucination product shipping a confident false claim is the worst possible place to
    // get this wrong. It took a real run to find: a typecheck and six stubbed cases all passed.
    //
    // ⛔ So the discriminator is FINDINGS, not the boolean. A block must be able to NAME the symbol it
    // objected to; a refusal that names nothing is reported as unverified, with the gate's own reason
    // quoted rather than re-worded.
    const findings = findingsOf(body);
    if (findings.length === 0) {
      const reason = typeof body["reason"] === "string" ? body["reason"] as string : "";
      return { outcome: "unverified", scope, findings: [],
               detail: "the gate did not reach a verdict on the code"
                     + (reason ? `: ${reason}` : " and gave no reason")
                     + ". That is 'could not check', not 'checked and clean'." };
    }
    return { outcome: "blocked", scope, findings,
             detail: "the gate REFUSED the code this wizard was about to write — it names a symbol "
                   + "your indexed repository does not have. Nothing was written." };
  }
  return { outcome: "verified", scope, findings: findingsOf(body),
           detail: "every symbol in the generated code was checked against your indexed repository." };
}
