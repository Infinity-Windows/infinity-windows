export interface CadText {
  text: string;
  x: number;
  y: number;
}

export interface CadUnitDraft {
  key: string;
  sheet: number;
  label: string;
  kind: "" | "window" | "door" | "curtain_wall";
  widthMm: number | null;
  heightMm: number | null;
  configuration: string;
  quantity: number | null;
  itemNumber?: string;
  material: string;
  crop: { left: number; top: number; right: number; bottom: number };
  dimensions: number[];
}

// Verified from the printed item tables in this named CAD export. PDF text
// extraction does not expose those tables, so bind each reading to its sheet
// title and drawing designation. Other exports continue to use plan evidence.
const building3ItemTable: Record<string, { number: string; quantity?: number }> = {
  "1:A": { number: "1", quantity: 18 },
  "1:A (SPANDREL)": { number: "2", quantity: 4 },
  "1:B": { number: "3", quantity: 5 },
  "1:B (SPANDREL)": { number: "4", quantity: 1 },
  "2:C": { number: "5", quantity: 1 },
  "6:DR 110A": { number: "26" },
  "7:CW1 & CW2": { number: "24" },
  "7:CW3 & CW4": { number: "25" },
};

// The manufacturer's Building 3 export uses a two-column, two-row drawing
// template. Gate these layout rules on its sheet title and heading positions.
export function building3CadDrafts(sheet: number, items: readonly CadText[]): CadUnitDraft[] {
  const title = items.map(item => /^Tech Ridge Building #3 CADs-(\d+)$/i.exec(item.text)).find(Boolean);
  if (!title) return [];

  const headings = items.filter(({ x, y, text }) =>
    ((x >= .07 && x <= .12) || (x >= .49 && x <= .54)) &&
    ((y >= .08 && y <= .12) || (y >= .44 && y <= .50)) &&
    /^(?:[A-Z](?:-\d+| \(spandrel\))?|Dr\s+\d+[a-z]?|CW\d+(?:\s*&\s*CW\d+)*)$/i.test(text),
  ).sort((a, b) => Number(a.y > .4) - Number(b.y > .4) || a.x - b.x);

  return headings.map(heading => {
    const rightColumn = heading.x > .4;
    const lowerRow = heading.y > .4;
    const crop = {
      left: rightColumn ? .508 : .081,
      right: rightColumn || !headings.some(other => other.x > .4 && (other.y > .4) === lowerRow) ? .934 : .508,
      top: lowerRow ? .458 : .076,
      bottom: lowerRow ? .86 : .456,
    };
    const region = items.filter(({ x, y }) => x >= crop.left && x < crop.right && y >= crop.top && y < crop.bottom);
    const dimensions = region.flatMap(item => {
      // A CAD dimension begins with native millimeters before its inch equivalent.
      // Fraction numerators and denominators arrive in separate PDF fragments.
      const match = /^(\d{2,5})\s*\(\s*\d/.exec(item.text);
      return match ? [{ mm: Number(match[1]), x: item.x, y: item.y }] : [];
    });
    const door = /^Dr\s/i.test(heading.text);
    const curtainWall = /^CW/i.test(heading.text);
    const rows = [...dimensions].sort((a, b) => b.y - a.y);
    const [overall, panel] = rows;
    const panelWidths = overall && panel && overall.y - panel.y > .012
      ? rows.slice(1).filter(item => Math.abs(item.y - panel.y) < .004)
      : [];
    const sideDimensions = overall && panel ? rows.filter(item =>
      item.y < panel.y - .015 && item.x > Math.max(overall.x, ...panelWidths.map(part => part.x)) + .008) : [];
    const fixedLabels = region.filter(item => item.text === "F").length;
    // Infer a simple flat fixed window only when the panel widths corroborate
    // the overall callout and a single side dimension establishes the height.
    const simpleWindow = !door && !curtainWall && !region.some(item => /°/.test(item.text)) &&
      fixedLabels === 2 && panelWidths.length === 2 && sideDimensions.length === 1 &&
      Math.abs(panelWidths.reduce((sum, part) => sum + part.mm, 0) - overall.mm) <= 2;

    const item = building3ItemTable[`${title[1]}:${heading.text.toUpperCase()}`];
    return {
      itemNumber: item?.number,
      key: `${sheet}:${heading.text}`, sheet, label: heading.text,
      // The designation alone says what kind of unit this is: this export
      // letters its windows (A, C, A-1), prefixes doors "Dr" and curtain
      // walls "CW". Size and configuration are a separate question and stay
      // empty unless the drawing is simple enough to read them, so a lettered
      // unit is a window that still needs its size checked. Tying the type to
      // the size reading left 17 of 27 definitions typeless, and every opening
      // matched to one could not become a unit.
      kind: curtainWall ? "curtain_wall" : door ? "door" : "window",
      widthMm: simpleWindow ? overall.mm : null,
      heightMm: simpleWindow ? sideDimensions[0].mm : null,
      configuration: simpleWindow ? "Two fixed panels" : "",
      quantity: item?.quantity ?? null,
      material: "",
      crop,
      dimensions: [...new Set(dimensions.map(item => item.mm))],
    };
  });
}
