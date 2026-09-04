// Wave Z, Z5: reading a dropped-in card statement, before any of it is money.
//
// THE DESIGN DECISION THIS FILE IS: nobody here knows what columns any
// particular export uses. Not the bank's, not the bookkeeper's spreadsheet, not
// the one the owner's accountant will send next year. So the app does NOT
// pretend to know: it reads the header row, offers its best guess at which
// column is the date, the amount, the description and the cardholder, and a
// human confirms or corrects it before a single row is imported. The guess is a
// convenience; the confirmation is the contract.
//
// The confirmed mapping is remembered per FILENAME PATTERN (digits blanked out,
// so "statement-2026-08.csv" and "statement-2026-09.csv" are one pattern), in
// localStorage, so the second month is one tap. Every read and write of that
// store is wrapped: a private window, cleared site data or a browser that
// refuses storage must leave the importer working, just without the memory.
//
// No bank credentials are involved anywhere in this feature. The handoff is a
// file a person exports and drops in.

/** The four things a charge needs, plus the bank's own id when it has one. */
export interface BankFieldMapping {
  postedOn: string | null;
  amount: string | null;
  description: string | null;
  cardholder: string | null;
  externalId: string | null;
}

/** One charge, in the shape import_bank_transactions expects. */
export interface BankRowInput {
  posted_on: string | null;
  amount_cents: number;
  description: string | null;
  vendor_guess: string | null;
  cardholder: string | null;
  external_id: string | null;
}

export interface ParsedFile {
  headers: string[];
  /** Data rows only, each already aligned to `headers` by position. */
  rows: string[][];
}

// ------------------------------------------------------------------ parsing

/**
 * A delimited file (comma or tab), quotes and all. Deliberately hand-written
 * rather than a dependency: the whole grammar is "quotes protect delimiters and
 * newlines, and a doubled quote is a literal one", and a CSV parser is a lot of
 * bytes to ship to a phone for that.
 */
export function parseDelimited(text: string): ParsedFile {
  const clean = text.replace(/^﻿/, "");
  const delimiter = pickDelimiter(clean);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };
  const headers = nonEmpty[0].map((h) => h.trim());
  return { headers, rows: nonEmpty.slice(1) };
}

/** Tabs win only if the first line actually has more of them than commas. */
function pickDelimiter(text: string): string {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const commas = (firstLine.match(/,/g) ?? []).length;
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  return tabs > commas ? "\t" : ",";
}

// ------------------------------------------------------------------ guessing

const DATE_WORDS = ["posted", "post date", "transaction date", "date"];
const AMOUNT_WORDS = ["amount", "debit", "charge", "value", "total"];
const DESCRIPTION_WORDS = ["description", "merchant", "payee", "name", "memo", "details"];
const CARDHOLDER_WORDS = ["cardholder", "card holder", "employee", "user", "member", "who"];
const ID_WORDS = ["transaction id", "reference", "ref", "id"];

function bestHeader(headers: string[], words: string[]): string | null {
  const lower = headers.map((h) => h.toLowerCase());
  // Earlier words are stronger signals: "posted date" should beat a bare "date"
  // column sitting next to it, which on most exports is the settlement date.
  for (const word of words) {
    const exact = lower.indexOf(word);
    if (exact >= 0) return headers[exact];
  }
  for (const word of words) {
    const partial = lower.findIndex((h) => h.includes(word));
    if (partial >= 0) return headers[partial];
  }
  return null;
}

/**
 * The app's opening offer, never its conclusion. A human confirms this before
 * anything is imported — which is exactly why guessing wrong here is cheap and
 * why the mapping step exists at all.
 */
export function guessMapping(headers: string[]): BankFieldMapping {
  return {
    postedOn: bestHeader(headers, DATE_WORDS),
    amount: bestHeader(headers, AMOUNT_WORDS),
    description: bestHeader(headers, DESCRIPTION_WORDS),
    cardholder: bestHeader(headers, CARDHOLDER_WORDS),
    externalId: bestHeader(headers, ID_WORDS),
  };
}

// ------------------------------------------------------------------ values

/**
 * "$1,234.56", "(12.50)", "-12.50", "12.50 DR" -> whole cents.
 *
 * Parentheses are the accountant's minus sign and appear in real exports;
 * treating "(12.50)" as 1250 would flip a refund into a charge. Null when the
 * cell is not a number at all, which is how a mis-mapped column announces
 * itself instead of importing a page of zeroes.
 */
export function parseAmountToCents(raw: string): number | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const negative = /^\(.*\)$/.test(text) || text.includes("-");
  const digits = text.replace(/[^0-9.]/g, "");
  if (!digits || !/^\d*\.?\d*$/.test(digits) || digits === ".") return null;
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  return negative ? -cents : cents;
}

