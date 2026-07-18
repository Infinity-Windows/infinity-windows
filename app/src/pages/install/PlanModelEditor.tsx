import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  addOpening,
  deleteOpening,
  deletePlanOutline,
  downloadPlanset,
  savePlanOutline,
  updateOpening,
} from "../../lib/install/api";
import {
  EMPTY_FEATURES,
  nearestPointOnOutline,
  newFeatureId,
  outlinePathWithOpenings,
  parseOutlineFeatures,
  rectFromDrag,
  snapPointToAxis,
  snapVertexToNeighbors,
  type OutlineFeatures,
} from "../../lib/install/cad";
import { formatApiError } from "../../lib/install/errors";
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
import { OutlineFeatureLayer } from "./OutlineFeatureLayer";

type EditTool =
  | "outline"
  | "rect"
  | "divider"
  | "wall-window"
  | "wall-door"
  | "window"
  | "door"
  | "select";

/** How close (viewBox units) a click must be to the outline to attach. */
const EDGE_ATTACH_TOLERANCE = 40;
const WALL_WINDOW_WIDTH = 50;
const WALL_DOOR_WIDTH = 60;

const MIN_ZOOM = 1;
const MAX_ZOOM = 10;

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
  const editorRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const outlineScopeRef = useRef(`${planset.id}:${page}`);
  const squareLockRef = useRef(false);
  const zoomRef = useRef(1);
  const pendingScrollRef = useRef<{ left: number; top: number } | null>(null);

  const [tool, setTool] = useState<EditTool>("outline");
  const [savedOutlines, setSavedOutlines] =
    useState<PlanOutline[]>(manualOutlines);
  const [activeOutlineId, setActiveOutlineId] = useState<string | null>(
    manualOutlines[0]?.id ?? null,
  );
  const [points, setPoints] = useState<OutlinePoint[]>(
    () => manualOutlines[0]?.points ?? [],
  );
  const [features, setFeatures] = useState<OutlineFeatures>(() =>
    parseOutlineFeatures(manualOutlines[0]?.features),
  );
  const [closed, setClosed] = useState(
    () =>
      !!manualOutlines[0] &&
      isValidOutlinePolygon(manualOutlines[0].points),
  );
  const [history, setHistory] = useState<OutlinePoint[][]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedFeature, setSelectedFeature] = useState<{
    id: string;
    type: "divider" | "wall";
  } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [traceImage, setTraceImage] = useState<PageImage | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vertexDrag, setVertexDrag] = useState<number | null>(null);
  const [squareLock, setSquareLock] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [rectDrag, setRectDrag] = useState<{
    anchor: OutlinePoint;
    cursor: OutlinePoint;
    square: boolean;
  } | null>(null);
  const [dividerStart, setDividerStart] = useState<OutlinePoint | null>(null);
  const [dividerCursor, setDividerCursor] = useState<OutlinePoint | null>(null);
  const [dotDrag, setDotDrag] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [pendingDots, setPendingDots] = useState<
    Record<string, { x: number; y: number }>
  >({});

  squareLockRef.current = squareLock;

  const activeOutline = savedOutlines.find((o) => o.id === activeOutlineId);
  const aspect = activeOutline?.page_aspect ?? pageAspect;
  const h = 1000 * aspect;

  const resetDrawingState = () => {
    setSelectedId(null);
    setSelectedFeature(null);
    setDividerStart(null);
    setDividerCursor(null);
    setRectDrag(null);
  };

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
    setFeatures(parseOutlineFeatures(first?.features));
    setClosed(!!first && isValidOutlinePolygon(first.points));
    setHistory([]);
    resetDrawingState();
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
        if (!cancelled) setError(formatApiError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [planset, page]);

  // --- zoom & fullscreen ---

  zoomRef.current = zoom;

  /** Zoom toward a screen point so what's under the cursor stays put. */
  const setZoomAt = (next: number, clientX?: number, clientY?: number) => {
    const z = clamp(next, MIN_ZOOM, MAX_ZOOM);
    const prev = zoomRef.current;
    const scroller = scrollerRef.current;
    if (!scroller || z === prev) {
      setZoom(z);
      return;
    }
    const rect = scroller.getBoundingClientRect();
    const offsetX = (clientX ?? rect.left + rect.width / 2) - rect.left;
    const offsetY = (clientY ?? rect.top + rect.height / 2) - rect.top;
    const scale = z / prev;
    pendingScrollRef.current = {
      left: (scroller.scrollLeft + offsetX) * scale - offsetX,
      top: (scroller.scrollTop + offsetY) * scale - offsetY,
    };
    setZoom(z);
  };

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const pending = pendingScrollRef.current;
    if (!scroller || !pending) return;
    pendingScrollRef.current = null;
    scroller.scrollLeft = pending.left;
    scroller.scrollTop = pending.top;
  }, [zoom]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    // Ctrl/Cmd + wheel (and Mac trackpad pinch) zooms toward the cursor.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoomAt(zoomRef.current * Math.exp(-e.deltaY * 0.002), e.clientX, e.clientY);
    };

    // Two-finger touch: pinch to zoom, move together to pan.
    let lastDist = 0;
    let lastMid: { x: number; y: number } | null = null;
    const gesture = (t: TouchList) => ({
      dist: Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY),
      mid: {
        x: (t[0].clientX + t[1].clientX) / 2,
        y: (t[0].clientY + t[1].clientY) / 2,
      },
    });
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      const g = gesture(e.touches);
      lastDist = g.dist;
      lastMid = g.mid;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !lastMid || lastDist === 0) return;
      e.preventDefault();
      const g = gesture(e.touches);
      scroller.scrollLeft -= g.mid.x - lastMid.x;
      scroller.scrollTop -= g.mid.y - lastMid.y;
      setZoomAt(zoomRef.current * (g.dist / lastDist), g.mid.x, g.mid.y);
      lastDist = g.dist;
      lastMid = g.mid;
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        lastDist = 0;
        lastMid = null;
      }
    };

    scroller.addEventListener("wheel", onWheel, { passive: false });
    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("touchmove", onTouchMove, { passive: false });
    scroller.addEventListener("touchend", onTouchEnd);
    scroller.addEventListener("touchcancel", onTouchEnd);
    return () => {
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("touchstart", onTouchStart);
      scroller.removeEventListener("touchmove", onTouchMove);
      scroller.removeEventListener("touchend", onTouchEnd);
      scroller.removeEventListener("touchcancel", onTouchEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleFullscreen = () => {
    if (!fullscreen) {
      setFullscreen(true);
      // Real browser fullscreen when available; the fixed overlay is the fallback.
      editorRef.current?.requestFullscreen?.().catch(() => {});
    } else {
      setFullscreen(false);
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    }
  };

  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement) setFullscreen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // Covers the CSS-overlay fallback where Esc has no native handler.
      if (e.key === "Escape" && !document.fullscreenElement) {
        setFullscreen(false);
      }
    };
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const previewPoints = rectDrag
    ? rectFromDrag(rectDrag.anchor, rectDrag.cursor, rectDrag.square, aspect)
    : null;

  const pathD = useMemo(
    () => outlinePathD(points, aspect),
    [points, aspect],
  );
  const strokePathD = useMemo(() => {
    if (!closed) return null;
    if (features.wallOpenings.length === 0) return pathD;
    return outlinePathWithOpenings(points, aspect, features.wallOpenings);
  }, [closed, points, aspect, features.wallOpenings, pathD]);
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
    mutationFn: (override?: {
      points?: OutlinePoint[];
      features?: OutlineFeatures;
    }) => {
      const pts = override?.points ?? points;
      if (!isValidOutlinePolygon(pts)) {
        throw new Error("Draw at least 3 points before saving.");
      }
      return savePlanOutline({
        outlineId: activeOutlineId ?? undefined,
        projectId,
        plansetId: planset.id,
        pageNumber: page,
        points: pts,
        pageAspect: aspect,
        features: override?.features ?? features,
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
      setStatus("Outline saved for this floor.");
      queryClient.setQueryData<PlanOutline[]>(
        ["planOutlines", projectId, planset.id],
        (rows = []) => updateRows(rows),
      );
      queryClient.invalidateQueries({
        queryKey: ["planOutlines", projectId, planset.id],
      });
    },
    onError: (e) => setError(formatApiError(e)),
  });

  /** Update features; auto-save when the outline already exists. */
  const applyFeatures = (next: OutlineFeatures, message: string) => {
    setFeatures(next);
    setStatus(message);
    if (activeOutlineId && isValidOutlinePolygon(points)) {
      saveOutline.mutate({ features: next });
    }
  };

  const resetOutline = useMutation({
    mutationFn: () => deletePlanOutline(planset.id, page),
    onSuccess: () => {
      const fallback = extractedOutline?.points ?? [];
      setSavedOutlines([]);
      setActiveOutlineId(null);
      setPoints(fallback);
      setFeatures(EMPTY_FEATURES);
      setClosed(isValidOutlinePolygon(fallback));
      resetDrawingState();
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
    onError: (e) => setError(formatApiError(e)),
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
      setFeatures(parseOutlineFeatures(next?.features));
      setClosed(!!next && isValidOutlinePolygon(next.points));
      setHistory([]);
      resetDrawingState();
      setStatus("Outline removed.");
      queryClient.setQueryData<PlanOutline[]>(
        ["planOutlines", projectId, planset.id],
        (rows = []) => rows.filter((outline) => outline.id !== removedId),
      );
      queryClient.invalidateQueries({
        queryKey: ["planOutlines", projectId, planset.id],
      });
    },
    onError: (e) => setError(formatApiError(e)),
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
    onError: (e) => setError(formatApiError(e)),
  });

  const renameDot = useMutation({
    mutationFn: (args: { id: string; code: string }) =>
      updateOpening(args.id, { opening_code: args.code.toUpperCase() }),
    onSuccess: () => {
      setStatus("Opening renamed.");
      queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
    },
    onError: (e) => setError(formatApiError(e)),
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
    onError: (e) => setError(formatApiError(e)),
  });

  const removeDot = useMutation({
    mutationFn: (id: string) => deleteOpening(id),
    onSuccess: () => {
      setSelectedId(null);
      setStatus("Opening removed.");
      queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
    },
    onError: (e) => setError(formatApiError(e)),
  });

  // --- tool interactions ---

  const beginRectDrag = (start: OutlinePoint, e: React.PointerEvent) => {
    e.preventDefault();
    const drag = {
      anchor: start,
      cursor: start,
      square: e.shiftKey || squareLockRef.current,
    };
    setRectDrag(drag);
    const onMove = (ev: PointerEvent) => {
      const next = sheetCoords(ev.clientX, ev.clientY);
      if (!next) return;
      drag.cursor = next;
      drag.square = ev.shiftKey || squareLockRef.current;
      setRectDrag({ ...drag });
    };
    const onUp = (ev: PointerEvent) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      setRectDrag(null);
      const end = sheetCoords(ev.clientX, ev.clientY) ?? drag.cursor;
      const dx = Math.abs(end.x - drag.anchor.x) * 1000;
      const dy = Math.abs(end.y - drag.anchor.y) * 1000 * aspect;
      if (dx < 15 && dy < 15) {
        setStatus("Drag out the rectangle from its first corner.");
        return;
      }
      const rect = rectFromDrag(
        drag.anchor,
        end,
        ev.shiftKey || squareLockRef.current,
        aspect,
      );
      pushHistory(rect);
      setClosed(true);
      setStatus("Rectangle placed — adjust corners or hit Save outline.");
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  const handleDividerClick = (pt: OutlinePoint) => {
    if (!closed || points.length < 3) {
      setStatus("Close an outline first, then draw dividers across it.");
      return;
    }
    // Tighter attach distance when zoomed in for precise placement.
    const tolerance = EDGE_ATTACH_TOLERANCE / zoomRef.current;
    const hit = nearestPointOnOutline(points, pt, aspect);
    if (!dividerStart) {
      if (!hit || hit.dist > tolerance) {
        setStatus("Start a divider on the outline edge.");
        return;
      }
      setDividerStart(hit.point);
      setDividerCursor(hit.point);
      setStatus("Now click the opposite edge to finish the divider.");
      return;
    }
    let end = hit && hit.dist <= tolerance ? hit.point : pt;
    end = snapPointToAxis(dividerStart, end, aspect);
    // Re-attach to the outline after axis snapping when close enough.
    const endHit = nearestPointOnOutline(points, end, aspect);
    if (endHit && endHit.dist <= tolerance) end = endHit.point;
    const next: OutlineFeatures = {
      ...features,
      dividers: [
        ...features.dividers,
        { id: newFeatureId(), a: dividerStart, b: end },
      ],
    };
    setDividerStart(null);
    setDividerCursor(null);
    applyFeatures(next, "Divider added.");
  };

  const handleWallOpeningClick = (pt: OutlinePoint, kind: "window" | "door") => {
    if (!closed || points.length < 3) {
      setStatus("Close an outline first, then place wall openings on it.");
      return;
    }
    const hit = nearestPointOnOutline(points, pt, aspect);
    if (!hit || hit.dist > EDGE_ATTACH_TOLERANCE / zoomRef.current) {
      setStatus("Tap directly on an outline wall to place the opening.");
      return;
    }
    const next: OutlineFeatures = {
      ...features,
      wallOpenings: [
        ...features.wallOpenings,
        {
          id: newFeatureId(),
          edge: hit.edge,
          t: hit.t,
          width: kind === "door" ? WALL_DOOR_WIDTH : WALL_WINDOW_WIDTH,
          kind,
        },
      ],
    };
    applyFeatures(next, kind === "door" ? "Door opening added." : "Window opening added.");
  };

  const onSheetPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const pt = sheetCoords(e.clientX, e.clientY);
    if (!pt) return;

    if (tool === "rect") {
      beginRectDrag(pt, e);
      return;
    }

    if (tool === "divider") {
      e.preventDefault();
      handleDividerClick(pt);
      return;
    }

    if (tool === "wall-window" || tool === "wall-door") {
      e.preventDefault();
      handleWallOpeningClick(pt, tool === "wall-window" ? "window" : "door");
      return;
    }

    if (tool === "window" || tool === "door") {
      e.preventDefault();
      createDot.mutate({ kind: tool, x: pt.x, y: pt.y });
      return;
    }

    if (tool === "select") {
      setSelectedFeature(null);
      return;
    }

    if (tool === "outline" && !closed) {
      e.preventDefault();
      // Close when clicking near the first vertex.
      if (points.length >= 3) {
        const first = points[0];
        if (Math.hypot(pt.x - first.x, pt.y - first.y) < 0.025 / zoomRef.current) {
          setClosed(true);
          setStatus("Outline closed — hit Save.");
          return;
        }
      }
      const snapped =
        points.length > 0
          ? snapPointToAxis(points[points.length - 1], pt, aspect)
          : pt;
      pushHistory([...points, snapped]);
      setStatus(`${points.length + 1} points — click first point to close.`);
    }
  };

  const onSheetPointerMove = (e: React.PointerEvent) => {
    if (tool !== "divider" || !dividerStart) return;
    const pt = sheetCoords(e.clientX, e.clientY);
    if (!pt) return;
    setDividerCursor(snapPointToAxis(dividerStart, pt, aspect));
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
          prev.map((p, i) =>
            i === index
              ? snapVertexToNeighbors(prev, index, next, aspect)
              : p,
          ),
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
    setActiveOutlineId(outline.id);
    setPoints(outline.points);
    setFeatures(parseOutlineFeatures(outline.features));
    setClosed(isValidOutlinePolygon(outline.points));
    setHistory([]);
    resetDrawingState();
    setStatus(null);
    setError(null);
  };

  const startOutline = (nextTool: "outline" | "rect" = "outline") => {
    setTool(nextTool);
    setActiveOutlineId(null);
    setPoints([]);
    setFeatures(EMPTY_FEATURES);
    setClosed(false);
    setHistory([]);
    resetDrawingState();
    setStatus(
      nextTool === "rect"
        ? "New outline — drag out a rectangle."
        : "New outline — click its first corner.",
    );
    setError(null);
  };

  const deleteSelectedFeature = () => {
    if (!selectedFeature) return;
    const next: OutlineFeatures =
      selectedFeature.type === "divider"
        ? {
            ...features,
            dividers: features.dividers.filter((d) => d.id !== selectedFeature.id),
          }
        : {
            ...features,
            wallOpenings: features.wallOpenings.filter(
              (w) => w.id !== selectedFeature.id,
            ),
          };
    setSelectedFeature(null);
    applyFeatures(
      next,
      selectedFeature.type === "divider" ? "Divider removed." : "Wall opening removed.",
    );
  };

  const setDrawTool = (next: EditTool) => {
    setTool(next);
    resetDrawingState();
  };

  const hint = (() => {
    switch (tool) {
      case "outline":
        return closed
          ? "Drag orange handles to reshape (they auto-square near 90°), then Save outline."
          : "Click the faded plan to place outline corners — lines auto-lock level/plumb within 2°. Click the first point to close.";
      case "rect":
        return "Press and drag from one corner to the opposite corner. Hold Shift or toggle Square for a perfect square.";
      case "divider":
        return dividerStart
          ? "Click the opposite wall to finish the section divider (auto-locks level/plumb)."
          : "Click an outline wall to start a straight divider that cuts the building into sections.";
      case "wall-window":
        return "Tap on an outline wall to cut in a window (double-line CAD symbol).";
      case "wall-door":
        return "Tap on an outline wall to cut in a door with a swing arc.";
      case "window":
      case "door":
        return `Tap the plan to place a numbered ${tool} mark. Existing marks are hidden so they don’t block clicks.`;
      default:
        return "Marks are shown — drag to move, tap to rename/delete. Tap a divider or wall symbol to select it.";
    }
  })();

  // Keep handles/lines the same size on screen no matter the zoom.
  const zs = 1 / zoom;

  return (
    <div
      ref={editorRef}
      className={`plan-model-editor${fullscreen ? " plan-model-editor--fullscreen" : ""}`}
    >
      <div className="plan-model-editor__toolbar" role="toolbar" aria-label="Model tools">
        <button
          type="button"
          className={tool === "outline" ? "chip active" : "chip"}
          onClick={() => setDrawTool("outline")}
        >
          Trace / edit
        </button>
        <button
          type="button"
          className={tool === "rect" ? "chip active" : "chip"}
          onClick={() => {
            if (closed && points.length >= 3 && activeOutlineId) {
              // A rectangle replaces the shape you're editing; start fresh.
              startOutline("rect");
            } else {
              setDrawTool("rect");
            }
          }}
        >
          ▭ Rectangle
        </button>
        {tool === "rect" && (
          <button
            type="button"
            className={squareLock ? "chip active" : "chip"}
            onClick={() => setSquareLock((v) => !v)}
            title="Lock 1:1 square (or hold Shift while dragging)"
          >
            Square
          </button>
        )}
        <button
          type="button"
          className={tool === "divider" ? "chip active" : "chip"}
          onClick={() => setDrawTool("divider")}
        >
          ┃ Divider
        </button>
        <button
          type="button"
          className={tool === "wall-window" ? "chip active" : "chip"}
          onClick={() => setDrawTool("wall-window")}
        >
          ⊟ Wall window
        </button>
        <button
          type="button"
          className={tool === "wall-door" ? "chip active" : "chip"}
          onClick={() => setDrawTool("wall-door")}
        >
          ◠ Wall door
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
        <button type="button" className="chip" onClick={() => startOutline()}>
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
          onClick={() => setDrawTool("window")}
        >
          + Window
        </button>
        <button
          type="button"
          className={tool === "door" ? "chip active" : "chip"}
          onClick={() => setDrawTool("door")}
        >
          + Door
        </button>
        <button
          type="button"
          className={tool === "select" ? "chip active" : "chip"}
          onClick={() => setDrawTool("select")}
        >
          Select / move
        </button>
        <span className="plan-model-editor__spacer" />
        <button
          type="button"
          className={fullscreen ? "chip active" : "chip"}
          onClick={toggleFullscreen}
        >
          {fullscreen ? "Exit full screen" : "⛶ Full screen"}
        </button>
        <span className="plan-model-editor__zoom" role="group" aria-label="Zoom">
          <button
            type="button"
            className="button-like"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => setZoomAt(zoom / 1.5)}
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            type="button"
            className="button-like plan-model-editor__zoom-level"
            onClick={() => setZoomAt(1)}
            title="Reset zoom"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            className="button-like"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => setZoomAt(zoom * 1.5)}
            aria-label="Zoom in"
          >
            +
          </button>
        </span>
        <button
          type="button"
          className="button-like"
          disabled={history.length === 0}
          onClick={() => {
            const prev = history[history.length - 1];
            setHistory((hist) => hist.slice(0, -1));
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
            setFeatures(EMPTY_FEATURES);
            setClosed(false);
            resetDrawingState();
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
            saveOutline.mutate(undefined);
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

      <p className="muted plan-model-editor__hint">{hint}</p>

      {(status || error) && (
        <p className={error ? "error" : "muted"}>{error ?? status}</p>
      )}

      <div ref={scrollerRef} className="plan-model-editor__scroll">
      <div
        ref={sheetRef}
        className={`plan-model-editor__sheet${
          (tool === "outline" && !closed) || tool === "rect"
            ? " plan-model-editor__sheet--drawing"
            : ""
        }${
          tool === "window" ||
          tool === "door" ||
          tool === "divider" ||
          tool === "wall-window" ||
          tool === "wall-door"
            ? " plan-model-editor__sheet--place"
            : ""
        }`}
        style={{ aspectRatio: `1 / ${aspect}`, width: `${zoom * 100}%` }}
        onPointerDown={onSheetPointerDown}
        onPointerMove={onSheetPointerMove}
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
              const feats = parseOutlineFeatures(outline.features);
              const stroke =
                feats.wallOpenings.length > 0
                  ? outlinePathWithOpenings(outline.points, aspect, feats.wallOpenings)
                  : outlinePathD(outline.points, aspect);
              const fill = outlinePathD(outline.points, aspect);
              return fill ? (
                <g key={outline.id}>
                  <path d={fill} fill="rgba(255, 106, 26, 0.06)" stroke="none" />
                  {stroke && (
                    <path
                      d={stroke}
                      className="plan-model-editor__poly plan-model-editor__poly--inactive"
                      fill="none"
                      stroke="rgba(255, 106, 26, 0.5)"
                      strokeWidth={3 * zs}
                      strokeLinejoin="round"
                    />
                  )}
                  <OutlineFeatureLayer
                    points={outline.points}
                    aspect={aspect}
                    features={feats}
                    color="rgba(255, 106, 26, 0.5)"
                    strokeScale={zs}
                  />
                </g>
              ) : null;
            })}

          {closed && pathD ? (
            <g>
              <path d={pathD} fill="rgba(255, 106, 26, 0.12)" stroke="none" />
              {strokePathD && (
                <path
                  d={strokePathD}
                  className="plan-model-editor__poly"
                  fill="none"
                  stroke="#ff6a1a"
                  strokeWidth={4 * zs}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              )}
            </g>
          ) : (
            openPathD && (
              <path
                d={openPathD}
                fill="none"
                stroke="#ff6a1a"
                strokeWidth={4 * zs}
                strokeLinejoin="round"
                strokeDasharray={`${12 * zs} ${8 * zs}`}
              />
            )
          )}

          {closed && (
            <OutlineFeatureLayer
              points={points}
              aspect={aspect}
              features={features}
              color="#ff6a1a"
              strokeScale={zs}
              selectedFeatureId={selectedFeature?.id ?? null}
              onSelectFeature={
                tool === "select"
                  ? (id, type) => setSelectedFeature({ id, type })
                  : undefined
              }
            />
          )}

          {previewPoints && (
            <path
              d={outlinePathD(previewPoints, aspect) ?? undefined}
              fill="rgba(255, 106, 26, 0.08)"
              stroke="#ff6a1a"
              strokeWidth={3 * zs}
              strokeDasharray={`${10 * zs} ${7 * zs}`}
            />
          )}

          {dividerStart && (
            <>
              <circle
                cx={dividerStart.x * 1000}
                cy={dividerStart.y * h}
                r={9 * zs}
                fill="#ffd166"
                stroke="#141210"
                strokeWidth={2 * zs}
              />
              {dividerCursor && (
                <line
                  x1={dividerStart.x * 1000}
                  y1={dividerStart.y * h}
                  x2={dividerCursor.x * 1000}
                  y2={dividerCursor.y * h}
                  stroke="#ffd166"
                  strokeWidth={2.5 * zs}
                  strokeDasharray={`${10 * zs} ${7 * zs}`}
                />
              )}
            </>
          )}

          {(tool === "outline" || tool === "rect") &&
            points.map((p, i) => (
              <circle
                key={`${i}-${p.x}-${p.y}`}
                cx={p.x * 1000}
                cy={p.y * h}
                r={(vertexDrag === i ? 14 : 11) * zs}
                className="plan-model-editor__vertex"
                style={{ strokeWidth: 3 * zs }}
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
      </div>

      {selectedFeature && (
        <div className="plan-model-editor__dot-panel">
          <span className="muted">
            {selectedFeature.type === "divider"
              ? "Section divider selected"
              : "Wall opening selected"}
          </span>
          <button
            type="button"
            className="button-like"
            onClick={deleteSelectedFeature}
          >
            Delete
          </button>
          <button
            type="button"
            className="link"
            onClick={() => setSelectedFeature(null)}
          >
            Deselect
          </button>
        </div>
      )}

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
