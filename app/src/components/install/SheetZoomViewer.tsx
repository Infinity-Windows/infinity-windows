// Free pan-and-zoom for a spec sheet: pinch on a phone, wheel on a desk,
// drag to move, double-tap to dive on a detail. The old viewer was a fixed
// 250% toggle inside a scrollbox and it fought every instinct — this one
// follows the finger.
//
// Deliberately dependency-free pointer math. The image is laid out at the
// container's width (scale 1 = the whole sheet fits) and transformed with
// translate+scale from the top-left corner; every zoom is anchored at the
// gesture point (cursor, pinch midpoint, or tap), which is what makes it feel
// like zooming INTO the detail rather than into the page's corner. State
// lives in refs and writes straight to the style — a 60Hz pinch never
// re-renders React.

import { useEffect, useRef } from "react";

const MIN_SCALE = 1;
/**
 * Fallback ceiling before the image reports its size. The real ceiling is
 * where the 4200px source runs out of pixels on THIS screen (see zoomAt) —
 * offering zoom beyond the source only manufactures blur.
 */
const MAX_SCALE_FALLBACK = 8;
/** Double-tap dives to a working zoom; a second double-tap returns to fit. */
const DOUBLE_TAP_SCALE = 3.5;
const DOUBLE_TAP_MS = 300;

