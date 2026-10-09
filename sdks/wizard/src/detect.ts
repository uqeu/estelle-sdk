/**
 * Which framework is this, and where is its composition root?
 *
 * Detection reads manifests and the filesystem — never a model, never the network. A wizard that
 * guesses wrong writes a file into the wrong place, and the customer's first experience of Estelle is
 * a broken build. So every detector names the EVIDENCE it matched, the plan prints it, and a project
 * nothing matches is reported as unknown rather than forced into the closest guess.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Frameworks with a composition root we know how to write into. */
export type Framework =
  | "nextjs" | "express" | "fastify" | "node"
  | "fastapi" | "django" | "flask" | "python"
  | "unknown";

export interface Detection {
  framework: Framework;
  /** Human-readable reason, printed in the plan. A detection with no evidence is not a detection. */
  evidence: string;
  /** `python` | `node` — decides which package we tell them to install. */
  runtime: "node" | "python" | "unknown";
  /** Files that already exist and would be EDITED rather than created. */
  wouldEdit: string[];
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function deps(pkg: Record<string, unknown> | null): Set<string> {
  const out = new Set<string>();
  for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
    const block = pkg?.[key];
    if (block && typeof block === "object") {
      for (const name of Object.keys(block as Record<string, unknown>)) out.add(name);
    }
  }
  return out;
}

function pythonRequirements(root: string): string {
  // Read every place a Python dependency is conventionally declared, because a project that uses
  // Poetry has no requirements.txt and a project that uses pip has no [tool.poetry].
  let text = "";
  for (const name of ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py", "setup.cfg"]) {
    const path = join(root, name);
    if (existsSync(path)) {
      try { text += readFileSync(path, "utf8").toLowerCase() + "\n"; } catch { /* unreadable is absent */ }
    }
  }
  return text;
}

export function detect(root: string): Detection {
  const pkg = readJson(join(root, "package.json"));
  const node = deps(pkg);
  const py = pythonRequirements(root);
  const edits: string[] = [];

  if (node.has("next")) {
    for (const f of ["instrumentation.ts", "instrumentation.js", "next.config.ts", "next.config.js", "next.config.mjs"]) {
      if (existsSync(join(root, f))) edits.push(f);
    }
    return { framework: "nextjs", runtime: "node", wouldEdit: edits,
             evidence: "`next` in package.json dependencies" };
  }
  if (node.has("express")) {
    return { framework: "express", runtime: "node", wouldEdit: edits,
             evidence: "`express` in package.json dependencies" };
  }
  if (node.has("fastify")) {
    return { framework: "fastify", runtime: "node", wouldEdit: edits,
             evidence: "`fastify` in package.json dependencies" };
  }
  if (/\bfastapi\b/.test(py)) {
    return { framework: "fastapi", runtime: "python", wouldEdit: edits,
             evidence: "`fastapi` named in a Python dependency file" };
  }
  if (/\bdjango\b/.test(py) || existsSync(join(root, "manage.py"))) {
    if (existsSync(join(root, "manage.py"))) edits.push("manage.py");
    return { framework: "django", runtime: "python", wouldEdit: edits,
             evidence: existsSync(join(root, "manage.py"))
               ? "manage.py at the repository root" : "`django` named in a Python dependency file" };
  }
  if (/\bflask\b/.test(py)) {
    return { framework: "flask", runtime: "python", wouldEdit: edits,
             evidence: "`flask` named in a Python dependency file" };
  }
  if (pkg) {
    return { framework: "node", runtime: "node", wouldEdit: edits,
             evidence: "package.json present, no framework matched" };
  }
  if (py) {
    return { framework: "python", runtime: "python", wouldEdit: edits,
             evidence: "a Python dependency file is present, no framework matched" };
  }
  return { framework: "unknown", runtime: "unknown", wouldEdit: [],
           evidence: "no package.json and no Python dependency file at this path" };
}

/**
 * Does the project ALREADY emit OpenTelemetry?
 *
 * ⛔ This is the most important question the wizard asks, and it is the one that makes the whole tool
 * optional. A project already exporting OTLP needs NO code and NO package from us — two environment
 * variables point its existing exporter at Estelle and everything works: spans, logs, metrics, errors,
 * GenAI facts and symbol binding. Verified end to end against production.
 *
 * A wizard that writes instrumentation into a project that already has it has created a duplicate
 * telemetry path and a support ticket.
 */
export function alreadyEmitsOtel(root: string): boolean {
  const node = deps(readJson(join(root, "package.json")));
  for (const name of node) if (name.startsWith("@opentelemetry/")) return true;
  return /opentelemetry|opentelemetry-sdk|opentelemetry-api/.test(pythonRequirements(root));
}
