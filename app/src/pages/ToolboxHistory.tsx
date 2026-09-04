// Toolbox talk history — Horizon's key idea ported: a MISSED day is a
// first-class record, not an absence. Every day in the window that had a
// talk shows as signed (emerald) or missed (red), so the record reads like
// the compliance story it is. Signed days keep their archived PDF link.

import { BackChip } from "../components/BackChip";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { SkeletonList } from "../components/ui/States";
import { getMyProfile } from "../lib/install/api";
import { isGroupSignIn, listMyCompletions, signedRecordUrl } from "../lib/toolbox";
import { useT } from "../lib/i18n";
import { supabase } from "../lib/supabase";

interface DayTalk {
  id: string;
  title: string;
  talk_date: string;
}

async function listTalksSince(sinceISO: string): Promise<DayTalk[]> {
  const { data, error } = await supabase
    .from("safety_talks")
    .select("id, title, talk_date")
    .gte("talk_date", sinceISO)
    .order("talk_date", { ascending: false });
  if (error) throw error;
  return (data ?? []) as DayTalk[];
}

function PdfButton({ path }: { path: string }) {
  const [loading, setLoading] = useState(false);
  return (
    <button
      type="button"
      className="button-like"
      disabled={loading}
      onClick={async () => {
        setLoading(true);
        const url = await signedRecordUrl(path);
        setLoading(false);
        if (url) window.open(url, "_blank", "noopener");
      }}
    >
      {loading ? "…" : "PDF"}
    </button>
  );
}

export function ToolboxHistory() {
  // Plain English page; only the group sign-in line is translated, for the
  // same reason it is on the Safety page.
  const t = useT();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const [days, setDays] = useState<30 | 90>(30);
  const sinceISO = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - days);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }, [days]);

  const talks = useQuery({
    queryKey: ["talkDays", sinceISO],
    queryFn: () => listTalksSince(sinceISO),
  });
  const mine = useQuery({
    queryKey: ["toolboxHistory", me.data?.id],
    queryFn: () => listMyCompletions(me.data!.id),
    enabled: Boolean(me.data?.id),
  });

  const rows = useMemo(() => {
    // List is newest-first; keep the newest completion per talk (legacy
    // pre-rotation data can hold several signatures on one talk row).
    const byTalkId = new Map<string, (typeof mine.data & object)[number]>();
    for (const c of mine.data ?? []) {
      if (c.talk_id && !byTalkId.has(c.talk_id)) byTalkId.set(c.talk_id, c);
    }
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const todayISO = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    // One row per talk day; a day with a talk and no signature is "missed"
    // (today stays "pending" until it's over).
    const seen = new Set<string>();
    const out: {
      date: string;
      title: string;
      state: "signed" | "missed" | "pending";
      signedAt?: string;
      pdfPath?: string | null;
      /** A supervisor's attestation, not this person's signature. */
      group?: boolean;
    }[] = [];
    for (const t of talks.data ?? []) {
      if (seen.has(t.talk_date)) continue;
      seen.add(t.talk_date);
      const c = byTalkId.get(t.id);
      out.push({
        date: t.talk_date,
        title: t.title,
        state: c ? "signed" : t.talk_date === todayISO ? "pending" : "missed",
        signedAt: c?.signed_at,
        pdfPath: c?.pdf_path,
        // This is somebody's own compliance record. A day a supervisor
        // attested for them must not read back to them as "signed 7:03 AM".
        group: isGroupSignIn(c),
      });
    }
    return out;
  }, [talks.data, mine.data]);

  const signedCount = rows.filter((r) => r.state === "signed").length;
  const missedCount = rows.filter((r) => r.state === "missed").length;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Toolbox talk history</h1>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            <span className="tcx-on">{signedCount} signed</span>
            {missedCount > 0 && (
              <span style={{ color: "var(--danger, #f87171)" }}>
                {" "}· {missedCount} missed
              </span>
            )}
          </p>
        </div>
        <BackChip fallback="/safety" label="Back" />
      </header>

      <div className="seg" role="group" aria-label="Window">
        {([30, 90] as const).map((d) => (
          <button
            key={d}
            className={days === d ? "button-like active-pill" : "button-like"}
            onClick={() => setDays(d)}
          >
            {d} days
          </button>
        ))}
      </div>

      {(talks.isLoading || mine.isLoading) && <SkeletonList rows={5} />}
      <ul className="unit-list" style={{ marginTop: 10 }}>
        {rows.map((r) => (
          <li key={r.date} className="find-row">
            {r.state === "signed" ? (
              <CheckCircle2 size={16} style={{ color: "#34d399", flex: "none" }} aria-hidden />
            ) : r.state === "missed" ? (
              <XCircle size={16} style={{ color: "#f87171", flex: "none" }} aria-hidden />
            ) : (
              <span className="tcx-dot off" aria-hidden />
            )}
            <div style={{ minWidth: 0, flex: 1 }}>
              <strong style={{ fontSize: 13 }}>{r.title}</strong>
              <div className="muted" style={{ fontSize: 11.5 }}>
                {new Date(`${r.date}T00:00:00`).toLocaleDateString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                })}
                {r.state === "signed" && r.signedAt && " · "}
                {r.state === "signed" && r.signedAt && (
                  r.group
                    ? t("toolbox.group.historyLine", {
                        time: new Date(r.signedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
                      })
                    : `signed ${new Date(r.signedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
                )}
                {r.state === "missed" && " · not signed"}
                {r.state === "pending" && " · today — not signed yet"}
              </div>
            </div>
            {r.pdfPath && <PdfButton path={r.pdfPath} />}
          </li>
        ))}
        {rows.length === 0 && !talks.isLoading && (
          <p className="muted">No talks in this window yet.</p>
        )}
      </ul>
    </div>
  );
}