export function SheetZoomViewer({ src, alt }: { src: string; alt: string }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const view = useRef({ scale: 1, tx: 0, ty: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const lastTapAt = useRef(0);
  const movedSinceDown = useRef(0);

  useEffect(() => {
    const box = boxRef.current;
    const img = imgRef.current;
    if (!box || !img) return;

    // Zoom is applied by RESIZING the image's layout width, and the transform
    // only pans. This is the sharpness fix: a transform-scaled image gets
    // rasterized once at its layout size and stretched by the compositor —
    // on a retina phone that means zooming a ~1200px bitmap of a 4200px
    // source, i.e. mud. A layout resize makes the browser re-decode the
    // image at the real target size, so every zoom level draws from the full
    // raster. One <img> reflowing is cheap even at gesture rate.
    const apply = () => {
      const v = view.current;
      img.style.width = `${box.clientWidth * v.scale}px`;
      img.style.transform = `translate(${v.tx}px, ${v.ty}px)`;
    };

    /** Layout size the sheet takes at the current zoom. */
    const contentSize = () => {
      const v = view.current;
      const w = box.clientWidth * v.scale;
      const aspect =
        img.naturalWidth > 0 ? img.naturalHeight / img.naturalWidth : 0.7;
      return { w, h: w * aspect };
    };

    // Keep the sheet on screen: it may not leave a gap on the left/right once
    // wider than the box, and vertically it can sit anywhere between "top at
    // top" and "bottom at bottom" (centered while shorter than the box).
    const clampPan = () => {
      const v = view.current;
      const { w, h } = contentSize();
      const bw = box.clientWidth;
      const bh = box.clientHeight;
      const minX = Math.min(0, bw - w);
      v.tx = Math.min(Math.max(v.tx, minX), Math.max(0, bw - w));
      const minY = Math.min(0, bh - h);
      const maxY = Math.max(0, bh - h);
      v.ty = Math.min(Math.max(v.ty, minY), maxY);
      if (h < bh) v.ty = (bh - h) / 2;
    };

    // Sharp until the source is at 1:1 with the screen's device pixels, plus
    // a little headroom for reading at arm's length on site.
    const maxScale = () => {
      if (img.naturalWidth <= 0) return MAX_SCALE_FALLBACK;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      return Math.max(
        3,
        (img.naturalWidth / (box.clientWidth * dpr)) * 1.5,
      );
    };

    const zoomAt = (px: number, py: number, factor: number) => {
      const v = view.current;
      const next = Math.min(maxScale(), Math.max(MIN_SCALE, v.scale * factor));
      const k = next / v.scale;
      v.tx = px - k * (px - v.tx);
      v.ty = py - k * (py - v.ty);
      v.scale = next;
      clampPan();
      apply();
    };

    const local = (e: { clientX: number; clientY: number }) => {
      const r = box.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const onPointerDown = (e: PointerEvent) => {
      // Capture keeps a drag alive when the finger leaves the box; a pointer
      // the browser doesn't consider active (synthetic events, some pens)
      // throws here, and losing capture is no reason to lose the gesture.
      try {
        box.setPointerCapture(e.pointerId);
      } catch {
        /* gesture continues uncaptured */
      }
      pointers.current.set(e.pointerId, local(e));
      if (pointers.current.size === 1) movedSinceDown.current = 0;
    };

    const onPointerMove = (e: PointerEvent) => {
      const prev = pointers.current.get(e.pointerId);
      if (!prev) return;
      const now = local(e);
      const pts = pointers.current;

      if (pts.size === 2) {
        // Pinch: incremental — zoom by the distance ratio at the midpoint,
        // pan by the midpoint's own movement.
        const [a, b] = [...pts.entries()];
        const other = a[0] === e.pointerId ? b[1] : a[1];
        const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
        const d1 = Math.hypot(now.x - other.x, now.y - other.y);
        const mid0 = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 };
        const mid1 = { x: (now.x + other.x) / 2, y: (now.y + other.y) / 2 };
        view.current.tx += mid1.x - mid0.x;
        view.current.ty += mid1.y - mid0.y;
        if (d0 > 0) zoomAt(mid1.x, mid1.y, d1 / d0);
        else {
          clampPan();
          apply();
        }
      } else if (pts.size === 1) {
        view.current.tx += now.x - prev.x;
        view.current.ty += now.y - prev.y;
        movedSinceDown.current += Math.hypot(now.x - prev.x, now.y - prev.y);
        clampPan();
        apply();
      }
      pts.set(e.pointerId, now);
    };

    // Dive on a detail, or return to fit — shared by touch double-tap
    // (detected below off tap timing) and desktop double-click (native).
    const doubleActivate = (p: { x: number; y: number }) => {
      const v = view.current;
      if (v.scale > 1.05) {
        v.scale = 1;
        v.tx = 0;
        v.ty = 0;
        clampPan();
        apply();
      } else {
        zoomAt(p.x, p.y, DOUBLE_TAP_SCALE);
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      const wasTap = pointers.current.size === 1 && movedSinceDown.current < 8;
      pointers.current.delete(e.pointerId);
      if (!wasTap) return;
      const at = Date.now();
      if (at - lastTapAt.current < DOUBLE_TAP_MS) {
        lastTapAt.current = 0;
        doubleActivate(local(e));
      } else {
        lastTapAt.current = at;
      }
    };

    const onDblClick = (e: MouseEvent) => {
      e.preventDefault();
      doubleActivate(local(e));
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      zoomAt(p.x, p.y, e.deltaY < 0 ? 1.25 : 1 / 1.25);
    };

    // Start at fit, and re-fit if the image loads after mount.
    const reset = () => {
      view.current = { scale: 1, tx: 0, ty: 0 };
      clampPan();
      apply();
    };
    reset();
    img.addEventListener("load", reset);

    box.addEventListener("pointerdown", onPointerDown);
    box.addEventListener("pointermove", onPointerMove);
    box.addEventListener("pointerup", onPointerUp);
    box.addEventListener("pointercancel", onPointerUp);
    box.addEventListener("wheel", onWheel, { passive: false });
    box.addEventListener("dblclick", onDblClick);
    return () => {
      img.removeEventListener("load", reset);
      box.removeEventListener("pointerdown", onPointerDown);
      box.removeEventListener("pointermove", onPointerMove);
      box.removeEventListener("pointerup", onPointerUp);
      box.removeEventListener("pointercancel", onPointerUp);
      box.removeEventListener("wheel", onWheel);
      box.removeEventListener("dblclick", onDblClick);
    };
  }, [src]);

  return (
    <div ref={boxRef} className="sheet-zoom" role="img" aria-label={alt}>
      <img ref={imgRef} src={src} alt="" draggable={false} />
    </div>
  );
}
