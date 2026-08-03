import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MapPinLayer } from "./MapPinLayer";
import {
  OPENING_KIND_COLORS,
  OPENING_STATUS_COLORS,
  type ProjectOpening,
} from "../../lib/install/types";

/**
 * What a pin has to say, every time, without anyone toggling anything.
 *
 * All three of these were lost at once when the pin was reworked to encode
 * status as its fill: on a job where every opening is `planned` — which is every
 * job this company has — 42 marks came out the same yellow, and numbers switched
 * themselves off above fourteen marks on a page. A crew could not tell a door
 * from a window, or mark 23 from mark 24. The owner rejected that map on sight.
 *
 * Rendered to static markup, so this runs in `npm test` with no browser.
 */

const opening = (over: Partial<ProjectOpening> = {}): ProjectOpening =>
  ({
    id: over.id ?? "id-1",
    project_id: "p1",
    opening_code: "12-2",
    status: "planned",
    assigned_to: null,
    assignee: null,
    sequence: null,
    pin_x: 0.5,
    pin_y: 0.5,
    page_number: 1,
    label: null,
    window_types: null,
    ...over,
  }) as ProjectOpening;

function pins(
  openings: ProjectOpening[],
  kindOf: (o: ProjectOpening) => "door" | "window",
  showMarkNumbers = true,
): string {
  return renderToStaticMarkup(
    <MapPinLayer
      openings={openings}
      positions={
        new Map(openings.map((o, i) => [o.id, { x: 0.1 + i * 0.1, y: 0.5 }]))
      }
      autoIds={new Set()}
      selectedId={null}
      draggingId={null}
      dispatchMode={false}
      selection={[]}
      routeOrder={new Map()}
      routeNewIds={new Set()}
      hasRoute={false}
      crewColors={new Map()}
      voidedIds={new Set()}
      effectiveRole="installer"
      showMarkNumbers={showMarkNumbers}
      unitKind={kindOf}
      canMoveMarks={false}
      movedIds={new Set()}
      pinTitle={(o) => o.opening_code}
      onPinPointerDown={() => () => {}}
    />,
  );
}

describe("MapPinLayer", () => {
  it("colours a window blue and a door green", () => {
    const window = pins([opening()], () => "window");
    const door = pins([opening()], () => "door");
    expect(window).toContain(`--pin-fill:${OPENING_KIND_COLORS.window}`);
    expect(window).not.toContain(OPENING_KIND_COLORS.door);
    expect(door).toContain(`--pin-fill:${OPENING_KIND_COLORS.door}`);
    expect(door).not.toContain(OPENING_KIND_COLORS.window);
  });

  it("gives a door a square pin as well as a green one", () => {
    expect(pins([opening()], () => "door")).toContain("plan-dot--door");
    expect(pins([opening()], () => "window")).not.toContain("plan-dot--door");
  });

  it("rings the pin in its install status, so both read at once", () => {
    for (const status of ["planned", "assigned", "installed"] as const) {
      const html = pins([opening({ status })], () => "window");
      expect(html).toContain(`--pin-ring:${OPENING_STATUS_COLORS[status]}`);
      expect(html).toContain(`--pin-fill:${OPENING_KIND_COLORS.window}`);
    }
  });

  it("draws every mark number, on a page as busy as Black Desert's", () => {
    const many = Array.from({ length: 42 }, (_, i) =>
      opening({ id: `id-${i}`, opening_code: `${i + 1}-1` }),
    );
    const html = pins(many, (o) =>
      Number(o.opening_code.split("-")[0]) % 3 === 0 ? "door" : "window",
    );
    expect(html.match(/plan-dot__mark/g)).toHaveLength(42);
    // The numbers themselves, not just the right number of spans.
    expect(html).toContain(">23</span>");
    expect(html).toContain(">42</span>");
    // And they are still two colours, not one.
    expect(html).toContain(OPENING_KIND_COLORS.window);
    expect(html).toContain(OPENING_KIND_COLORS.door);
  });

  it("keeps the colours when someone turns the numbers off", () => {
    const html = pins([opening()], () => "door", false);
    expect(html).not.toContain("plan-dot__mark");
    expect(html).toContain(`--pin-fill:${OPENING_KIND_COLORS.door}`);
  });
});
