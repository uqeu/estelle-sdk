import { createServer } from "node:http";
import { gateWrites, unifiedDiff } from "../dist/gate.js";

const cases = [
  { name: "merge:true  -> verified",  body: { merge: true, scope_repo: "o/n" }, status: 200, want: "verified" },
  { name: "merge:false -> blocked",   body: { merge: false, hallucinated: [{ symbol: "AgentClient", message: "AgentClient is not defined in this repo" }] }, status: 200, want: "blocked" },
  { name: "no merge field (unswept) -> unverified", body: { error: { message: "repo has not been swept" } }, status: 200, want: "unverified" },
  // 🔴 THE REAL PRODUCTION RESPONSE, 2026-10-09. The gate answers merge:false WITH NO FINDINGS when it
  // cannot decide which repo to ground against. Reading that as "blocked" told the user their code
  // named a missing symbol, which the gate never said. A refusal is not a no.
  { name: "merge:false + NO findings (scope refusal) -> unverified",
    body: { merge: false, reason: "multi-repo account, no scope signal \u2014 ask which repo" },
    status: 200, want: "unverified" },
  { name: "merge:false + findings -> blocked (a block must NAME a symbol)",
    body: { merge: false, hallucinated: ["Widget is not defined in this repo"] },
    status: 200, want: "blocked" },
  { name: "401 -> unverified",        body: { error: { message: "bad key" } }, status: 401, want: "unverified" },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const server = createServer((req, res) => {
    res.writeHead(c.status, { "content-type": "application/json" });
    res.end(JSON.stringify(c.body));
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const diff = unifiedDiff([{ path: "estelle.instrumentation.ts", contents: "export const x = 1;\n", kind: "create" }]);
  const v = await gateWrites(`http://127.0.0.1:${port}`, "test-key", diff, "o/n");
  server.close();
  const ok = v.outcome === c.want;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${c.name}  -> got ${v.outcome}`);
  if (!ok) { fail++; console.log(`        detail: ${v.detail}`); } else pass++;
  if (c.want === "blocked" && v.findings.length === 0) { console.log("  FAIL  blocked verdict carried no findings"); fail++; }
}
// no key at all
const nk = await gateWrites("http://127.0.0.1:1", "", "diff", "o/n");
console.log(`  ${nk.outcome === "unverified" ? "PASS" : "FAIL"}  no key -> ${nk.outcome}`);
nk.outcome === "unverified" ? pass++ : fail++;
// unreachable server
const un = await gateWrites("http://127.0.0.1:1", "k", unifiedDiff([{path:"a.ts",contents:"x\n",kind:"create"}]), "o/n");
console.log(`  ${un.outcome === "unverified" ? "PASS" : "FAIL"}  unreachable -> ${un.outcome}  (fail-OPEN would be a lie)`);
un.outcome === "unverified" ? pass++ : fail++;
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
