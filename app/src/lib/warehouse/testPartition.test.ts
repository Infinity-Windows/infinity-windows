import { describe, expect, it } from "vitest";
import { partitionTestPackages, testProjectIds } from "./testPartition";

describe("testProjectIds", () => {
  it("collects only the projects flagged is_test", () => {
    const ids = testProjectIds([
      { id: "real-1", is_test: false },
      { id: "test-1", is_test: true },
      { id: "real-2" },
    ]);
    expect(ids).toEqual(new Set(["test-1"]));
  });

  it("is empty when nothing is flagged — the installer/foreman case, since RLS never hands them a test project at all", () => {
    const ids = testProjectIds([{ id: "real-1", is_test: false }, { id: "real-2" }]);
    expect(ids.size).toBe(0);
  });
});

describe("partitionTestPackages", () => {
  const pkg = (id: string, projectId: string | null) => ({ id, project_id: projectId });

  it("splits packages into real and testing by project id", () => {
    const testIds = new Set(["black22"]);
    const packages = [
      pkg("p1", "black22"),
      pkg("p2", "black22"),
      pkg("p3", "real-job"),
    ];
    const { real, testing } = partitionTestPackages(packages, testIds);
    expect(real.map((p) => p.id)).toEqual(["p3"]);
    expect(testing.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("treats Boneyard stock (no project) as real, never testing", () => {
    const testIds = new Set(["black22"]);
    const packages = [pkg("p1", null)];
    const { real, testing } = partitionTestPackages(packages, testIds);
    expect(real.map((p) => p.id)).toEqual(["p1"]);
    expect(testing).toHaveLength(0);
  });

  it("is a no-op when no project is flagged test", () => {
    const packages = [pkg("p1", "job-1"), pkg("p2", null)];
    const { real, testing } = partitionTestPackages(packages, new Set());
    expect(real).toHaveLength(2);
    expect(testing).toHaveLength(0);
  });

  it("returns everything as testing when every package belongs to the one flagged job", () => {
    const testIds = new Set(["black22"]);
    const packages = [pkg("p1", "black22"), pkg("p2", "black22")];
    const { real, testing } = partitionTestPackages(packages, testIds);
    expect(real).toHaveLength(0);
    expect(testing).toHaveLength(2);
  });
});