/**
 * A date cell as "YYYY-MM-DD", or null.
 *
 * Handles the two spellings that actually turn up — ISO, and US M/D/YYYY — and
 * refuses everything else rather than handing `new Date()` an ambiguous string
 * and accepting whatever it decides. A statement imported with every date one
 * day out would quietly break the ±3-day match window.
 */
export function normalizeDate(raw: string): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) return pad(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(text);
  if (us) {
    let year = Number(us[3]);
    if (year < 100) year += 2000;
    return pad(year, Number(us[1]), Number(us[2]));
  }
  return null;
}

function pad(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The vendor, guessed off the description line for matching purposes only.
 * Card descriptions are shouty and carry store numbers and cities
 * ("HOME DEPOT #4512 OREM UT"), so this keeps the leading words and drops the
 * noise. It is never shown as fact — the receipt's own vendor is.
 */
export function vendorGuess(description: string | null): string | null {
  if (!description) return null;
  const words = description
    .replace(/[#*]\S*/g, " ")
    .replace(/\b\d{3,}\b/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const kept = words.slice(0, 3).join(" ").trim();
  return kept ? kept : null;
}

/**
 * Rows in the shape the RPC wants. A row whose amount cannot be read is DROPPED
 * rather than imported as zero — a statement with phantom zero-dollar charges
 * on it is worse than a short one, because it looks complete.
 */
export function toBankRows(parsed: ParsedFile, mapping: BankFieldMapping): BankRowInput[] {
  const at = (row: string[], header: string | null): string => {
    if (!header) return "";
    const i = parsed.headers.indexOf(header);
    return i >= 0 ? (row[i] ?? "") : "";
  };

  const out: BankRowInput[] = [];
  for (const row of parsed.rows) {
    const cents = parseAmountToCents(at(row, mapping.amount));
    if (cents == null) continue;
    const description = at(row, mapping.description).trim() || null;
    out.push({
      posted_on: normalizeDate(at(row, mapping.postedOn)),
      amount_cents: cents,
      description,
      vendor_guess: vendorGuess(description),
      cardholder: at(row, mapping.cardholder).trim() || null,
      external_id: at(row, mapping.externalId).trim() || null,
    });
  }
  return out;
}

/** How many rows the file has that this mapping cannot read — shown before the
 * import so a wrong Amount column is caught by a person, not by silence. */
export function unreadableRows(parsed: ParsedFile, mapping: BankFieldMapping): number {
  return parsed.rows.length - toBankRows(parsed, mapping).length;
}

// ------------------------------------------------------------------ memory

const STORE_KEY = "forge.bankMapping.v1";

/**
 * "statement-2026-08.csv" and "statement-2026-09.csv" are the same export, one
 * month apart, so the digits come out and the pattern is what is remembered.
 */
export function filenamePattern(filename: string): string {
  return filename.toLowerCase().replace(/\d+/g, "#").trim();
}

type MappingStore = Record<string, BankFieldMapping>;

function readStore(): MappingStore {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as MappingStore) : {};
  } catch {
    // A private window, cleared site data, or a browser that throws on the
    // accessor itself. The importer works without the memory; it just asks.
    return {};
  }
}

/** The mapping confirmed last time for a file that looks like this one. */
export function rememberedMapping(filename: string): BankFieldMapping | null {
  return readStore()[filenamePattern(filename)] ?? null;
}

/** Remember what a human confirmed, so next month is one tap. Never throws. */
export function rememberMapping(filename: string, mapping: BankFieldMapping): void {
  try {
    const store = readStore();
    store[filenamePattern(filename)] = mapping;
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* storage unavailable — the mapping still applies to THIS import */
  }
}

/**
 * The mapping to start the confirmation step with: what was confirmed for a
 * file like this before, narrowed to columns this file actually has, else the
 * guess. A remembered mapping naming a column that is gone would silently
 * import a blank field.
 */
export function openingMapping(filename: string, headers: string[]): BankFieldMapping {
  const remembered = rememberedMapping(filename);
  if (!remembered) return guessMapping(headers);
  const keep = (h: string | null) => (h && headers.includes(h) ? h : null);
  const narrowed: BankFieldMapping = {
    postedOn: keep(remembered.postedOn),
    amount: keep(remembered.amount),
    description: keep(remembered.description),
    cardholder: keep(remembered.cardholder),
    externalId: keep(remembered.externalId),
  };
  const guess = guessMapping(headers);
  return {
    postedOn: narrowed.postedOn ?? guess.postedOn,
    amount: narrowed.amount ?? guess.amount,
    description: narrowed.description ?? guess.description,
    cardholder: narrowed.cardholder ?? guess.cardholder,
    externalId: narrowed.externalId ?? guess.externalId,
  };
}
