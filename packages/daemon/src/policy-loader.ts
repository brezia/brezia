import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import chokidar, { type FSWatcher } from "chokidar";
import { PolicySchema, type Policy } from "@brezia/shared";

// Never fail open: if no policy is loaded, everything is unmatched → ask.
export const SAFE_DEFAULT_POLICY: Policy = {
  version: 1,
  defaults: { unmatched: "ask" },
  tiers: [],
};

export interface LoadResult {
  ok: boolean;
  policy?: Policy;
  error?: string;
}

// Read → parse YAML → validate against PolicySchema. Pure w.r.t. process state;
// every failure mode returns an error string rather than throwing.
export function loadPolicyFile(path: string): LoadResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { ok: false, error: `cannot read policy file ${path}: ${(e as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    return { ok: false, error: `invalid YAML in ${path}: ${(e as Error).message}` };
  }
  const result = PolicySchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first ? `${first.path.join(".") || "(root)"}: ${first.message}` : "unknown";
    return { ok: false, error: `policy ${path} failed validation — ${where}` };
  }
  return { ok: true, policy: result.data };
}

// Holds the live policy. Reload is parse → validate → atomic swap; an invalid
// file keeps the previous policy and records the error (never crash, never fail
// open). The reference assignment in load() is the atomic swap.
export class PolicyStore {
  private current: Policy;
  private lastError: string | null = null;
  private watcher: FSWatcher | null = null;

  constructor(initial: Policy = SAFE_DEFAULT_POLICY) {
    this.current = initial;
  }

  getPolicy(): Policy {
    return this.current;
  }

  getError(): string | null {
    return this.lastError;
  }

  // Load once. On success swap and clear the error; on failure keep the current
  // policy and record the error. Returns whether the load succeeded.
  load(path: string): boolean {
    const r = loadPolicyFile(path);
    if (r.ok && r.policy !== undefined) {
      this.current = r.policy; // atomic swap
      this.lastError = null;
      return true;
    }
    this.lastError = r.error ?? "unknown policy load error";
    return false;
  }

  // Hot reload on file change. Invalid reloads keep the old policy.
  watch(path: string, onReload?: (ok: boolean, error: string | null) => void): void {
    this.watcher = chokidar.watch(path, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 30 },
    });
    const reload = (): void => {
      const ok = this.load(path);
      onReload?.(ok, this.lastError);
    };
    this.watcher.on("change", reload);
    this.watcher.on("add", reload);
  }

  async close(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
  }
}
