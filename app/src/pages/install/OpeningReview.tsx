import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { listProjects, listWindowTypes } from "../../lib/api";
import {
  addOpening,
  confirmOpenings,
  deleteOpening,
  listOpenings,
  updateOpening,
} from "../../lib/install/api";
import type { ProjectOpening } from "../../lib/install/types";

export function OpeningReview() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [newCode, setNewCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const project = projects.data?.find((p) => p.id === projectId);
  const types = useQuery({ queryKey: ["windowTypes"], queryFn: listWindowTypes });
  const openings = useQuery({
    queryKey: ["openings", projectId],
    queryFn: () => listOpenings(projectId),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
    queryClient.invalidateQueries({ queryKey: ["projectWindows", projectId] });
  };

  const patch = useMutation({
    mutationFn: (args: { id: string; patch: Parameters<typeof updateOpening>[1] }) =>
      updateOpening(args.id, args.patch),
    onSuccess: refresh,
    onError: (e) => setMessage(String(e)),
  });

  const remove = useMutation({
    mutationFn: deleteOpening,
    onSuccess: refresh,
    onError: (e) => setMessage(String(e)),
  });

  const add = useMutation({
    mutationFn: (code: string) =>
      addOpening(projectId, { opening_code: code.toUpperCase() }),
    onSuccess: () => {
      setNewCode("");
      refresh();
    },
    onError: (e) => setMessage(String(e)),
  });

  const confirm = useMutation({
    mutationFn: () => confirmOpenings(projectId),
    onSuccess: () => {
      refresh();
      queryClient.invalidateQueries({ queryKey: ["projectWindows", projectId] });
      navigate(`/projects/${projectId}?tab=map`);
    },
    onError: (e) => setMessage(String(e)),
  });

  const drafts = (openings.data ?? []).filter((o) => !o.confirmed);
  const confirmed = (openings.data ?? []).filter((o) => o.confirmed);

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
      <select
        value={o.window_type_id ?? ""}
        onChange={(e) =>
          patch.mutate({
            id: o.id,
            patch: { window_type_id: e.target.value || null },
          })
        }
      >
        <option value="">— pick type —</option>
        {(types.data ?? []).map((t) => (
          <option key={t.id} value={t.id}>
            {t.type_code} {t.name}
          </option>
        ))}
      </select>
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
        <h1>Openings — {project?.job_code ?? ""}</h1>
        <Link to={`/projects/${projectId}?tab=map`} className="button-like">
          Map
        </Link>
      </header>

      {message && <p className="error">{message}</p>}

      {drafts.length > 0 && (
        <>
          <h2>Extracted drafts ({drafts.length}) — confirm before install</h2>
          <p className="muted">
            Fix codes and types where the extract got it wrong. Confirmed
            openings are never overwritten by a re-extract.
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
          <Link to={`/projects/${projectId}/upload`}>Upload a planset</Link> or
          add openings by hand below.
        </p>
      )}

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
