// `brezia status` — diagnose the common failures: daemon not running, hook not
// installed, port taken. Read-only and defensive (a broken settings file is
// reported, never thrown).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { HOST, PORT } from "@brezia/daemon";
import { isInstalled } from "./settings";
import { getJson } from "./net";

type HookState = "installed" | "absent" | "no-file" | "unreadable";

function hookState(file: string): HookState {
  if (!existsSync(file)) return "no-file";
  try {
    return isInstalled(JSON.parse(readFileSync(file, "utf8"))) ? "installed" : "absent";
  } catch {
    return "unreadable";
  }
}

function describe(s: HookState): string {
  switch (s) {
    case "installed": return "installed ✓";
    case "absent": return "present, but the Brezia hook is not in it";
    case "no-file": return "no settings file";
    case "unreadable": return "unreadable (not valid JSON)";
  }
}

// Returns a process exit code: 0 when the daemon is up, 1 otherwise (script-friendly).
export async function runStatus(): Promise<number> {
  const url = `http://${HOST}:${PORT}`;
  const out: string[] = [];

  let up = false;
  let stats: { ratio?: number; autoResolved?: number; total?: number } | undefined;
  try {
    stats = await getJson(`${url}/v1/stats`, 2000);
    up = true;
  } catch {
    /* down */
  }

  out.push(up ? `● daemon   UP at ${url}` : `○ daemon   DOWN — nothing answering on ${url}`);
  if (up && stats) {
    out.push(`           auto-resolved (7d): ${Math.round((stats.ratio ?? 0) * 100)}% (${stats.autoResolved}/${stats.total})`);
  }

  const proj = hookState(join(process.cwd(), ".claude", "settings.json"));
  const user = hookState(join(homedir(), ".claude", "settings.json"));
  out.push(`  hook (project)  ${describe(proj)}`);
  out.push(`  hook (user)     ${describe(user)}`);

  // Actionable next steps.
  const tips: string[] = [];
  if (!up) tips.push("start the daemon:  brezia up");
  if (proj !== "installed" && user !== "installed") tips.push("install the hook:  brezia init");
  if (proj === "unreadable" || user === "unreadable") tips.push("a settings.json is not valid JSON — fix it before init/remove");
  if (tips.length > 0) {
    out.push("");
    for (const t of tips) out.push(`  → ${t}`);
  }

  process.stdout.write(out.join("\n") + "\n");
  return up ? 0 : 1;
}
