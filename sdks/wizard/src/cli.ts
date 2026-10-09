#!/usr/bin/env node
/**
 * `npx @fatelabs/estelle-wizard` — install Estelle monitoring, or prove it is working.
 *
 * Two commands and no magic:
 *   install (default)  print the plan, then write it only when the human agrees
 *   audit              send a span and READ IT BACK, which is the only proof that counts
 *
 * ⛔ It never runs your package manager. It prints the one command to run and lets you run it, so
 * nothing lands in your lockfile without you typing it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { audit } from "./audit.js";
import { gateWrites, unifiedDiff, type GateVerdict } from "./gate.js";
import { gitState, preview } from "./gitsafety.js";
import { alreadyEmitsOtel, detect } from "./detect.js";
import { buildPlan, type Plan } from "./plan.js";

const BOLD = "\u001b[1m", DIM = "\u001b[2m", RESET = "\u001b[0m";
const GREEN = "\u001b[32m", RED = "\u001b[31m", YELLOW = "\u001b[33m";

function say(line = ""): void { stdout.write(line + "\n"); }

function printPlan(plan: Plan, root: string): void {
  say();
  say(`${BOLD}Estelle monitoring${RESET}  ${DIM}${root}${RESET}`);
  say(`${DIM}detected${RESET} ${plan.framework}  ${DIM}— ${plan.evidence}${RESET}`);
  say();
  if (plan.writes.length === 0) {
    say(`${GREEN}Nothing to write.${RESET}`);
  } else {
    say(`${BOLD}Files${RESET}`);
    for (const write of plan.writes) {
      const verb = write.kind === "create" ? "create" : write.kind === "append" ? "append to" : "edit";
      say(`  ${verb.padEnd(10)} ${write.path}`);
      say(`  ${DIM}${" ".repeat(10)} ${write.why}${RESET}`);
    }
  }
  if (plan.commands.length) {
    say();
    say(`${BOLD}Then run, yourself${RESET}  ${DIM}(the wizard will not touch your lockfile)${RESET}`);
    for (const command of plan.commands) say(`  ${command}`);
  }
  if (plan.notes.length) {
    say();
    for (const note of plan.notes) say(`  ${note}`);
  }
  say();
}

function applyWrite(root: string, path: string, kind: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  if (kind === "append" && existsSync(target)) appendFileSync(target, contents, "utf8");
  else writeFileSync(target, contents, "utf8");
}

function readEnvFile(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [".env.estelle", ".env"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    try {
      for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
        // ⛔ First file wins per key, so .env.estelle overrides .env rather than the other way round.
        if (match?.[1] && !(match[1] in out)) out[match[1]] = (match[2] ?? "").trim();
      }
    } catch { /* unreadable is absent */ }
  }
  return out;
}

function printVerdict(verdict: GateVerdict): void {
  // ⛔ THE THREE OUTCOMES PRINT DIFFERENTLY OR THE CHECK IS DECORATION. "We could not check this" and
  // "we checked this and it is clean" are opposite facts, and a generator that renders them the same
  // has told the user its output is proven when nothing was proven.
  if (verdict.outcome === "verified") {
    say(`${GREEN}${BOLD}Checked against your real code.${RESET}`);
    say(`  ${verdict.detail}`);
    if (verdict.scope) say(`  ${DIM}graph: ${verdict.scope}${RESET}`);
  } else if (verdict.outcome === "blocked") {
    say(`${RED}${BOLD}The gate refused this code.${RESET}`);
    say(`  ${verdict.detail}`);
    for (const finding of verdict.findings.slice(0, 10)) say(`    ${RED}·${RESET} ${finding}`);
  } else {
    say(`${YELLOW}Not checked.${RESET}  ${DIM}(this is "could not verify", not "verified clean")${RESET}`);
    say(`  ${verdict.detail}`);
  }
  say();
}

