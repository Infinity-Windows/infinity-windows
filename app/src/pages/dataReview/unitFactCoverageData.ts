import type { ActivityRow } from "./activityRows";

export function unitFactCoverage(rows: ActivityRow[]) {
  const groups = new Map<string, ActivityRow[]>();
  for (const row of rows) {
    if (row.scope !== "Specific") continue;
    const key = JSON.stringify([row.jobId, row.openingId ?? row.unitId ?? row.id]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const fields = (["category", "subtype", "configuration", "system", "material"] as const).map(field => {
    let before = 0, known = 0, recovered = 0, conflict = 0, unknown = 0, reviewed = 0;
    for (const records of groups.values()) {
      if ((field === "category" || field === "subtype" || field === "configuration") && records.some(row => row.unitFacts?.review?.[field])) reviewed++;
      const classifications = records.map(row => row.unitFacts?.classification?.[field]);
      const baseline = field === "material" ? records.some(row => !row.unitFacts?.linkConflict && !!row.unitRecord?.facts.material?.trim() && row.unitRecord.facts.material.trim().toLowerCase() !== "unknown") : records.some(row => {
        const signature = row.unitFacts?.context?.opening.signature;
        if (field === "category") return signature?.kind === "window" || signature?.kind === "door";
        if (field !== "subtype") return false;
        return !!signature?.tiers?.some(tier => Object.values(tier.mix ?? {}).some(count => count > 0));
      });
      const values = new Set(classifications.filter(item => item?.status === "known").map(item => item?.value));
      if (baseline) before++;
      if (classifications.some(item => item?.status === "conflict") || values.size > 1) conflict++;
      else if (values.size === 1) { known++; if (!baseline) recovered++; }
      else unknown++;
    }
    return { field, before, known, recovered, conflict, unknown, reviewed };
  });
  return { units: groups.size, fields };
}
