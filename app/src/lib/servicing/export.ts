import type { Project } from "../types";
import { serviceMediaBlob, getServiceVisit } from "./api";
import {
  serviceReadiness,
  serviceSeconds,
  serviceTotals,
  type ServiceSnapshot,
} from "./model";
import { durationText } from "../timeEntryExport";
export const billingLabel = (cause: string) =>
  ({
    manufacturer: "Strata",
    customer: "Forge to STG; STG to customer",
    installer: "Forge absorbs",
    pending: "Pending diagnosis",
  })[cause] ?? "Pending";
const safe = (s: string) => s.replace(/[^\p{L}\p{N}_.-]+/gu, "-").slice(0, 100);
const cell = (s: unknown) => {
  let text = String(s ?? "");
  if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
};
export function serviceHoursCsv(
  data: ServiceSnapshot[],
  jobs: Project[],
  zone = Intl.DateTimeFormat().resolvedOptions().timeZone,
) {
  const rows: unknown[][] = [
    [
      "Job",
      "Visit",
      "Unit",
      "Employee",
      "Activity",
      "Stage",
      "Start",
      "End",
      "Hours",
      "Description",
      "Billing responsibility",
      "Review",
      "Time zone",
      "Shared Strata (%)",
      "Shared STG/customer (%)",
      "Shared Forge (%)",
      "Shared cost explanation",
    ],
  ];
  for (const d of data)
    for (const s of [...d.sessions].sort((a, b) =>
      a.started_at.localeCompare(b.started_at),
    )) {
      const unit = d.units.find((u) => u.id === s.unit_id),
        job = jobs.find((j) => j.id === d.visit.project_id);
      rows.push([
        job?.name ?? d.visit.project_id,
        d.visit.id,
        unit?.label ?? "Shared trip",
        s.profiles?.display_name ?? s.profile_id,
        s.kind,
        s.stage,
        s.started_at,
        s.ended_at,
        (serviceSeconds(s) / 3600).toFixed(6),
        s.description,
        unit ? billingLabel(unit.cause) : "Shared cost allocation",
        d.visit.reviewed_at ? "Reviewed" : "Pending billing review",
        zone,
        ...(!unit && d.visit.reviewed_at && d.visit.allocation
          ? [
              d.visit.allocation.manufacturer,
              d.visit.allocation.customer,
              d.visit.allocation.installer,
              d.visit.allocation.reason,
            ]
          : ["", "", "", ""]),
      ]);
    }
  return "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n");
}
export async function checkedServiceReports(ids: string[]) {
  const data = await Promise.all(ids.map(getServiceVisit));
  if (data.some((d) => serviceReadiness(d).length))
    throw new Error("Complete the report checklist before exporting.");
  return data;
}
export function downloadService(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
async function imageBytes(blob: Blob): Promise<Uint8Array> {
  if (["image/jpeg", "image/png"].includes(blob.type))
    return new Uint8Array(await blob.arrayBuffer());
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 1800 / Math.max(image.width, image.height));
    canvas.width = image.width * scale;
    canvas.height = image.height * scale;
    canvas
      .getContext("2d")!
      .drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) =>
          b
            ? resolve(b)
            : reject(new Error("Photo could not be prepared for the report.")),
        "image/png",
      ),
    );
    return new Uint8Array(await png.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}
