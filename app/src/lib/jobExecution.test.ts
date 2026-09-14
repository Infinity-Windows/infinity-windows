import { describe, expect, it, vi } from "vitest";
vi.mock("./supabase", () => ({ supabase: {} }));
import { JOB_STAGES, laborVariance, optionalPositive } from "./jobExecution";
describe("job execution", () => {
  it("keeps the owner's ten named stages in order", () => {
    expect(JOB_STAGES.map(([, label]) => label)).toEqual(["Material Delivered", "Material Onsite", "RO's Checked", "RO's Flashed", "Frames Set", "Glass/Doors Installed", "Hardware Installed", "Detail Work", "QC Passed", "Customer Approved"]);
  });
  it("distinguishes blank, valid, and invalid manual targets", () => {
    expect(optionalPositive(" ")).toBeNull(); expect(optionalPositive("180.5")).toBe(180.5);
    for (const value of ["0", "-10", "NaN", "Infinity", "two"]) expect(() => optionalPositive(value)).toThrow();
  });
  it("scores both sides of the estimate without dividing by an absent budget", () => {
    expect(laborVariance(180, 200)).toBe(-10); expect(laborVariance(220, 200)).toBe(10);
    expect(laborVariance(190, 200)).toBe(-5); expect(laborVariance(200, 200)).toBe(0);
    expect(laborVariance(50, null)).toBeNull(); expect(laborVariance(50, 0)).toBeNull();
  });
});
