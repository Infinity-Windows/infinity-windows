import type { ReactNode } from "react";

/**
 * One row in a list: an optional done/todo state marker, a title with an
 * optional subtitle, and an optional trailing slot (a chip, a chevron, a
 * value). Built for S7's design pass on the unit sheet (Check stage's
 * checklist rows, SheetMore's fold rows).
 *
 * S6 (`installer/today-rebuilt`) was going to add a kit of exactly this
 * shape first, but had not merged when this was written — no commit named
 * "Group the installer's drawer…" existed on origin/master (CLAUDE.md's
 * instruction for this case). Written fresh here from the same two shapes
 * every list on this app already draws from: `.wh-row` (warehouse/storage)
 * and `StageChip` (components/warehouse/StageChip.tsx) — so a future merge
 * of that branch's own kit is a rename, not a redesign.
 */
export function ListRow({
  state,
  title,
  subtitle,
  trailing,
  onClick,
}: {
  /** ✓ / ○ / ! — the Check stage's "before you start" checklist reads this. */
  state?: "done" | "todo" | "warn";
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
}) {
  const interactive = Boolean(onClick);
  const Tag = interactive ? "button" : "div";
  return (
    <Tag
      className="ui-row"
      type={interactive ? "button" : undefined}
      onClick={onClick}
    >
      {state && (
        <span className={`ui-row-state ui-row-state--${state}`} aria-hidden>
          {state === "done" ? "✓" : state === "warn" ? "!" : "○"}
        </span>
      )}
      <span className="ui-row-main">
        <span className="ui-row-title">{title}</span>
        {subtitle && <span className="ui-row-sub">{subtitle}</span>}
      </span>
      {trailing && <span className="ui-row-trailing">{trailing}</span>}
    </Tag>
  );
}
