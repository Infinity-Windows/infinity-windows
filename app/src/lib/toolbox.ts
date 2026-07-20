// Toolbox talks: signed daily safety-talk completions. Builds a dated PDF
// (talk content + drawn signature + typed name), archives it to the
// 'toolbox-records' storage bucket, and records the completion row that the
// server-side clock_in gate checks.
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { supabase } from "./supabase";
import type { SafetyTalk, TalkSections, TalkVisualAid } from "./ops";
import { sendPush } from "./permissions/pushServer";

const BUCKET = "toolbox-records";

export interface ToolboxCompletion {
  id: string;
  talk_id: string | null;
  profile_id: string | null;
  signed_at: string;
  typed_name: string | null;
  signature_path: string | null;
  talk_snapshot: string | null;
  pdf_path: string | null;
  created_at: string;
  safety_talks?: { title: string } | null;
  profiles?: { display_name: string } | null;
}

export interface ComplianceRow {
  profile_id: string;
  display_name: string;
  role: string;
  signed: boolean;
  signed_at: string | null;
}

function localDateStr(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** Today's signed completion for this user, if any (drives the clock-in gate). */
export async function myTodayCompletion(
  profileId: string,
): Promise<ToolboxCompletion | null> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from("toolbox_completions")
    .select("*")
    .eq("profile_id", profileId)
    .gte("signed_at", start.toISOString())
    .order("signed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as ToolboxCompletion | null;
}

/** This user's signed toolbox talks (their personal compliance record). */
export async function listMyCompletions(
  profileId: string,
): Promise<ToolboxCompletion[]> {
  const { data, error } = await supabase
    .from("toolbox_completions")
    .select("*, safety_talks(title)")
    .eq("profile_id", profileId)
    .order("signed_at", { ascending: false })
    .limit(60);
  if (error) throw error;
  return (data ?? []) as ToolboxCompletion[];
}

/** Foreman+ view: everyone on the crew and whether they've signed today. */
export async function todayCompliance(): Promise<ComplianceRow[]> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const [profilesRes, doneRes] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, display_name, role, active")
      .eq("active", true)
      .order("display_name"),
    supabase
      .from("toolbox_completions")
      .select("profile_id, signed_at")
      .gte("signed_at", start.toISOString()),
  ]);
  if (profilesRes.error) throw profilesRes.error;
  if (doneRes.error) throw doneRes.error;

  const signed = new Map<string, string>();
  for (const c of doneRes.data ?? []) {
    if (c.profile_id && !signed.has(c.profile_id)) {
      signed.set(c.profile_id, c.signed_at as string);
    }
  }
  return (profilesRes.data ?? []).map((p) => ({
    profile_id: p.id,
    display_name: p.display_name,
    role: p.role,
    signed: signed.has(p.id),
    signed_at: signed.get(p.id) ?? null,
  }));
}

/** Short-lived signed URL to view an archived PDF (or signature) in the bucket. */
export async function signedRecordUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, 3600);
  if (error) return null;
  return data.signedUrl;
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1] ?? "";
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** A serializable snapshot of the talk exactly as it was signed. */
export function talkSnapshot(talk: SafetyTalk): string {
  return JSON.stringify({
    id: talk.id,
    title: talk.title,
    body: talk.body,
    sections: talk.sections_json ?? null,
    visual_aids: (talk.visual_aids_json ?? []).map((v) => v.prompt),
    talk_date: talk.talk_date,
  });
}

function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

