import { BackChip } from "../components/BackChip";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getMyProfile } from "../lib/install/api";
import { isSupervisorPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { pushToast, toastError } from "../lib/toast";
import {
  createCostCode,
  listAllCostCodes,
  moveCostCode,
  setCostCodeActive,
  updateCostCode,
  type CostCode,
} from "../lib/costCodes";

type Tab = "active" | "all";

/**
 * Global cost-code library management. Leads (supervisor+) create the codes
 * crew pick when they clock in and on their timecards. One company-wide list —
 * no per-job assignment; a code is active (pickable everywhere) or archived.
 */
export function CostCodes() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const { effectiveRole } = useEffectiveRole();
  const canManage = isSupervisorPlus(effectiveRole);

  const codes = useQuery({
    queryKey: ["allCostCodes"],
    queryFn: listAllCostCodes,
    enabled: canManage,
  });

  const [tab, setTab] = useState<Tab>("active");
  const [search, setSearch] = useState("");
  const [newCode, setNewCode] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ code: string; label: string; description: string }>({
    code: "",
    label: "",
    description: "",
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["allCostCodes"] });
    // The pickers (clock-in / timecard) read the active-only list.
    void queryClient.invalidateQueries({ queryKey: ["costCodes"] });
  };

  const create = useMutation({
    mutationFn: () =>
      createCostCode({ code: newCode, label: newLabel, description: newDescription }),
    onSuccess: () => {
      pushToast("Cost code added", "info");
      setNewCode("");
      setNewLabel("");
      setNewDescription("");
      refresh();
    },
    onError: (e) => toastError(e),
  });

  const saveEdit = useMutation({
    mutationFn: (id: string) =>
      updateCostCode(id, {
        code: draft.code,
        label: draft.label,
        description: draft.description,
      }),
    onSuccess: () => {
      pushToast("Saved", "info");
      setEditing(null);
      refresh();
    },
    onError: (e) => toastError(e),
  });

  const toggleActive = useMutation({
    mutationFn: (c: CostCode) => setCostCodeActive(c.id, !c.active),
    onSuccess: (_d, c) => {
      pushToast(c.active ? "Code archived" : "Code reactivated", "info");
      refresh();
    },
    onError: (e) => toastError(e),
  });

  const move = useMutation({
    mutationFn: (args: { id: string; direction: "up" | "down" }) =>
      moveCostCode(codes.data ?? [], args.id, args.direction),
    onSuccess: refresh,
    onError: (e) => toastError(e),
  });

  const all = useMemo(() => codes.data ?? [], [codes.data]);
  const activeCount = all.filter((c) => c.active).length;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((c) => {
      if (tab === "active" && !c.active) return false;
      if (!q) return true;
      return (
        c.code.toLowerCase().includes(q) ||
        c.label.toLowerCase().includes(q) ||
        (c.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [all, search, tab]);

  if (me.data && !canManage) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Cost codes</h1>
          <BackChip fallback="/" label="Home" />
        </header>
        <p className="muted">
          Cost codes are managed by supervisors and the owner. You can still pick
          one when you clock in.
        </p>
      </div>
    );
  }

  const busy = create.isPending || saveEdit.isPending || move.isPending;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Cost codes</h1>
          <p className="muted" style={{ margin: 0 }}>
            One company-wide list. Crew pick a code when they clock in and on
            their timecard.
          </p>
        </div>
        <BackChip fallback="/" label="Home" />
      </header>

      {/* Create */}
      <div className="detail-card" style={{ display: "grid", gap: 8 }}>
        <label className="field-label">Add a cost code</label>
        <div style={{ display: "grid", gap: 8, gridTemplateColumns: "minmax(0, 1fr)" }}>
          <input
            placeholder="Code (e.g. 100)"
            value={newCode}
            onChange={(e) => setNewCode(e.target.value)}
          />
          <input
            placeholder="Name (e.g. Install — windows)"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
          />
          <input
            placeholder="Description (optional)"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
          />
        </div>
        <button
          className="primary"
          disabled={busy || !newCode.trim() || !newLabel.trim()}
          onClick={() => create.mutate()}
        >
          {create.isPending ? "Adding…" : "Add cost code"}
        </button>
      </div>

      {/* Tabs + search */}
      <div className="grade-row" style={{ marginTop: 8 }}>
        <button
          className={tab === "active" ? "grade-btn selected" : "grade-btn"}
          onClick={() => setTab("active")}
        >
          Active ({activeCount})
        </button>
        <button
          className={tab === "all" ? "grade-btn selected" : "grade-btn"}
          onClick={() => setTab("all")}
        >
          All ({all.length})
        </button>
      </div>
      <input
        placeholder="Search by code, name or description…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ marginTop: 8 }}
      />

      {codes.isLoading && <p className="muted">Loading…</p>}
      {codes.isError && <p className="error">Couldn't load cost codes.</p>}
      {!codes.isLoading && filtered.length === 0 && (
        <p className="muted">
          {all.length === 0
            ? "No cost codes yet. Add your first one above."
            : "No codes match your search."}
        </p>
      )}

      <ul className="unit-list work-list">
        {filtered.map((c) => {
          const isEdit = editing === c.id;
          // Ordering arrows act on the full library, not the filtered view.
          const orderIndex = all.findIndex((x) => x.id === c.id);
          const canMoveUp = tab === "all" && !search.trim() && orderIndex > 0;
          const canMoveDown =
            tab === "all" && !search.trim() && orderIndex < all.length - 1;
          return (
            <li key={c.id} className="find-row" style={{ flexWrap: "wrap", gap: 8 }}>
              {isEdit ? (
                <div style={{ display: "grid", gap: 6, flex: 1, minWidth: 0 }}>
                  <input
                    value={draft.code}
                    onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                    placeholder="Code"
                  />
                  <input
                    value={draft.label}
                    onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                    placeholder="Name"
                  />
                  <input
                    value={draft.description}
                    onChange={(e) =>
                      setDraft({ ...draft, description: e.target.value })
                    }
                    placeholder="Description (optional)"
                  />
                  <div className="row-gap">
                    <button
                      className="button-like qc-pass"
                      disabled={saveEdit.isPending}
                      onClick={() => saveEdit.mutate(c.id)}
                    >
                      Save
                    </button>
                    <button
                      className="button-like"
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>
                      <span style={{ fontFamily: "monospace" }}>{c.code}</span>{" "}
                      {c.label}
                      {!c.active && (
                        <span
                          className="muted"
                          style={{ fontSize: 11, textTransform: "uppercase", marginLeft: 6 }}
                        >
                          archived
                        </span>
                      )}
                    </div>
                    {c.description && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {c.description}
                      </div>
                    )}
                  </div>
                  <div className="row-gap" style={{ marginLeft: "auto" }}>
                    {(canMoveUp || canMoveDown) && (
                      <>
                        <button
                          className="button-like"
                          disabled={!canMoveUp || busy}
                          aria-label={`Move ${c.code} up`}
                          onClick={() => move.mutate({ id: c.id, direction: "up" })}
                        >
                          ↑
                        </button>
                        <button
                          className="button-like"
                          disabled={!canMoveDown || busy}
                          aria-label={`Move ${c.code} down`}
                          onClick={() => move.mutate({ id: c.id, direction: "down" })}
                        >
                          ↓
                        </button>
                      </>
                    )}
                    <button
                      className="button-like"
                      onClick={() => {
                        setEditing(c.id);
                        setDraft({
                          code: c.code,
                          label: c.label,
                          description: c.description ?? "",
                        });
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className="button-like"
                      disabled={toggleActive.isPending}
                      onClick={() => toggleActive.mutate(c)}
                    >
                      {c.active ? "Archive" : "Reactivate"}
                    </button>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>

      {tab === "all" && !search.trim() && all.length > 1 && (
        <p className="muted" style={{ fontSize: 12 }}>
          Use ↑ / ↓ on the All tab to set the order codes appear in the picker.
        </p>
      )}
    </div>
  );
}
