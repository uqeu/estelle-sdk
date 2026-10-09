/**
 * Look at what you would overwrite, before you overwrite it.
 *
 * 🔴 **NEITHER INCUMBENT SHOWS THE USER A DIFF, AND THAT IS NOT AN OVERSIGHT WE SHOULD INHERIT.**
 * Read from their source on 2026-10-09: PostHog's wizard has no diff path at all — the user is told
 * what changed by a HARDCODED outro list derived from the framework id, not from the filesystem, so it
 * reports "Created and configured initializers" whether or not it did. Sentry's wizard has no diff
 * either, but it does have the better half of this: a gate that enumerates every uncommitted and
 * untracked path BY NAME before it writes, and fails closed when it cannot ask.
 *
 * ⛔ **SENTRY'S WIZARD IS FSL-1.1-MIT, NOT MIT — NOT PERMISSIVE, AND IT FORBIDS COMPETING-PRODUCT USE
 * FOR TWO YEARS.** We are a competing product. So this is written from the IDEA, with no line taken
 * from their implementation, and it is deliberately different in shape: theirs asks one yes/no, this
 * one also prints the content it is about to write.
 *
 * The combination is what neither has: say which of the user's work is at risk, AND show exactly what
 * would land. A generator that writes into a dirty tree without saying so has mixed its output into
 * changes the user has not committed, and `git checkout` can no longer separate them.
 */
import { execFileSync } from "node:child_process";

/** Bounded before the call. A repo with more pending changes than this is reported as capped. */
const MAX_LISTED_PATHS = 40;
const GIT_TIMEOUT_MS = 5_000;

export interface GitState {
  /** false when this is not a git repository at all — which is itself a reason to stop. */
  isRepo: boolean;
  /** Uncommitted and untracked paths, capped. Empty on a clean tree. */
  dirty: string[];
  /** True when `dirty` was cut at the bound — so "N shown" is never read as "N exist". */
  capped: boolean;
}

export function gitState(root: string): GitState {
  let out: string;
  try {
    out = execFileSync("git", ["status", "--porcelain"], {
      cwd: root, encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // ⛔ Not a repo, or git is absent. Both are "we cannot tell", never "the tree is clean".
    return { isRepo: false, dirty: [], capped: false };
  }
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  return {
    isRepo: true,
    dirty: lines.slice(0, MAX_LISTED_PATHS),
    capped: lines.length > MAX_LISTED_PATHS,
  };
}

/**
 * The content preview.
 *
 * Shows the first `maxLines` of each file the plan would create. Not a unified diff on purpose: every
 * write the planner makes is a CREATE or an APPEND, so there is no before-image to diff against, and
 * rendering one would imply we had read a file we never read.
 */
export function preview(writes: { path: string; contents: string; kind: string }[],
                        maxLines = 12): string[] {
  const out: string[] = [];
  for (const write of writes) {
    const lines = write.contents.split("\n").filter((l, i, a) => !(i === a.length - 1 && l === ""));
    out.push(`${write.kind === "append" ? "append to" : "create"} ${write.path}`);
    for (const line of lines.slice(0, maxLines)) out.push(`  ${line}`);
    if (lines.length > maxLines) out.push(`  … ${lines.length - maxLines} more line(s)`);
    out.push("");
  }
  return out;
}
