import { supabase } from "./supabase";

export type PointKind = "install" | "par" | "photos" | "teach" | "quality" | "quiz";

export interface PointEntry {
  kind: PointKind;
  points: number;
}

export type PointStatus = "pending" | "confirmed" | "void";

export interface LedgerRow {
  id: string;
  profile_id: string;
  kind: string;
  points: number;
  status: PointStatus;
  created_at: string;
}

export const POINT_RULES = {
  installBase: 20,
  parBeat: 15, // finished at or under par time
  photos: 10, // proof photos attached
  teach: 15, // recorded a voice memo for the crew brain
  quality: 5, // grade >= 4
  quizPerCorrect: 10,
};

/** Points earned for one install submit. Pure + testable. */
export function computeInstallPoints(input: {
  minutes: number | null;
  parMinutes: number | null;
  grade: number | null;
  hasPhotos: boolean;
  hasMemo: boolean;
}): PointEntry[] {
  const out: PointEntry[] = [{ kind: "install", points: POINT_RULES.installBase }];
  if (input.minutes != null && input.parMinutes != null && input.minutes <= input.parMinutes) {
    out.push({ kind: "par", points: POINT_RULES.parBeat });
  }
  if (input.hasPhotos) out.push({ kind: "photos", points: POINT_RULES.photos });
  if (input.hasMemo) out.push({ kind: "teach", points: POINT_RULES.teach });
  if (input.grade != null && input.grade >= 4) {
    out.push({ kind: "quality", points: POINT_RULES.quality });
  }
  return out;
}

export function sumPoints(entries: PointEntry[]): number {
  return entries.reduce((s, e) => s + e.points, 0);
}

export async function awardPoints(
  profileId: string,
  entries: PointEntry[],
  ref?: string,
  status: PointStatus = "confirmed",
): Promise<void> {
  if (entries.length === 0) return;
  const { error } = await supabase.from("points_ledger").insert(
    entries.map((e) => ({
      profile_id: profileId,
      kind: e.kind,
      points: e.points,
      ref: ref ?? null,
      status,
    })),
  );
  if (error) throw error;
}

/** Confirm (QC pass) or void (callback) pending install points for a ref. */
export async function resolvePendingPoints(
  ref: string,
  status: "confirmed" | "void",
): Promise<void> {
  const { error } = await supabase
    .from("points_ledger")
    .update({ status })
    .eq("ref", ref)
    .eq("status", "pending");
  if (error) throw error;
}

export async function listLedger(profileId: string): Promise<LedgerRow[]> {
  const { data, error } = await supabase
    .from("points_ledger")
    .select("*")
    .eq("profile_id", profileId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as LedgerRow[];
}

export interface LeaderRow {
  profile_id: string;
  display_name: string;
  points: number;
}

export async function getPointsLeaderboard(): Promise<LeaderRow[]> {
  const [ledger, profiles] = await Promise.all([
    supabase.from("points_ledger").select("profile_id, points").eq("status", "confirmed"),
    supabase.from("profiles").select("id, display_name"),
  ]);
  if (ledger.error) throw ledger.error;
  if (profiles.error) throw profiles.error;
  const name = new Map((profiles.data ?? []).map((p) => [p.id, p.display_name]));
  const totals = new Map<string, number>();
  for (const r of ledger.data ?? []) {
    totals.set(r.profile_id, (totals.get(r.profile_id) ?? 0) + Number(r.points));
  }
  return [...totals.entries()]
    .map(([id, points]) => ({ profile_id: id, display_name: name.get(id) ?? "crew", points }))
    .sort((a, b) => b.points - a.points);
}
