import { describe, expect, it } from "vitest";
import { parseCatalogCsv } from "./catalogCsv";

const SAMPLE = `type_code,name,category,width_in,height_in,difficulty_rating,tutorial_url,notes
CAS3050,Casement 30x50,casement,30,50,3,,Standard casement
DH2846,Double Hung 28x46,double-hung,28,46,2,,
SL6040,"Slider 60,40",slider,60,40,4,https://example.com/slider,Wide unit
`;

describe("parseCatalogCsv", () => {
  it("parses standard catalog rows", () => {
    const { rows, errors } = parseCatalogCsv(SAMPLE);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      type_code: "CAS3050",
      name: "Casement 30x50",
      category: "casement",
      width_in: 30,
      height_in: 50,
      difficulty_rating: 3,
    });
    expect(rows[2].name).toBe("Slider 60,40");
    expect(rows[2].tutorial_url).toContain("example.com");
  });

  it("rejects missing required headers", () => {
    const { rows, errors } = parseCatalogCsv("code,title\nA,B");
    expect(rows).toHaveLength(0);
    expect(errors[0]).toMatch(/type_code and name/);
  });

  it("flags duplicate codes", () => {
    const { rows, errors } = parseCatalogCsv(
      "type_code,name\nCAS1,One\nCAS1,Two",
    );
    expect(rows).toHaveLength(1);
    expect(errors.some((e) => e.includes("duplicate"))).toBe(true);
  });
});
