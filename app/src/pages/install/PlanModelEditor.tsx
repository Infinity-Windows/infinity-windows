import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  addOpening,
  deleteOpening,
  deletePlanOutline,
  downloadPlanset,
  savePlanOutline,
  updateOpening,
} from "../../lib/install/api";
import {
  clampOutlinePoint,
  isValidOutlinePolygon,
  outlinePathD,
  type BuildingOutline,
  type OutlinePoint,
} from "../../lib/install/outline";
import {
  OPENING_KIND_COLORS,
  OPENING_STATUS_COLORS,
  openingMarkCode,
  type PlanOutline,
  type Planset,
  type ProjectOpening,
} from "../../lib/install/types";

type EditTool = "outline" | "window" | "door" | "select";

interface PageImage {
  dataUrl: string;
  width: number;
  height: number;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function nextOpeningCode(
  openings: ProjectOpening[],
  kind: "window" | "door",
): string {
  const prefix = kind === "door" ? "D" : "W";
  let max = 0;
  for (const o of openings) {
    const m = o.opening_code
      .toUpperCase()
      .match(new RegExp(`^${prefix}(\\d+)(?:-\\d+)?$`));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1}`;
}

export function PlanModelEditor(props: {
  projectId: string;
  planset: Planset;
  page: number;
  openings: ProjectOpening[];
  manualOutlines: PlanOutline[];
  extractedOutline: BuildingOutline | null;
  pageAspect: number;
  onClose: () => void;
}) {
  const {
    projectId,
    planset,
    page,
    openings,
    manualOutlines,
    extractedOutline,
    pageAspect,
    onClose,
  } = props;
  const queryClient = useQueryClient();
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const outlineScopeRef = useRef(`${planset.id}:${page}`);

  const [tool, setTool] = useState<EditTool>("outline");
  const [savedOutlines, setSavedOutlines] =
    useState<PlanOutline[]>(manualOutlines);
  const [activeOutlineId, setActiveOutlineId] = useState<string | null>(
    manualOutlines[0]?.id ?? null,
  );
  const [points, setPoints] = useState<OutlinePoint[]>(
    () => manualOutlines[0]?.points ?? [],
  );
  const [closed, setClosed] = useState(
    () =>
      !!manualOutlines[0] &&
      isValidOutlinePolygon(manualOutlines[0].points),
  );
  const [history, setHistory] = useState<OutlinePoint[][]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [traceImage, setTraceImage] = useState<PageImage | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vertexDrag, setVertexDrag] = useState<number | null>(null);
  const [dotDrag, setDotDrag] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [pendingDots, setPendingDots] = useState<
    Record<string, { x: number; y: number }>
  >({});

  const activeOutline = savedOutlines.find((o) => o.id === activeOutlineId);
  const aspect = activeOutline?.page_aspect ?? pageAspect;
  const h = 1000 * aspect;

  useEffect(() => {
    const scope = `${planset.id}:${page}`;
    if (outlineScopeRef.current === scope) {
      // Keep server/cache changes in sync without replacing an in-progress
      // outline or jumping back to Outline 1 after a new outline is saved.
      setSavedOutlines(manualOutlines);
      return;
    }
    outlineScopeRef.current = scope;
    const first = manualOutlines[0];
    setSavedOutlines(manualOutlines);
    setActiveOutlineId(first?.id ?? null);
    setPoints(first?.points ?? []);
    setClosed(!!first && isValidOutlinePolygon(first.points));
    setHistory([]);
  }, [manualOutlines, page, planset.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { loadPdf, renderPageImage } = await import(
          "../../lib/install/pdf"
        );
        const doc = await loadPdf(await downloadPlanset(planset));
        const img = await renderPageImage(doc, page);
        if (!cancelled) setTraceImage(img);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [planset, page]);

  const pathD = useMemo(
    () => outlinePathD(closed ? points : points, aspect),
    [points, closed, aspect],
  );
  const openPathD = useMemo(() => {
    if (points.length === 0) return null;
    return points
      .map(
        (p, i) =>
          `${i === 0 ? "M" : "L"}${(p.x * 1000).toFixed(1)} ${(p.y * h).toFixed(1)}`,
      )
      .join(" ");
  }, [points, h]);

  const pageOpenings = openings.filter((o) => o.page_number === page);
  const selected = pageOpenings.find((o) => o.id === selectedId) ?? null;

  useEffect(() => {
    setRenameValue(selected?.opening_code ?? "");
  }, [selected?.id, selected?.opening_code]);

  const pushHistory = (next: OutlinePoint[]) => {
    setHistory((prev) => [...prev.slice(-30), points]);
    setPoints(next);
  };

  const sheetCoords = (clientX: number, clientY: number) => {
    const sheet = sheetRef.current;
    if (!sheet) return null;
    const rect = sheet.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    return clampOutlinePoint({
      x: clamp((clientX - rect.left) / rect.width, 0, 1),
      y: clamp((clientY - rect.top) / rect.height, 0, 1),
    });
  };

  const saveOutline = useMutation({
    mutationFn: () => {
      if (!isValidOutlinePolygon(points)) {
        throw new Error("Draw at least 3 points before saving.");
      }
      return savePlanOutline({
        outlineId: activeOutlineId ?? undefined,
        projectId,
        plansetId: planset.id,
        pageNumber: page,
        points,
        pageAspect: aspect,
      });
    },
    onSuccess: (row) => {
      const updateRows = (rows: PlanOutline[]) => {
        const exists = rows.some((outline) => outline.id === row.id);
        return exists
          ? rows.map((outline) => (outline.id === row.id ? row : outline))
          : [...rows, row];
      };
      setSavedOutlines(updateRows);
      setActiveOutlineId(row.id);
      setClosed(true);
      setStatus(
        `Outline ${updateRows(savedOutlines).findIndex((o) => o.id === row.id) + 1} saved for this floor.`,
      );
      queryClient.setQueryData<PlanOutline[]>(
        ["planOutlines", projectId, planset.id],
        (rows = []) => updateRows(rows),
      );
      queryClient.invalidateQueries({
        queryKey: ["planOutlines", projectId, planset.id],
      });
    },
    onError: (e) => setError(String(e)),
  });

  const resetOutline = useMutation({
    mutationFn: () => deletePlanOutline(planset.id, page),
    onSuccess: () => {
      const fallback = extractedOutline?.points ?? [];
      setSavedOutlines([]);
      setActiveOutlineId(null);
      setPoints(fallback);
      setClosed(isValidOutlinePolygon(fallback));
      setStatus(
        fallback.length
          ? "Cleared manual outline — using CAD extract."
          : "Cleared manual outline.",
      );
      queryClient.setQueryData<PlanOutline[]>(
        ["planOutlines", projectId, planset.id],
        (rows = []) =>
          rows.filter(
            (outline) =>
              outline.planset_id !== planset.id ||
              outline.page_number !== page,
          ),
      );
      queryClient.invalidateQueries({
        queryKey: ["planOutlines", projectId, planset.id],
      });
    },
    onError: (e) => setError(String(e)),
  });

  const removeOutline = useMutation({
    mutationFn: (outlineId: string) =>
      deletePlanOutline(planset.id, page, outlineId),
    onSuccess: (_, removedId) => {
      const remaining = savedOutlines.filter((o) => o.id !== removedId);
      const next = remaining[0];
      setSavedOutlines(remaining);
      setActiveOutlineId(next?.id ?? null);
      setPoints(next?.points ?? []);
      setClosed(!!next && isValidOutlinePolygon(next.points));
      setHistory([]);
      setStatus("Outline removed.");
      queryClient.setQueryData<PlanOutline[]>(
        ["planOutlines", projectId, planset.id],
        (rows = []) => rows.filter((outline) => outline.id !== removedId),
      );
      queryClient.invalidateQueries({
        queryKey: ["planOutlines", projectId, planset.id],
      });
    },
    onError: (e) => setError(String(e)),
  });

  const createDot = useMutation({
    mutationFn: (args: {
      kind: "window" | "door";
      x: number;
      y: number;
    }) =>
      addOpening(projectId, {
        opening_code: nextOpeningCode(openings, args.kind),
        planset_id: planset.id,
        page_number: page,
        pin_x: Math.round(args.x * 1000) / 1000,
        pin_y: Math.round(args.y * 1000) / 1000,
        confirmed: true,
        label: args.kind === "door" ? "Door" : "Window",
      }),
    onSuccess: (row) => {
      setSelectedId(row.id);
      setTool("select");
      setStatus(`Added ${row.opening_code}.`);
      queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
    },
    onError: (e) => setError(String(e)),
  });

  const renameDot = useMutation({
    mutationFn: (args: { id: string; code: string }) =>
      updateOpening(args.id, { opening_code: args.code.toUpperCase() }),
    onSuccess: () => {
      setStatus("Opening renamed.");
      queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
    },
    onError: (e) => setError(String(e)),
  });

  const moveDot = useMutation({
    mutationFn: (args: { id: string; x: number; y: number }) =>
      updateOpening(args.id, {
        pin_x: Math.round(args.x * 1000) / 1000,
        pin_y: Math.round(args.y * 1000) / 1000,
        page_number: page,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
    },
    onError: (e) => setError(String(e)),
  });

  const removeDot = useMutation({
    mutationFn: (id: string) => deleteOpening(id),
    onSuccess: () => {
      setSelectedId(null);
      setStatus("Opening removed.");
      queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
    },
    onError: (e) => setError(String(e)),
  });

  const onSheetPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const pt = sheetCoords(e.clientX, e.clientY);
    if (!pt) return;

    if (tool === "window" || tool === "door") {
      e.preventDefault();
      createDot.mutate({ kind: tool, x: pt.x, y: pt.y });
      return;
    }

    if (tool === "outline" && !closed) {
      e.preventDefault();
      // Close when clicking near the first vertex.
      if (points.length >= 3) {
        const first = points[0];
        if (Math.hypot(pt.x - first.x, pt.y - first.y) < 0.025) {
          setClosed(true);
          setStatus("Outline closed — hit Save.");
          return;
        }
      }
      pushHistory([...points, pt]);
      setStatus(`${points.length + 1} points — click first point to close.`);
    }
  };

  const beginVertexDrag =
    (index: number) => (e: React.PointerEvent<SVGCircleElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setVertexDrag(index);
      const onMove = (ev: PointerEvent) => {
        const next = sheetCoords(ev.clientX, ev.clientY);
        if (!next) return;
        setPoints((prev) =>
          prev.map((p, i) => (i === index ? next : p)),
        );
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        setVertexDrag(null);
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    };

  const beginDotDrag =
    (o: ProjectOpening) => (e: React.PointerEvent<HTMLButtonElement>) => {
      if (tool !== "select") return;
      e.preventDefault();
      e.stopPropagation();
      setSelectedId(o.id);
      const start = {
        id: o.id,
        x: pendingDots[o.id]?.x ?? o.pin_x ?? 0.5,
        y: pendingDots[o.id]?.y ?? o.pin_y ?? 0.5,
        startClientX: e.clientX,
        startClientY: e.clientY,
        moved: false,
      };
      setDotDrag({ id: o.id, x: start.x, y: start.y });
      const onMove = (ev: PointerEvent) => {
        if (
          !start.moved &&
          Math.hypot(ev.clientX - start.startClientX, ev.clientY - start.startClientY) >
            5
        ) {
          start.moved = true;
        }
        if (!start.moved) return;
        const next = sheetCoords(ev.clientX, ev.clientY);
        if (!next) return;
        start.x = next.x;
        start.y = next.y;
        setDotDrag({ id: o.id, x: next.x, y: next.y });
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        setDotDrag(null);
        if (start.moved) {
          setPendingDots((prev) => ({
            ...prev,
            [o.id]: { x: start.x, y: start.y },
          }));
          moveDot.mutate({ id: o.id, x: start.x, y: start.y });
        }
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    };

  const dotPos = (o: ProjectOpening) => {
    if (dotDrag?.id === o.id) return { x: dotDrag.x, y: dotDrag.y };
    if (pendingDots[o.id]) return pendingDots[o.id];
    return { x: o.pin_x ?? 0.5, y: o.pin_y ?? 0.5 };
  };

  const selectOutline = (outline: PlanOutline) => {
    setTool("outline");
    setSelectedId(null);
    setActiveOutlineId(outline.id);
    setPoints(outline.points);
    setClosed(isValidOutlinePolygon(outline.points));
    setHistory([]);
    setStatus(null);
    setError(null);
  };

  const startOutline = () => {
    setTool("outline");
    setSelectedId(null);
    setActiveOutlineId(null);
    setPoints([]);
    setClosed(false);
    setHistory([]);
    setStatus("New outline — click its first corner.");
    setError(null);
  };

  return (
    <div className="plan-model-editor">
      <div className="plan-model-editor__toolbar" role="toolbar" aria-label="Model tools">
        <button
          type="button"
          className={tool === "outline" ? "chip active" : "chip"}
          onClick={() => {
            setTool("outline");
            setSelectedId(null);
          }}
        >
          Trace / edit
        </button>
        {savedOutlines.map((outline, index) => (
          <button
            key={outline.id}
            type="button"
            className={
              activeOutlineId === outline.id && tool === "outline"
                ? "chip active"
                : "chip"
            }
            onClick={() => selectOutline(outline)}
          >
            Outline {index + 1}
          </button>
        ))}
        <button type="button" className="chip" onClick={startOutline}>
          + Add outline
        </button>
        {activeOutlineId && (
          <button
            type="button"
            className="button-like"
            disabled={removeOutline.isPending}
            onClick={() => {
              if (window.confirm("Remove this outline?")) {
                removeOutline.mutate(activeOutlineId);
              }
            }}
          >
            Remove outline
          </button>
        )}
        <button
          type="button"
          className={tool === "window" ? "chip active" : "chip"}
          onClick={() => {
            setTool("window");
            setSelectedId(null);
          }}
        >
          + Window
        </button>
        <button
          type="button"
          className={tool === "door" ? "chip active" : "chip"}
          onClick={() => {
            setTool("door");
            setSelectedId(null);
          }}
        >
          + Door
        </button>
        <button
          type="button"
          className={tool === "select" ? "chip active" : "chip"}
          onClick={() => setTool("select")}
        >
          Select / move
        </button>
        <span className="plan-model-editor__spacer" />
        <button
          type="button"
          className="button-like"
          disabled={history.length === 0}
          onClick={() => {
            const prev = history[history.length - 1];
            setHistory((h) => h.slice(0, -1));
            setPoints(prev);
            setClosed(false);
          }}
        >
          Undo
        </button>
        <button
          type="button"
          className="button-like"
          disabled={points.length === 0}
          onClick={() => {
            pushHistory([]);
            setClosed(false);
          }}
        >
          Clear
        </button>
        <button
          type="button"
          className="button-like"
          disabled={!isValidOutlinePolygon(points) || saveOutline.isPending}
          onClick={() => {
            setClosed(true);
            saveOutline.mutate();
          }}
        >
          {saveOutline.isPending ? "Saving…" : "Save outline"}
        </button>
        <button
          type="button"
          className="button-like"
          disabled={resetOutline.isPending}
          onClick={() => resetOutline.mutate()}
        >
          Reset to CAD
        </button>
        <button type="button" className="button-like" onClick={onClose}>
          Done
        </button>
      </div>

      <p className="muted plan-model-editor__hint">
        {tool === "outline"
          ? closed
            ? "Drag orange handles to reshape, then Save outline. Marks stay hidden until Select / move."
            : "Click the faded plan to place outline corners (existing marks are hidden). Click the first point to close."
          : tool === "window" || tool === "door"
            ? `Tap the plan to place a ${tool} mark. Existing marks are hidden so they don’t block clicks.`
            : "Existing marks are shown. Drag to move; select one to rename or delete."}
      </p>

      {(status || error) && (
        <p className={error ? "error" : "muted"}>{error ?? status}</p>
      )}

      <div
        ref={sheetRef}
        className={`plan-model-editor__sheet${
          tool === "outline" && !closed ? " plan-model-editor__sheet--drawing" : ""
        }${tool === "window" || tool === "door" ? " plan-model-editor__sheet--place" : ""}`}
        style={{ aspectRatio: `1 / ${aspect}` }}
        onPointerDown={onSheetPointerDown}
      >
        {traceImage ? (
          <img
            className="plan-model-editor__trace"
            src={traceImage.dataUrl}
            alt=""
            draggable={false}
          />
        ) : (
          <div className="plan-model-editor__trace-placeholder muted">
            Loading planset page…
          </div>
        )}

        <svg
          className="plan-model-editor__svg"
          viewBox={`0 0 1000 ${Math.round(h)}`}
          preserveAspectRatio="none"
        >
          {savedOutlines
            .filter((outline) => outline.id !== activeOutlineId)
            .map((outline) => {
              const d = outlinePathD(outline.points, aspect);
              return d ? (
                <path
                  key={outline.id}
                  d={d}
                  className="plan-model-editor__poly plan-model-editor__poly--inactive"
                  fill="rgba(255, 106, 26, 0.06)"
                  stroke="rgba(255, 106, 26, 0.5)"
                  strokeWidth={3}
                  strokeLinejoin="round"
                />
              ) : null;
            })}
          {closed && pathD ? (
            <path
              d={pathD}
              className="plan-model-editor__poly"
              fill="rgba(255, 106, 26, 0.12)"
              stroke="#ff6a1a"
              strokeWidth={4}
              strokeLinejoin="round"
            />
          ) : (
            openPathD && (
              <path
                d={openPathD}
                fill="none"
                stroke="#ff6a1a"
                strokeWidth={4}
                strokeLinejoin="round"
                strokeDasharray="12 8"
              />
            )
          )}
          {points.map((p, i) => (
            <circle
              key={`${i}-${p.x}-${p.y}`}
              cx={p.x * 1000}
              cy={p.y * h}
              r={vertexDrag === i ? 14 : 11}
              className="plan-model-editor__vertex"
              onPointerDown={beginVertexDrag(i)}
            />
          ))}
        </svg>

        {/* Hide marks while tracing/placing so they don’t steal corner clicks. */}
        {tool === "select" &&
          pageOpenings
            .filter((o) => o.pin_x != null && o.pin_y != null)
            .map((o) => {
              const kind =
                (o.window_types?.category ?? "").toLowerCase().includes("door") ||
                /^D\d/i.test(o.opening_code)
                  ? "door"
                  : "window";
              const pos = dotPos(o);
              return (
                <button
                  key={o.id}
                  type="button"
                  className={`plan-dot${
                    selectedId === o.id ? " plan-dot--selected" : ""
                  }${dotDrag?.id === o.id ? " plan-dot--dragging" : ""}`}
                  style={{
                    left: `${pos.x * 100}%`,
                    top: `${pos.y * 100}%`,
                    background: OPENING_KIND_COLORS[kind],
                    borderColor: OPENING_STATUS_COLORS[o.status],
                  }}
                  title={o.opening_code}
                  onPointerDown={beginDotDrag(o)}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setSelectedId(o.id);
                  }}
                >
                  {openingMarkCode(o.opening_code)}
                </button>
              );
            })}
      </div>

      {selected && (
        <div className="plan-model-editor__dot-panel">
          <label>
            Mark
            <input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value.toUpperCase())}
              maxLength={16}
            />
          </label>
          <button
            type="button"
            className="button-like"
            disabled={
              !renameValue.trim() ||
              renameValue.trim().toUpperCase() === selected.opening_code ||
              renameDot.isPending
            }
            onClick={() =>
              renameDot.mutate({
                id: selected.id,
                code: renameValue.trim(),
              })
            }
          >
            Rename
          </button>
          <button
            type="button"
            className="button-like"
            disabled={selected.status === "installed" || removeDot.isPending}
            onClick={() => {
              if (
                window.confirm(
                  `Remove opening ${selected.opening_code} from this job?`,
                )
              ) {
                removeDot.mutate(selected.id);
              }
            }}
          >
            Delete
          </button>
          <button
            type="button"
            className="link"
            onClick={() => setSelectedId(null)}
          >
            Deselect
          </button>
        </div>
      )}
    </div>
  );
}
