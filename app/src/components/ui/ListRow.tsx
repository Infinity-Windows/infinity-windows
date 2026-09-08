// One row shape for a tappable list item (kit item G, S6): an optional
// leading badge, a title/subtitle stack, and trailing content (a chip, a
// button). Built from the shape that already repeats across My Work's unit
// lists and the warehouse pages' `.wh-row` — this file owns the shape for
// the install side, `.wh-row` keeps owning warehouse's.
import type { ReactNode } from "react";

interface ListRowProps {
  badge?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  /** aria-label for a tappable row whose visible title alone doesn't say
   * what tapping it does (e.g. an order number badge, not a sentence). */
  "aria-label"?: string;
}

export function ListRow({
  badge,
  title,
  subtitle,
  trailing,
  onClick,
  "aria-label": ariaLabel,
}: ListRowProps) {
  const content = (
    <>
      {badge && <span className="kit-list-row-badge">{badge}</span>}
      <span className="kit-list-row-main">
        <span className="kit-list-row-title">{title}</span>
        {subtitle && <span className="kit-list-row-sub">{subtitle}</span>}
      </span>
      {trailing && <span className="kit-list-row-trailing">{trailing}</span>}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className="kit-list-row kit-list-row--tappable"
        onClick={onClick}
        aria-label={ariaLabel}
      >
        {content}
      </button>
    );
  }
  return <div className="kit-list-row">{content}</div>;
}