async function runInstall(root: string, assumeYes: boolean, dryRun: boolean): Promise<number> {
  const detection = detect(root);
  const plan = buildPlan(root, detection, alreadyEmitsOtel(root));
  printPlan(plan, root);

  if (plan.writes.length === 0) return 0;

  // 🔴 GATE OUR OWN OUTPUT BEFORE A SINGLE BYTE IS WRITTEN, AND BEFORE THE HUMAN IS ASKED.
  // Every other wizard generates and writes; this one asks Estelle's deterministic gate whether the
  // code it just produced refers to symbols the repository actually has. The check runs FIRST so a
  // refusal costs the user nothing, and its verdict is on screen BEFORE the confirmation prompt — a
  // verdict printed after the write is a report, not a gate.
  const env = { ...readEnvFile(root), ...process.env } as Record<string, string>;
  const endpoint = env["ESTELLE_ENDPOINT"] || "https://api.fatelabs.ca";
  const key = env["ESTELLE_API_KEY"] || env["ESTELLE_MONITOR_KEY"] || "";
  say(`${DIM}checking the generated code against your indexed repository…${RESET}`);
  const verdict = await gateWrites(endpoint, key, unifiedDiff(plan.writes), env["ESTELLE_REPO"] || "");
  printVerdict(verdict);
  if (verdict.outcome === "blocked") {
    say("Nothing was written. Report this — a refusal here is our bug, not yours.");
    return 1;
  }

  // SHOW WHAT WOULD LAND. Neither incumbent does this: PostHog reports changes from a hardcoded list
  // keyed on the framework id rather than from the filesystem, and Sentry shows none. A generator that
  // will not show you its output is asking for trust it has not earned.
  say(`${BOLD}What this writes${RESET}`);
  for (const line of preview(plan.writes)) say(line ? `  ${DIM}${line}${RESET}` : "");

  // ⛔ AND SAY WHOSE WORK IS AT RISK. Writing into a dirty tree mixes our output into changes the user
  // has not committed, after which `git checkout` can no longer separate them. Listing the paths BY
  // NAME is the point — "you have uncommitted changes" is not actionable, a list is.
  const git = gitState(root);
  if (!git.isRepo) {
    say(`${YELLOW}Not a git repository.${RESET} ${DIM}Nothing here can be undone with git.${RESET}`);
    if (assumeYes) {
      // Fail closed: --yes means "do not ask me", never "write into a tree I cannot roll back".
      say(`${RED}Refusing to write unattended outside a git repository.${RESET} Re-run without --yes.`);
      return 2;
    }
    say();
  } else if (git.dirty.length) {
    say(`${YELLOW}You have uncommitted changes${RESET}${git.capped ? ` ${DIM}(first ${git.dirty.length} shown — there are more)${RESET}` : ""}`);
    for (const path of git.dirty) say(`  ${DIM}${path}${RESET}`);
    say(`  ${DIM}Our files will land alongside these. Commit or stash first if you want them separable.${RESET}`);
    say();
  }

  if (dryRun) { say(`${DIM}--dry-run: nothing written.${RESET}`); return 0; }

  if (!assumeYes) {
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = (await rl.question("Write these files? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") { say("Nothing written."); return 0; }
  }

  for (const write of plan.writes) {
    const target = join(root, write.path);
    if (write.kind === "create" && existsSync(target)) {
      say(`  ${YELLOW}skipped${RESET} ${write.path} ${DIM}(already exists — the wizard never overwrites)${RESET}`);
      continue;
    }
    applyWrite(root, write.path, write.kind, write.contents);
    say(`  ${GREEN}wrote${RESET}   ${write.path}`);
  }
  say();
  say(`Put your monitor key in ${BOLD}.env.estelle${RESET}, run the install command above, then:`);
  say(`  ${BOLD}npx @fatelabs/estelle-wizard audit${RESET}`);
  say(`${DIM}which sends a span and reads it back — the only check that proves it runs.${RESET}`);
  return 0;
}

async function runAudit(root: string): Promise<number> {
  const env = { ...readEnvFile(root), ...process.env } as Record<string, string>;
  const endpoint = env["ESTELLE_ENDPOINT"] || "https://api.fatelabs.ca";
  const key = env["ESTELLE_MONITOR_KEY"] || "";
  if (!key) {
    say(`${RED}No monitor key.${RESET} Set ESTELLE_MONITOR_KEY in .env.estelle or the environment.`);
    return 2;
  }
  say(`${DIM}sending a span to ${endpoint} and reading it back…${RESET}`);
  const result = await audit(endpoint, key);
  say();
  if (result.ok && result.observed) {
    say(`${GREEN}${BOLD}Monitoring is working.${RESET}`);
    say(`  ${result.detail}`);
    say(`  ${DIM}trace ${result.traceId} · ${result.observed.spanCount} span · ` +
        `${result.observed.durationMs}ms · service ${result.observed.service} · ` +
        `read back on attempt ${result.readBackAttempts}${RESET}`);
    return 0;
  }
  say(`${RED}${BOLD}Could not confirm.${RESET}`);
  say(`  ${result.detail}`);
  say(`  ${DIM}trace ${result.traceId}${RESET}`);
  return 1;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv.find((a) => !a.startsWith("-")) ?? "install";
  const root = resolve(argv.find((a) => a.startsWith("--path="))?.slice(7) ?? process.cwd());
  const assumeYes = argv.includes("--yes") || argv.includes("-y");
  const dryRun = argv.includes("--dry-run");

  if (argv.includes("--help") || argv.includes("-h")) {
    say("estelle-wizard [install|audit] [--path=DIR] [--yes] [--dry-run]");
    say();
    say("  install   detect the framework, print a plan, write the wiring on your say-so");
    say("  audit     send a span and read it back — proves telemetry ARRIVES, not that a file exists");
    say();
    say("install gates its own generated code against your indexed symbol graph before writing,");
    say("and refuses to write if the gate says a symbol does not exist. Set ESTELLE_API_KEY to");
    say("enable that check; without it the install still works and says plainly it was unchecked.");
    process.exit(0);
  }

  let code = 0;
  if (command === "audit") code = await runAudit(root);
  else if (command === "install") code = await runInstall(root, assumeYes, dryRun);
  else { say(`unknown command: ${command}`); code = 2; }
  process.exit(code);
}

main().catch((error: unknown) => {
  say(`${RED}estelle-wizard failed:${RESET} ${(error as Error).message}`);
  process.exit(1);
});
