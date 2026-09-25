// Learn → "Using Forge": narrated walkthroughs of proposed app designs, one per
// role floor (lib/appTraining.ts has the rules, docs/role-training-videos.md the
// runbook). Loaded lazily from Education.tsx so neither this screen nor its
// dictionary rides in the entry chunk.
//
// Deliberately records NOTHING. Education.tsx pauses its learning-time clock
// while this tab is open, and nothing here calls a points, quiz, clearance or
// "watched" write. A design preview is not study time and not an instruction.

import { Suspense, useEffect, useMemo, useState } from "react";
import { lazyOptional } from "../../lib/pwa/lazyOptional";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clapperboard } from "lucide-react";
import { listTrainingVideos, trainingRoleRank, visibleTrainingVideos, type TrainingVideo } from "../../lib/appTraining";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { useOnline, useSignedInUserId } from "../../lib/useAppTraining";
import { EmptyState, SkeletonList } from "../ui/States";
import { useUsingForgeT, type UsingForgeT } from "./usingForgeCopy";
import { DesignPreviewNotice, TrainingPlayer } from "./TrainingPlayer";
import "./usingForge.css";

// An extra under the walkthroughs, so a failed download hides only itself
// (lib/pwa/lazyOptional.tsx).
const TrainingImporter = lazyOptional(() => import("./TrainingImporter"));

export default function UsingForge() {
  const t = useUsingForgeT();
  const queryClient = useQueryClient();
  const { effectiveRole, isLoading: roleLoading } = useEffectiveRole();
  const { ready, userId } = useSignedInUserId();
  const online = useOnline();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // A different person on this phone: close whatever was open and drop every
  // other account's copy of the catalog (transcripts included). The query is
  // keyed by user id, so the new person's read can never be served the old
  // person's answer — this makes sure the old answer is not even kept.
  useEffect(() => {
    setSelectedId(null);
    queryClient.removeQueries({
      queryKey: ["appTrainingVideos"],
      predicate: (q) => q.queryKey[1] !== userId,
    });
  }, [userId, queryClient]);

  const catalog = useQuery({
    queryKey: ["appTrainingVideos", userId],
    queryFn: listTrainingVideos,
    enabled: ready && Boolean(userId),
    staleTime: 5 * 60_000,
  });

  const videos = useMemo(
    () => visibleTrainingVideos(catalog.data ?? [], effectiveRole),
    [catalog.data, effectiveRole],
  );
  const selected = videos.find((v) => v.id === selectedId) ?? null;

  // A preview role that cannot see the open walkthrough closes it for good —
  // switching the preview back must not quietly reopen a leadership video.
  useEffect(() => {
    if (selectedId && !selected && catalog.data) setSelectedId(null);
  }, [selectedId, selected, catalog.data]);

  if (selected && userId) {
    return (
      <div className="using-forge">
        <TrainingPlayer
          // Remount for a new person or a new video: no state, no element and
          // no media handle survives either change.
          key={`${userId}:${selected.id}`}
          video={selected}
          userId={userId}
          onBack={() => setSelectedId(null)}
        />
      </div>
    );
  }

  const waiting = !ready || roleLoading || (Boolean(userId) && catalog.isPending);

  return (
    <div className="using-forge">
      <header className="uf-intro">
        <h2>{t("uf.title")}</h2>
        <p className="muted">{t("uf.intro")}</p>
        <p className="uf-not-counted">{t("uf.notCounted")}</p>
      </header>

      {waiting ? (
        <div role="status" aria-live="polite">
          <span className="uf-sr-only">{t("uf.loadingList")}</span>
          <SkeletonList rows={3} />
        </div>
      ) : catalog.isError ? (
        <div className="uf-problem" role="alert">
          <p className="uf-problem-title">{online ? t("uf.listFailed") : t("uf.offline")}</p>
          {online && <p className="muted">{t("uf.tryLater")}</p>}
          <button type="button" className="button-like" onClick={() => void catalog.refetch()}>
            {t("uf.retry")}
          </button>
        </div>
      ) : videos.length === 0 ? (
        <EmptyState
          icon={<Clapperboard size={22} />}
          title={t("uf.empty.title")}
          message={t("uf.empty.msg")}
        />
      ) : (
        <ul className="uf-cards">
          {videos.map((v) => (
            <li key={v.id}>
              <WalkthroughCard video={v} t={t} onWatch={() => setSelectedId(v.id)} />
            </li>
          ))}
        </ul>
      )}

      <LiveAppApart t={t} />
      {userId && (trainingRoleRank(effectiveRole) ?? -1) >= 2 && (
        <Suspense fallback={null}>
          <TrainingImporter key={userId} />
        </Suspense>
      )}
    </div>
  );
}

function WalkthroughCard({
  video,
  t,
  onWatch,
}: {
  video: TrainingVideo;
  t: UsingForgeT;
  onWatch: () => void;
}) {
  const headingId = `uf-card-${video.id}`;
  return (
    <article className="uf-card" aria-labelledby={headingId}>
      <DesignPreviewNotice video={video} t={t} compact />
      <h3 id={headingId}>{video.title}</h3>
      <p className="uf-meta">
        <span className="uf-scope">{t(`uf.scope.${video.slug}`)}</span>
        <span>{t("uf.minutes", { n: Math.max(1, Math.round(video.durationSeconds / 60)) })}</span>
        <span>{t(`uf.narration.${video.language}`)}</span>
      </p>
      <button
        type="button"
        className="primary uf-watch"
        onClick={onWatch}
        aria-label={t("uf.watchNamed", { title: video.title })}
      >
        {t("uf.watch")}
      </button>
    </article>
  );
}

/** Real work stays on real screens. Kept apart from the videos on purpose, and
 * carrying no buttons of its own: nothing a walkthrough shows should look like
 * a shortcut to doing it. */
export function LiveAppApart({ t }: { t: UsingForgeT }) {
  return (
    <aside className="uf-live-apart">
      <p className="uf-live-apart-title">{t("uf.liveApart.title")}</p>
      <p className="muted">{t("uf.liveApart.body")}</p>
    </aside>
  );
}
