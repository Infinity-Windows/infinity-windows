export interface CatalogCsvRow {
  type_code: string;
  name: string;
  category: string | null;
  width_in: number | null;
  height_in: number | null;
  difficulty_rating: number | null;
  required_capability: string | null;
  tutorial_url: string | null;
  notes: string | null;
}

const CAPABILITY_VALUES = new Set([
  "nail_fin",
  "retrofit",
  "doors",
  "wet_glazing",
  "curtain_wall",
]);

const HEADER_ALIASES: Record<string, keyof CatalogCsvRow> = {
  type_code: "type_code",
  typecode: "type_code",
  code: "type_code",
  name: "name",
  category: "category",
  width_in: "width_in",
  width: "width_in",
  height_in: "height_in",
  height: "height_in",
  difficulty_rating: "difficulty_rating",
  difficulty: "difficulty_rating",
  required_capability: "required_capability",
  needs: "required_capability",
  tutorial_url: "tutorial_url",
  tutorial: "tutorial_url",
  notes: "notes",
};

function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      fields.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  fields.push(cur.trim());
  return fields;
}

function parseNumber(raw: string): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a catalog CSV into upsert-ready rows. Requires type_code + name.
 * Unknown columns are ignored. Blank lines skipped.
 */
export function parseCatalogCsv(text: string): {
  rows: CatalogCsvRow[];
  errors: string[];
} {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { rows: [], errors: ["CSV is empty"] };

  const headerFields = splitCsvLine(lines[0]).map((h) =>
    h.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_"),
  );
  const colMap: (keyof CatalogCsvRow | null)[] = headerFields.map(
    (h) => HEADER_ALIASES[h] ?? null,
  );
  if (!colMap.includes("type_code") || !colMap.includes("name")) {
    return {
      rows: [],
      errors: ["CSV must include type_code and name columns"],
    };
  }

  const rows: CatalogCsvRow[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const fields = splitCsvLine(lines[i]);
    const raw: Partial<Record<keyof CatalogCsvRow, string>> = {};
    colMap.forEach((key, idx) => {
      if (key) raw[key] = fields[idx] ?? "";
    });
    const type_code = (raw.type_code ?? "").trim().toUpperCase();
    const name = (raw.name ?? "").trim();
    if (!type_code || !name) {
      errors.push(`Line ${i + 1}: missing type_code or name`);
      continue;
    }
    if (seen.has(type_code)) {
      errors.push(`Line ${i + 1}: duplicate type_code ${type_code}`);
      continue;
    }
    seen.add(type_code);

    let difficulty = parseNumber(raw.difficulty_rating ?? "");
    if (difficulty !== null) {
      difficulty = Math.min(5, Math.max(1, Math.round(difficulty)));
    }

    const capRaw = (raw.required_capability ?? "")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    if (capRaw && !CAPABILITY_VALUES.has(capRaw)) {
      errors.push(
        `Line ${i + 1}: "${(raw.required_capability ?? "").trim()}" is not a badge (use nail_fin, retrofit, doors, wet_glazing, or curtain_wall)`,
      );
      continue;
    }

    rows.push({
      type_code,
      name,
      category: (raw.category ?? "").trim() || null,
      width_in: parseNumber(raw.width_in ?? ""),
      height_in: parseNumber(raw.height_in ?? ""),
      difficulty_rating: difficulty,
      required_capability: capRaw || null,
      tutorial_url: (raw.tutorial_url ?? "").trim() || null,
      notes: (raw.notes ?? "").trim() || null,
    });
  }

  return { rows, errors };
}
