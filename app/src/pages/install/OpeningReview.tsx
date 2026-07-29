import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { listProjects } from "../../lib/api";
import { WindowTypePicker } from "../../components/WindowTypePicker";
import { SpecReviewSection } from "../../components/install/SpecReviewSection";
import {
  addOpening,
  confirmOpenings,
  deleteOpening,
  listMarkSpecs,
  listOpenings,
  updateOpening,
} from "../../lib/install/api";
import type { ProjectOpening } from "../../lib/install/types";
import { openingMarkCode } from "../../lib/install/types";
import { openingUnitKindResolver } from "../../lib/install/unitKind";
import { describeMarkCount } from "../../lib/install/extract";
import { formatApiError } from "../../lib/install/errors";

export function OpeningReview() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [newCode, setNewCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const project = projects.data?.find((p) => p.id === projectId);
  const openings = useQuery({
    queryKey: ["openings", projectId],
    queryFn: () => listOpenings(projectId),
  });
  const markSpecs = useQuery({
    queryKey: ["markSpecs", projectId],
    queryFn: () => listMarkSpecs(projectId),
    enabled: !!projectId,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
    queryClient.invalidateQueries({ queryKey: ["projectWindows", projectId] });
  };

  const patch = useMutation({
    mutationFn: (args: { id: string; patch: Parameters<typeof updateOpening>[1] }) =>
      updateOpening(args.id, args.patch),
    onSuccess: refresh,
    onError: (e) => setMessage(formatApiError(e)),
  });

  const remove = useMutation({
    mutationFn: deleteOpening,
    onSuccess: refresh,
    onError: (e) => setMessage(formatApiError(e)),
  });

  const add = useMutation({
    mutationFn: (code: string) =>
      addOpening(projectId, { opening_code: code.toUpperCase() }),
    onSuccess: () => {
      setNewCode("");
      refresh();
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const confirm = useMutation({
    mutationFn: () => confirmOpenings(projectId),
    onSuccess: () => {
      refresh();
      queryClient.invalidateQueries({ queryKey: ["projectWindows", projectId] });
      navigate(`/projects/${projectId}?tab=map`);
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const drafts = (openings.data ?? []).filter((o) => !o.confirmed);
  const confirmed = (openings.data ?? []).filter((o) => o.confirmed);

  const markSummary = (() => {
    const unitKind = openingUnitKindResolver(markSpecs.data ?? []);
    const map = new Map<string, { mark: string; count: number; door: boolean }>();
    for (const o of drafts) {
      const mark = openingMarkCode(o.opening_code);
      const door = unitKind(o) === "door";
      const key = `${door ? "d" : "w"}:${mark}`;
      const cur = map.get(key);
      if (cur) cur.count += 1;
      else map.set(key, { mark, count: 1, door });
    }
    return [...map.values()].sort((a, b) => a.mark.localeCompare(b.mark));
  })();

  const row = (o: ProjectOpening) => (
    <li key={o.id} className="opening-review-row">
      <input
        className="opening-code-input"
        defaultValue={o.opening_code}
        onBlur={(e) => {
          const v = e.target.value.trim().toUpperCase();
          if (v && v !== o.opening_code) {
            patch.mutate({ id: o.id, patch: { opening_code: v } });
          }
        }}
      />
      <WindowTypePicker
        variant="select"
        value={o.window_type_id ?? null}
        onChange={(id) =>
          patch.mutate({
            id: o.id,
            patch: { window_type_id: id || null },
          })
        }
      />
      <input
        placeholder="Location (e.g. Living room N)"
        defaultValue={o.label ?? ""}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v !== (o.label ?? "")) {
            patch.mutate({ id: o.id, patch: { label: v || null } });
          }
        }}
      />
      {o.status === "planned" && (
        <button className="link" onClick={() => remove.mutate(o.id)}>
          Remove
        </button>
      )}
    </li>
  );

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Openings</p>
          <h1>{project?.job_code ?? "Review"}</h1>
        </div>
        <Link to={`/projects/${projectId}?tab=map`} className="back-chip" aria-label="Map">
          ‹
        </Link>
      </header>

      {message && <p className="error">{message}</p>}

      {drafts.length > 0 && (
        <>
          <h2>Extracted drafts ({drafts.length}) — confirm before install</h2>
          {markSummary.length > 0 && (
            <p className="scanner-hint">
              We found{" "}
              {markSummary
                .map((m) =>
                  describeMarkCount({
                    mark: m.mark,
                    count: m.count,
                    kind: m.door ? "door" : "window",
                  }),
                )
                .join(", ")}{" "}
              — accept or fix below.
            </p>
          )}
          <p className="muted">
            Fix codes and types where the extract got it wrong. Confirmed
            openings are never overwritten by a re-extract. A mark is the number
            written on the plan beside a type of window — mark #14 appearing 25
            times means 25 separate windows, all the same.
          </p>
          <ul className="unit-list">{drafts.map(row)}</ul>
          <button
            className="primary big"
            disabled={confirm.isPending}
            onClick={() => confirm.mutate()}
          >
            Confirm all {drafts.length} openings
          </button>
        </>
      )}

      <h2>Confirmed ({confirmed.length})</h2>
      <ul className="unit-list">{confirmed.map(row)}</ul>
      {confirmed.length === 0 && drafts.length === 0 && (
        <p className="muted">
          Nothing yet.{" "}
          <Link to={`/projects/${projectId}/upload`}>Upload specs</Link> or
          add openings by hand below.
        </p>
      )}

      <SpecReviewSection projectId={projectId} />

      <h2>Add opening</h2>
      <div className="manual-entry">
        <input
          value={newCode}
          onChange={(e) => setNewCode(e.target.value)}
          placeholder="Opening code, e.g. W7"
          onKeyDown={(e) =>
            e.key === "Enter" && newCode.trim() && add.mutate(newCode.trim())
          }
        />
        <button
          onClick={() => newCode.trim() && add.mutate(newCode.trim())}
          disabled={add.isPending}
        >
          Add
        </button>
      </div>
    </div>
  );
}
