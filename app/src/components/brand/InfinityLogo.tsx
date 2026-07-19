import type { CSSProperties } from "react";

export type InfinityLogoTone = "default" | "mono" | "onDark" | "glow";
export type InfinityLogoVariant = "full" | "icon" | "wordmark";

const WORDMARK_TEXT = "INFINITY WINDOWS";

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
 * Infinity Windows mark — a rounded-square window with a cross mullion (four
 * panes) and a subtle sunrise arc rising behind it. Drawn on a 24×24 viewBox
 * with coral `--primary` (or currentColor) strokes, mirroring the spirit of
 * Horizon's sun-over-horizon glyph.
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
      {/* Sunrise arc rising behind the window */}
      <path
        d="M7 6.5a5 5 0 0 1 10 0"
        stroke={color}
        strokeWidth={1.7}
        strokeLinecap="round"
        opacity={0.85}
      />
      {/* Window frame */}
      <rect
        x="4.75"
        y="8.25"
        width="14.5"
        height="11"
        rx="2.4"
        stroke={color}
        strokeWidth={1.9}
      />
      {/* Cross mullion — four panes */}
      <path
        d="M12 8.75v9.75M5.25 13.75h13.5"
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

/** Mark + "INFINITY WINDOWS" wordmark lockup (or either piece alone). */
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
