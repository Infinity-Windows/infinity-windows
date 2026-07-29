import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OpeningRowButton } from "./OpeningRowButton";

/**
 * The row's own control — "Claim" on the map list, the assignee picker on
 * dispatch — is a SIBLING of this button, never a child. That is what keeps a
 * foreman's dropdown tap from also opening a details panel: there is no click
 * path from a sibling into this button, and the surrounding `<li>` has no
 * handler of its own. So what's worth pinning down here is that the tap target
 * really is a button, that it says which opening it opens, and that it never
 * swallows another control.
 */
function markup(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

describe("OpeningRowButton", () => {
  const row = (expanded: boolean) =>
    markup(
      <OpeningRowButton
        openingCode="12-2"
        expanded={expanded}
        panelId="panel-12-2"
        onToggle={() => {}}
      >
        <strong>12-2</strong>
      </OpeningRowButton>,
    );

  it("is a real button, not a clickable div", () => {
    expect(row(false)).toContain('<button type="button"');
  });

  it("says which opening it opens, and its mark", () => {
    expect(row(false)).toContain('aria-label="Open details for 12-2, mark 12"');
  });

  it("reports whether the details are open", () => {
    expect(row(false)).toContain('aria-expanded="false"');
    expect(row(true)).toContain('aria-expanded="true"');
  });

  it("points at the panel only while the panel exists", () => {
    expect(row(false)).not.toContain("aria-controls");
    expect(row(true)).toContain('aria-controls="panel-12-2"');
  });

  it("shows a chevron that turns down when open", () => {
    expect(row(false)).toContain("›");
    expect(row(true)).toContain("▾");
  });

  it("keeps its own children, and nothing interactive, inside", () => {
    const html = row(false);
    expect(html).toContain("<strong>12-2</strong>");
    // One button, no nested links/selects/buttons — a nested control would be
    // both invalid and un-tappable without also firing the row.
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<select");
  });
});