export async function buildServicePdf(
  data: ServiceSnapshot[],
  jobs: Project[],
  blobs: Map<string, Blob> = new Map(),
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica),
    bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([612, 792]),
    y = 740;
  const clean = (text: string) =>
    text
      .replace(/[—–]/g, "-")
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/→/g, "to")
      .replace(/\t/g, " ")
      .split("")
      .map((c) => {
        if (c === "\n") return c;
        try {
          regular.encodeText(c);
          return c;
        } catch {
          return "?";
        }
      })
      .join("");
  function newPage() {
    page = pdf.addPage([612, 792]);
    y = 740;
  }
  function line(text: string, size = 11, strong = false) {
    const font = strong ? bold : regular;
    for (const paragraph of clean(text).split("\n")) {
      let rest = paragraph;
      do {
        let n = rest.length;
        while (n > 0 && font.widthOfTextAtSize(rest.slice(0, n), size) > 508)
          n--;
        if (n === 0) n = 1;
        if (n < rest.length) {
          const space = rest.lastIndexOf(" ", n);
          if (space > n / 2) n = space;
        }
        if (y < 55) newPage();
        page.drawText(rest.slice(0, n), {
          x: 52,
          y,
          size,
          font,
          color: rgb(0.14, 0.08, 0.05),
        });
        y -= size + 5;
        rest = rest.slice(n).trimStart();
      } while (rest.length);
    }
  }
  for (let i = 0; i < data.length; i++) {
    const d = data[i],
      job = jobs.find((j) => j.id === d.visit.project_id),
      totals = serviceTotals(d);
    if (i) newPage();
    page.drawRectangle({
      x: 0,
      y: 766,
      width: 612,
      height: 26,
      color: rgb(1, 0.25, 0.14),
    });
    line("FORGE WINDOWS & DOORS", 13, true);
    y -= 9;
    line("Service visit report", 24, true);
    line(job ? `${job.job_code} - ${job.name}` : d.visit.project_id, 17, true);
    line(`Visit: ${d.visit.id}`);
    line(
      `Times shown in ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
      9,
    );
    line(
      `Date: ${d.visit.details.scheduled_date || d.visit.created_at.slice(0, 10)}`,
    );
    line(
      d.visit.reviewed_at
        ? "Billing responsibility reviewed"
        : "PENDING SUPERVISOR BILLING REVIEW",
      11,
      true,
    );
    y -= 10;
    line(
      `Crew: ${d.visit.details.crew_names || [...new Set(d.sessions.map((s) => s.profiles?.display_name ?? s.profile_id))].join(", ")}`,
    );
    line(`Truck: ${d.visit.details.truck || "Not entered"}`);
    line(
      `Estimated one-way miles: ${d.visit.details.estimated_miles ?? "Not entered"} | Actual round-trip miles: ${d.visit.details.actual_miles ?? "Not entered"}`,
    );
    line(
      `Lodging: ${d.visit.details.lodging ? "Required" : "Not required"} | Lodging $${d.visit.details.lodging_cost ?? 0} | Parts $${d.visit.details.parts_cost ?? 0} | Other $${d.visit.details.other_cost ?? 0}`,
    );
    if (d.visit.details.travel_notes) line(d.visit.details.travel_notes);
    line(
      `Service labor: ${durationText(totals.total)} | Shared travel / idle: ${durationText(totals.shared)}`,
      12,
      true,
    );
    line(
      `Unit labor by responsibility: Strata ${durationText(totals.byCause.manufacturer)} | STG/customer ${durationText(totals.byCause.customer)} | Forge ${durationText(totals.byCause.installer)}`,
      11,
    );
    if (d.visit.allocation && d.visit.reviewed_at)
      line(
        `Shared costs: Strata ${d.visit.allocation.manufacturer}% | STG/customer ${d.visit.allocation.customer}% | Forge ${d.visit.allocation.installer}%. ${d.visit.allocation.reason}`,
      );
    for (const unit of d.units) {
      y -= 14;
      line(`Unit ${unit.label} - ${unit.type_label}`, 16, true);
      line(
        Object.entries(unit.facts)
          .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`)
          .join(" | "),
      );
      line(
        `Fail point: ${unit.fail_point} | Responsibility: ${billingLabel(unit.cause)}`,
        11,
        true,
      );
      for (const [label, value] of [
        ["Reported / observed issue", unit.issue],
        ["Repair and parts", unit.repair],
        ["Verification / result", unit.verification + "\n" + unit.outcome],
        ["Confirmed memo", unit.memo_text],
        ["Prevention / lesson", unit.prevention],
        ["Next steps", unit.next_steps],
        ["Missing evidence explanation", unit.evidence_exception],
      ])
        if (value) {
          line(label, 11, true);
          line(value);
          y -= 5;
        }
      for (const m of d.media.filter((m) => m.unit_id === unit.id)) {
        if (m.kind === "voice" || m.kind === "video") {
          line(`${m.kind}: ${m.filename}`);
          if (m.transcript) line(`Original memo transcript: ${m.transcript}`);
          continue;
        }
        if (!m.content_type.startsWith("image/")) {
          line(`Attachment: ${m.filename}`);
          continue;
        }
        const blob = blobs.get(m.id) ?? (await serviceMediaBlob(m));
        blobs.set(m.id, blob);
        let bytes: Uint8Array;
        try {
          bytes = await imageBytes(blob);
        } catch {
          line(
            `Photo preview unavailable on this device: ${m.filename}. The original file is included in the evidence ZIP.`,
            10,
          );
          continue;
        }
        const image =
          m.content_type === "image/jpeg"
            ? await pdf.embedJpg(bytes)
            : await pdf.embedPng(bytes);
        const scale = Math.min(508 / image.width, 260 / image.height);
        const h = image.height * scale;
        if (y < h + 85) newPage();
        line(`${m.kind}: ${m.caption || m.filename}`, 10, true);
        page.drawImage(image, {
          x: 52,
          y: y - h,
          width: image.width * scale,
          height: h,
        });
        y -= h + 16;
      }
    }
    y -= 15;
    line("Labor by person and unit", 16, true);
    for (const s of [...d.sessions].sort((a, b) =>
      a.started_at.localeCompare(b.started_at),
    )) {
      const u = d.units.find((u) => u.id === s.unit_id);
      line(
        `${s.profiles?.display_name ?? s.profile_id} | ${u ? "Unit " + u.label : s.kind} | ${s.stage} | ${durationText(serviceSeconds(s))}`,
        11,
        true,
      );
      line(
        `${new Date(s.started_at).toLocaleString()} - ${s.ended_at ? new Date(s.ended_at).toLocaleString() : ""}`,
        10,
      );
      if (s.description) line(s.description);
      y -= 5;
    }
    line(
      "Original audio and video are included in the evidence ZIP. This report does not create or send an invoice.",
      9,
    );
  }
  const pages = pdf.getPages();
  pages.forEach((p, i) =>
    p.drawText(`${i + 1} / ${pages.length}`, {
      x: 530,
      y: 25,
      size: 9,
      font: regular,
    }),
  );
  return pdf.save();
}
export async function exportServiceReports(
  ids: string[],
  jobs: Project[],
  format: "csv" | "pdf" | "zip",
) {
  const data = await checkedServiceReports(ids),
    stem = `Forge-Service-${ids.length === 1 ? safe(jobs.find((j) => j.id === data[0].visit.project_id)?.job_code ?? "Job") + "-" + ids[0].slice(0, 8) : "Visits-" + ids.length}`;
  const csv = serviceHoursCsv(data, jobs);
  if (format === "csv") {
    downloadService(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
      stem + ".csv",
    );
    return;
  }
  const blobs = new Map<string, Blob>();
  const bytes = await buildServicePdf(data, jobs, blobs);
  if (format === "pdf") {
    downloadService(
      new Blob([new Uint8Array(bytes)], { type: "application/pdf" }),
      stem + ".pdf",
    );
    return;
  }
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file(stem + ".pdf", bytes);
  zip.file("Service-hours.csv", csv);
  // The text companion preserves arbitrary Unicode even when PDF's standard font cannot draw it.
  zip.file("Service-records.json", JSON.stringify(data, null, 2));
  for (const d of data)
    for (const m of d.media) {
      const blob = blobs.get(m.id) ?? (await serviceMediaBlob(m));
      zip.file(
        `${d.visit.id}/${m.id}-${safe(m.filename)}`,
        await blob.arrayBuffer(),
      );
    }
  downloadService(await zip.generateAsync({ type: "blob" }), stem + ".zip");
}