/** Build a dated PDF archive of the signed toolbox talk. */
export async function buildToolboxPdf(opts: {
  talk: SafetyTalk;
  typedName: string;
  signatureDataUrl: string;
  signedAt: Date;
}): Promise<Uint8Array> {
  const { talk, typedName, signatureDataUrl, signedAt } = opts;
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);

  const PAGE_W = 612;
  const PAGE_H = 792;
  const MARGIN = 54;
  const MAX_W = PAGE_W - MARGIN * 2;

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const ensureSpace = (needed: number) => {
    if (y - needed < MARGIN) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  };

  const drawPara = (
    text: string,
    size: number,
    font: PDFFont,
    color = rgb(0.1, 0.1, 0.12),
    gap = 4,
  ) => {
    for (const ln of wrapText(text, font, size, MAX_W)) {
      ensureSpace(size + gap);
      page.drawText(ln, { x: MARGIN, y: y - size, size, font, color });
      y -= size + gap;
    }
  };

  const heading = (text: string) => {
    y -= 8;
    ensureSpace(16);
    page.drawText(text, {
      x: MARGIN,
      y: y - 13,
      size: 13,
      font: bold,
      color: rgb(0.05, 0.3, 0.55),
    });
    y -= 20;
  };

  const bullets = (items: string[], marker = "•") => {
    const size = 11;
    for (const it of items) {
      const lines = wrapText(it, regular, size, MAX_W - 16);
      lines.forEach((ln, i) => {
        ensureSpace(size + 4);
        if (i === 0) {
          page.drawText(marker, { x: MARGIN, y: y - size, size, font: bold });
        }
        page.drawText(ln, {
          x: MARGIN + 16,
          y: y - size,
          size,
          font: regular,
          color: rgb(0.1, 0.1, 0.12),
        });
        y -= size + 4;
      });
    }
  };

  // Header.
  drawPara("Toolbox Talk — Safety Acknowledgement", 18, bold, rgb(0, 0, 0), 6);
  drawPara(talk.title, 14, bold, rgb(0.1, 0.1, 0.12), 6);
  drawPara(`Date: ${signedAt.toLocaleString()}`, 10, regular, rgb(0.4, 0.4, 0.45), 10);

  const s: TalkSections = talk.sections_json ?? {};
  if (s.intro) drawPara(s.intro, 11, regular);
  if (!s.intro && talk.body) drawPara(talk.body, 11, regular);

  if (s.key_hazards?.length) {
    heading("Key hazards");
    bullets(s.key_hazards, "!");
  }
  if (s.steps?.length) {
    heading("Step by step");
    s.steps.forEach((step, i) => bullets([step], `${i + 1}.`));
  }
  if (s.dos?.length) {
    heading("Do");
    bullets(s.dos, "✓");
  }
  if (s.donts?.length) {
    heading("Don't");
    bullets(s.donts, "✗");
  }

  const aids = talk.visual_aids_json ?? [];
  if (aids.length) {
    heading("Visual aids");
    for (const aid of aids) {
      if (aid.url && aid.url.startsWith("data:image")) {
        try {
          const img = await doc.embedPng(dataUrlToBytes(aid.url));
          const w = Math.min(MAX_W, 240);
          const h = (img.height / img.width) * w;
          ensureSpace(h + 8);
          page.drawImage(img, { x: MARGIN, y: y - h, width: w, height: h });
          y -= h + 8;
        } catch {
          drawPara(`Diagram: ${aid.prompt}`, 10, regular, rgb(0.4, 0.4, 0.45));
        }
      } else {
        drawPara(`Diagram: ${aid.prompt}`, 10, regular, rgb(0.4, 0.4, 0.45));
      }
    }
  }

  // Signature block.
  y -= 12;
  ensureSpace(160);
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_W - MARGIN, y },
    thickness: 1,
    color: rgb(0.8, 0.8, 0.82),
  });
  y -= 16;
  drawPara("I have read and understand this toolbox talk.", 11, bold, rgb(0, 0, 0), 8);
  drawPara(`Signed by: ${typedName}`, 11, regular, rgb(0.1, 0.1, 0.12), 6);

  try {
    const sig = await doc.embedPng(dataUrlToBytes(signatureDataUrl));
    const w = Math.min(260, MAX_W);
    const h = Math.min(90, (sig.height / sig.width) * w);
    ensureSpace(h + 12);
    page.drawText("Signature:", { x: MARGIN, y: y - 11, size: 10, font: regular });
    y -= 16;
    page.drawImage(sig, { x: MARGIN, y: y - h, width: w, height: h });
    y -= h + 4;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: MARGIN + w, y },
      thickness: 0.75,
      color: rgb(0.6, 0.6, 0.62),
    });
  } catch {
    drawPara("(signature image unavailable)", 10, regular, rgb(0.6, 0.2, 0.2));
  }

  return doc.save();
}

/**
 * Sign today's toolbox talk: build + archive the PDF, upload the signature
 * PNG, and record the completion row (which unlocks clock-in for today).
 */
export async function submitToolboxCompletion(opts: {
  talk: SafetyTalk;
  profileId: string;
  typedName: string;
  signatureDataUrl: string;
}): Promise<ToolboxCompletion> {
  const { talk, profileId, typedName, signatureDataUrl } = opts;
  const signedAt = new Date();
  const stamp = `${localDateStr(signedAt)}-${signedAt.getTime()}`;
  const base = `${profileId}/${talk.id}`;

  const sigPath = `${base}/${stamp}-signature.png`;
  const { error: sigErr } = await supabase.storage
    .from(BUCKET)
    .upload(sigPath, dataUrlToBytes(signatureDataUrl) as BlobPart, {
      contentType: "image/png",
      upsert: true,
    });
  if (sigErr) throw sigErr;

  const pdfBytes = await buildToolboxPdf({
    talk,
    typedName,
    signatureDataUrl,
    signedAt,
  });
  const pdfPath = `${base}/${stamp}.pdf`;
  const { error: pdfErr } = await supabase.storage
    .from(BUCKET)
    .upload(pdfPath, pdfBytes as BlobPart, {
      contentType: "application/pdf",
      upsert: true,
    });
  if (pdfErr) throw pdfErr;

  const { data, error } = await supabase
    .from("toolbox_completions")
    .insert({
      talk_id: talk.id,
      profile_id: profileId,
      typed_name: typedName,
      signature_path: sigPath,
      pdf_path: pdfPath,
      talk_snapshot: talkSnapshot(talk),
      signed_at: signedAt.toISOString(),
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as ToolboxCompletion;
}

/** Ask the Edge Function to (re)generate rich educational content for a talk. */
export async function generateToolboxTalk(params: {
  talkId?: string;
  topic?: string;
}): Promise<{ talk_id: string; title: string; images: number; aids: number }> {
  const { data, error } = await supabase.functions.invoke("generate-toolbox-talk", {
    body: { talk_id: params.talkId, topic: params.topic },
  });
  if (error) throw error;
  if (data?.error) throw new Error(String(data.error));
  const result = data as { talk_id: string; title: string; images: number; aids: number };
  // Web-push seam: when a lead publishes a BRAND-NEW toolbox talk (no talkId =
  // fresh topic), broadcast to every subscribed device so crew get pinged to
  // sign it before clock-in — even with the app closed. Regenerating an
  // existing talk (talkId present) does NOT re-notify. Fire-and-forget.
  if (!params.talkId) {
    void sendPush({
      title: "New toolbox talk to sign",
      body: result.title
        ? `Sign "${result.title}" before you clock in.`
        : "Sign today's safety talk before you clock in.",
      tag: `toolbox-talk-${result.talk_id}`,
      url: "/safety",
    });
  }
  return result;
}

/** Save foreman edits to a talk's structured content (kept editable by leads). */
export async function updateTalkSections(
  talkId: string,
  patch: { title?: string; sections_json?: TalkSections; visual_aids_json?: TalkVisualAid[] },
): Promise<void> {
  const { error } = await supabase.from("safety_talks").update(patch).eq("id", talkId);
  if (error) throw error;
}
