// Facts captured by Forge AI must survive the manual Unit details editor: a
// material outside the list stays visible and selected, and components,
// direction, spoken size and "said unknown" are shown and ride along in the
// same facts object the editor saves.
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { UnitEditor } from "./UnitEditor";
import { factText, type WorkUnit } from "../../lib/customWork/model";

const unit: WorkUnit = {
  id: "u4", project_id: "job-1", opening_id: null, created_by: "me", label: "4", type_label: "Bifold door", revision: 3,
  created_at: "2026-09-22T00:00:00Z", updated_at: "2026-09-22T00:00:00Z",
  facts: {
    material: "Bronze-clad cedar", width_in: 72, height_in: 96, story: "1",
    components: [{ label: "Door panel", quantity: 2 }, { label: "Frame", quantity: 1 }],
    opening_direction: "left to right", direction_viewpoint: "outside looking in (default)",
    measurement_source: "width: six feet; height: eight feet", unknown_fields: ["electrical"],
  },
};

function render(u: WorkUnit) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["projects"], [{ id: "job-1", name: "Pine Hollow" }]);
  qc.setQueryData(["customWorkRoster"], []);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <UnitEditor unit={u} types={[]} busy={false} onSave={async () => undefined} onCancel={() => undefined} />
    </QueryClientProvider>,
  );
}

describe("Unit details with facts from Forge AI", () => {
  it("keeps a custom material selected instead of reading as Unknown", () => {
    const out = render(unit);
    expect(out).toMatch(/<option value="Bronze-clad cedar" selected="">Bronze-clad cedar<\/option>/);
  });
  it("shows components, direction, spoken size and said-unknown", () => {
    const out = render(unit);
    expect(out).toContain("2 × Door panel, 1 × Frame");
    expect(out).toContain("left to right");
    expect(out).toContain("outside looking in (default)");
    expect(out).toContain("width: six feet; height: eight feet");
    expect(out).toContain("Unknown (said unknown)");
  });
});

describe("fact text for Custom Data and exports", () => {
  it("writes arrays out rather than handing objects to React", () => {
    expect(factText("components", unit.facts.components)).toBe("2 × Door panel, 1 × Frame");
    expect(factText("unknown_fields", ["electrical", "type_label", "area_source"])).toBe("Electrical components, Type, Size source");
    expect(factText("width_in", 72)).toBe("72");
    expect(factText("x", { a: 1 })).toBe('{"a":1}');
  });
});
