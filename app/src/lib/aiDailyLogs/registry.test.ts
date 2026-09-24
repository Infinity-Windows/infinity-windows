// What the Forge AI daily log can do, read from the source itself: the model's
// only daily-log tool records answers, and the only writer the reviewed Save
// calls is append_daily_log_contribution. file_daily_log (the manual editor's
// whole-row upsert, still used by lib/dailyLogs.ts and the offline outbox) is
// never reachable from the AI path, including the shared Ask function.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DAILY_LOG_TOOLS } from "../../../../supabase/functions/_shared/aiDailyLog";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../../..");
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}
const AI_PATH = [
  ...sources(join(ROOT, "app/src/lib/aiDailyLogs")),
  ...sources(join(ROOT, "app/src/components/aiDailyLogs")),
  join(ROOT, "supabase/functions/_shared/aiDailyLog.ts"),
  ...sources(join(ROOT, "supabase/functions/ask")),
];

describe("the AI daily log's only doors", () => {
  it("the model gets exactly one daily-log tool, and it records answers", () => {
    expect(DAILY_LOG_TOOLS.map((t) => t.name)).toEqual(["record_daily_log_answers"]);
  });

  it("nothing on the AI path (daily-log modules, the card, the shared Ask function) names file_daily_log or writes daily_logs directly", () => {
    expect(AI_PATH.length).toBeGreaterThan(8);
    for (const file of AI_PATH) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/file_daily_log|enqueueDailyLog|fileDailyLog/);
      expect(text, file).not.toMatch(/from\(\s*["']daily_logs["']\s*\)\s*\.(insert|upsert|update|delete)/);
    }
  });

  it("the reviewed Save calls append_daily_log_contribution, and only that RPC writes", () => {
    const save = readFileSync(join(HERE, "save.ts"), "utf8");
    const rpcs = [...save.matchAll(/\.rpc\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(rpcs.sort()).toEqual(["append_daily_log_contribution", "daily_log_contribution_photo_status"]);
  });
});
