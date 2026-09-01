import type { CSSProperties } from "react";

export type InfinityLogoTone = "default" | "mono" | "onDark" | "glow";
export type InfinityLogoVariant = "full" | "icon" | "wordmark";

const WORDMARK_TEXT = "FORGE WINDOWS";

const TONES: Record<InfinityLogoTone, string> = {
  default: "var(--primary)",
  mono: "currentColor",
  onDark: "oklch(0.98 0.005 80)",
  glow: "var(--primary)",
};

interface InfinityMarkProps {
  /** Pixel size (square). Omit to size via className. */
  size?: number;
  tone?: InfinityLogoTone;
  className?: string;
}

/**
 * Infinity Windows mark — a rounded-square window frame with a full cross
 * mullion (four equal panes) in coral `--primary`, plus a small sunrise sun
 * rising over the horizontal mullion *inside* the frame (a sun seen through
 * the window). Drawn on a 24×24 viewBox. Deliberately a WINDOW, never a lock:
 * the frame fills the glyph and the arc lives inside it, so there is no
 * shackle-over-body silhouette.
 */
export function InfinityMark({ size = 24, tone = "default", className }: InfinityMarkProps) {
  const color = TONES[tone];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/* Sunrise sun rising over the mullion "horizon", clipped inside the frame */}
      <path
        d="M6.75 12a2.6 2.6 0 0 1 5.2 0"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        opacity={0.9}
      />
      {/* Window frame — fills the glyph so it reads unmistakably as a window */}
      <rect
        x="3.5"
        y="3.5"
        width="17"
        height="17"
        rx="3.2"
        stroke={color}
        strokeWidth={1.9}
      />
      {/* Full cross mullion — four equal panes */}
      <path
        d="M12 3.75v16.5M3.75 12h16.5"
        stroke={color}
        strokeWidth={1.7}
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Monochrome mark for tab bars / places that inherit text color. */
export function InfinityTabIcon({ className }: { className?: string }) {
  return <InfinityMark tone="mono" className={className} />;
}

interface InfinityLogoProps {
  variant?: InfinityLogoVariant;
  tone?: InfinityLogoTone;
  size?: number;
  className?: string;
}

/** Mark + "FORGE WINDOWS" wordmark lockup (or either piece alone). */
export function InfinityLogo({
  variant = "full",
  tone = "default",
  size = 24,
  className,
}: InfinityLogoProps) {
  if (variant === "icon") {
    return <InfinityMark size={size} tone={tone} className={className} />;
  }

  const textStyle: CSSProperties = {
    fontSize: Math.round(size * 0.6),
    lineHeight: 1,
  };
  const word = (
    <span className="infinity-wordmark" style={textStyle}>
      {WORDMARK_TEXT}
    </span>
  );

  if (variant === "wordmark") {
    return <span className={`infinity-logo${className ? ` ${className}` : ""}`}>{word}</span>;
  }

  return (
    <span className={`infinity-logo${className ? ` ${className}` : ""}`}>
      <InfinityMark size={size} tone={tone} />
      {word}
    </span>
  );
}
