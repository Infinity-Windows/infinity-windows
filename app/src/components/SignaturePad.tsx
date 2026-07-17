import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

export interface SignaturePadHandle {
  clear: () => void;
  isEmpty: () => boolean;
  toDataUrl: () => string;
}

/**
 * Finger-drawable signature pad on an HTML canvas. Uses pointer events so it
 * works with touch, pen, and mouse. Renders on a white background so the
 * exported PNG embeds cleanly into the PDF.
 */
export const SignaturePad = forwardRef<
  SignaturePadHandle,
  { onChange?: (empty: boolean) => void; height?: number }
>(function SignaturePad({ onChange, height = 180 }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [empty, setEmpty] = useState(true);

  const ctx = () => canvasRef.current?.getContext("2d") ?? null;

  const resize = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const c = ctx();
    if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = "#ffffff";
    c.fillRect(0, 0, rect.width, rect.height);
    c.lineWidth = 2.5;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.strokeStyle = "#101014";
  };

  useEffect(() => {
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const markDirty = () => {
    if (empty) {
      setEmpty(false);
      onChange?.(false);
    }
  };

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    canvasRef.current?.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = pos(e);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    e.preventDefault();
    const c = ctx();
    if (!c || !last.current) return;
    const p = pos(e);
    c.beginPath();
    c.moveTo(last.current.x, last.current.y);
    c.lineTo(p.x, p.y);
    c.stroke();
    last.current = p;
    markDirty();
  };
  const up = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drawing.current = false;
    last.current = null;
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  useImperativeHandle(ref, () => ({
    clear: () => {
      resize();
      setEmpty(true);
      onChange?.(true);
    },
    isEmpty: () => empty,
    toDataUrl: () => canvasRef.current?.toDataURL("image/png") ?? "",
  }));

  return (
    <div className="sig-pad">
      <canvas
        ref={canvasRef}
        className="sig-canvas"
        style={{ height, touchAction: "none" }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={up}
      />
      <div className="sig-hint">{empty ? "Sign above with your finger" : ""}</div>
    </div>
  );
});
