import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { listOpenings } from "../../lib/install/api";
import {
  findReplacementOpening,
  recallOpening,
} from "../../lib/install/staleOpening";

/**
 * What an installer sees when the link they are holding points at an opening
 * that no longer exists — almost always because the office pressed "Load marks
 * from plans" while they had the window open, which replaces every opening row
 * with a new one.
 *
 * "Opening not found." is the worst possible answer to someone standing at a
 * wall. The same window is still on the plans under the same code, so we go
 * and find it: same code, we take them straight there; same mark only, we
 * offer it; nothing at all, we hand them back their work.
 */
export function OpeningMoved({
  projectId,
  openingId,
}: {
  projectId: string;
  openingId: string;
}) {
  const navigate = useNavigate();
  const remembered = useMemo(() => recallOpening(openingId), [openingId]);
  const lostCode = remembered?.code ?? null;
  const jobId = remembered?.projectId || projectId;

  const openings = useQuery({
    queryKey: ["openings", jobId],
    queryFn: () => listOpenings(jobId),
    enabled: Boolean(jobId),
  });

  const recovery = useMemo(
    () =>
      lostCode && openings.data
        ? findReplacementOpening(openings.data, lostCode)
        : null,
    [openings.data, lostCode],
  );

  // An exact code match is the same physical opening on the reloaded plans —
  // no reason to make them tap anything.
  useEffect(() => {
    if (!recovery?.exact) return;
    navigate(`/projects/${jobId}/opening/${recovery.opening.id}`, {
      replace: true,
      state: { movedFrom: recovery.opening.opening_code },
    });
  }, [recovery, jobId, navigate]);

  if (openings.isLoading) {
    return (
      <div className="page">
        <p className="muted">Finding this opening on the latest plans…</p>
      </div>
    );
  }

  if (recovery?.exact) {
    return (
      <div className="page">
        <p className="muted">Taking you to {recovery.opening.opening_code}…</p>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>This opening moved</h1>
      <p>
        The office reloaded the plans for this job, so{" "}
        {lostCode ? <strong>{lostCode}</strong> : "this unit"} has a new
        entry. Nothing you have recorded is lost.
      </p>

      {recovery && (
        <p>
          The closest match on the current plans is{" "}
          <strong>{recovery.opening.opening_code}</strong> — same mark.
        </p>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {recovery && (
          <button
            className="primary big"
            onClick={() =>
              navigate(`/projects/${jobId}/opening/${recovery.opening.id}`, {
                replace: true,
              })
            }
          >
            Open {recovery.opening.opening_code}
          </button>
        )}
        <Link className="action-btn" to={`/projects/${jobId}?tab=map`}>
          All openings on this job
        </Link>
        <Link className="action-btn" to="/my-work">
          Back to my work
        </Link>
      </div>
    </div>
  );
}
