// The GC card on a job's Overview (Wave H, H1): what the builder last said,
// and the form for filing what he said today.
//
// Everyone can READ it. An installer walking onto a site should be able to find
// out that the GC wants the windows outset and the roof is not on yet, and
// hiding that behind a rank is how a crew installs a whole elevation the wrong
// way. Only the FILING is foreman+, and the server holds the same line inside
// log_gc_checkin.
//
// Degrades rather than crashes on a database that is behind the migration:
// listGcCheckins answers `known: false` instead of throwing, the card says
// nobody has checked in, and the form is simply not offered.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import { formatApiError } from "../../lib/errors";
import { useLanguage, useT } from "../../lib/i18n";
import type { TKey } from "../../lib/i18n/catalog";
import {
  GC_CHANNELS,
  GC_SET_PREFERENCES,
  createGcLink,
  currentGcLink,
  firstMissingAnswer,
  gcBrandOf,
  gcCheckinsKey,
  gcCheckinsLatestKey,
  gcLinkDelivery,
  gcLinkKey,
  gcThreadKey,
  listGcCheckins,
  listGcMessages,
  logGcCheckin,
  postGcMessage,
  revokeGcLink,
  sendGcLinkEmail,
  setProjectGcBrand,
  type GcBrand,
  type GcCheckin,
  type GcCheckinDraft,
  type GcCheckinProblem,
  type MintedGcLink,
} from "../../lib/gc";
import { gcLinkUrl } from "../../lib/gcToken";
import { shortDay } from "../../lib/pipeline";
import type { Project } from "../../lib/types";

/** The key each unanswered question complains with. */
const MISSING_KEYS: Record<GcCheckinProblem, TKey> = {
  expectedEndDate: "gc.missing.expectedEnd",
  roofOnDate: "gc.missing.roofOn",
  framingChecked: "gc.missing.framingChecked",
  setPreference: "gc.missing.setPreference",
  exteriorMaterial: "gc.missing.exterior",
  interiorMaterial: "gc.missing.interior",
  channel: "gc.missing.channel",
};

const CHANNEL_KEYS: Record<string, TKey> = {
  call: "gc.channel.call",
  text: "gc.channel.text",
  email: "gc.channel.email",
  site: "gc.channel.site",
  // Written only by the GC answering on his own page (gc_link_answer), never
  // offered on the form above — which is why GC_CHANNELS does not carry it.
  link: "gc.channel.link",
};

const SET_KEYS: Record<string, TKey> = {
  inset: "gc.set.inset",
  outset: "gc.set.outset",
  unknown: "gc.set.unknown",
};

const EMPTY: GcCheckinDraft = {
  expectedEndDate: "",
  roofOnDate: "",
  framingChecked: null,
  setPreference: "",
  exteriorMaterial: "",
  interiorMaterial: "",
  channel: "call",
  contactName: "",
  notes: "",
};

export function GcPanel({
  projectId,
  project,
  isLead,
}: {
  projectId: string;
  project: Project | null;
  isLead: boolean;
}) {
  const t = useT();
  const { lang } = useLanguage();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [draft, setDraft] = useState<GcCheckinDraft>(EMPTY);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const checkins = useQuery({
    queryKey: gcCheckinsKey(projectId),
    queryFn: () => listGcCheckins(projectId),
  });

  const latest = checkins.data?.rows[0] ?? null;
  const earlier = checkins.data?.rows.slice(1) ?? [];

  const file = useMutation({
    mutationFn: () => logGcCheckin(projectId, draft),
    onSuccess: async () => {
      setMessage(null);
      setSaved(true);
      setOpen(false);
      setDraft(EMPTY);
      await queryClient.invalidateQueries({ queryKey: gcCheckinsKey(projectId) });
      // The Jobs list draws its own chip from a batched read of every job's
      // latest check-in, so it has to be told too — otherwise the card here
      // says "spoke today" while the list still says "Needs a call".
      await queryClient.invalidateQueries({ queryKey: gcCheckinsLatestKey });
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const submit = () => {
    const missing = firstMissingAnswer(draft);
    if (missing) {
      setMessage(t(MISSING_KEYS[missing]));
      return;
    }
    file.mutate();
  };

  return (
    <section className="detail-card" style={{ marginBottom: 16 }}>
      <div className="row-between">
        <h2 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <MessageSquare size={16} aria-hidden />
          {t("gc.heading")}
        </h2>
        {isLead && checkins.data?.known && !open && (
          <button
            type="button"
            className="action-btn"
            style={{ minHeight: 48 }}
            onClick={() => {
              setSaved(false);
              setMessage(null);
              setOpen(true);
            }}
          >
            {t("gc.log")}
          </button>
        )}
      </div>

      {saved && <p className="wh-row-sub">{t("gc.saved")}</p>}

      {!latest && !open && <p className="muted">{t("gc.noCheckins")}</p>}

      {latest && !open && (
        <>
          <CheckinSummary checkin={latest} lang={lang} />
          {earlier.length > 0 && (
            <button
              type="button"
              className="link"
              onClick={() => setShowHistory((v) => !v)}
            >
              {showHistory ? t("gc.hideHistory") : t("gc.showHistory")}
            </button>
          )}
          {showHistory && (
            <div style={{ marginTop: 8 }}>
              <h3 className="field-label">{t("gc.history")}</h3>
              {earlier.map((row) => (
                <div key={row.id} style={{ marginTop: 8 }}>
                  <CheckinSummary checkin={row} lang={lang} />
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {open && (
        <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
          <label className="field">
            <span className="field-label">{t("gc.expectedEnd")}</span>
            <input
              type="date"
              aria-label={t("gc.expectedEnd")}
              value={draft.expectedEndDate}
              onChange={(e) => setDraft({ ...draft, expectedEndDate: e.target.value })}
            />
          </label>

          <label className="field">
            <span className="field-label">{t("gc.roofOn")}</span>
            <input
              type="date"
              aria-label={t("gc.roofOn")}
              value={draft.roofOnDate}
              onChange={(e) => setDraft({ ...draft, roofOnDate: e.target.value })}
            />
          </label>

          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">{t("gc.framingChecked")}</legend>
            <div className="row-gap" style={{ flexWrap: "wrap" }}>
              <button
                type="button"
                className={draft.framingChecked === true ? "button-like active-pill" : "button-like"}
                onClick={() => setDraft({ ...draft, framingChecked: true })}
              >
                {t("gc.yes")}
              </button>
              <button
                type="button"
                className={draft.framingChecked === false ? "button-like active-pill" : "button-like"}
                onClick={() => setDraft({ ...draft, framingChecked: false })}
              >
                {t("gc.no")}
              </button>
            </div>
          </fieldset>

          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">{t("gc.setPreference")}</legend>
            <div className="row-gap" style={{ flexWrap: "wrap" }}>
              {GC_SET_PREFERENCES.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={
                    draft.setPreference === value ? "button-like active-pill" : "button-like"
                  }
                  onClick={() => setDraft({ ...draft, setPreference: value })}
                >
                  {t(SET_KEYS[value])}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="field">
            <span className="field-label">{t("gc.exterior")}</span>
            <input
              type="text"
              aria-label={t("gc.exterior")}
              placeholder={t("gc.exteriorHint")}
              value={draft.exteriorMaterial}
              onChange={(e) => setDraft({ ...draft, exteriorMaterial: e.target.value })}
            />
          </label>

          <label className="field">
            <span className="field-label">{t("gc.interior")}</span>
            <input
              type="text"
              aria-label={t("gc.interior")}
              placeholder={t("gc.interiorHint")}
              value={draft.interiorMaterial}
              onChange={(e) => setDraft({ ...draft, interiorMaterial: e.target.value })}
            />
          </label>

          <label className="field">
            <span className="field-label">{t("gc.contactName")}</span>
            <input
              type="text"
              aria-label={t("gc.contactName")}
              value={draft.contactName ?? ""}
              onChange={(e) => setDraft({ ...draft, contactName: e.target.value })}
            />
          </label>

          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">{t("gc.channel")}</legend>
            <div className="row-gap" style={{ flexWrap: "wrap" }}>
              {GC_CHANNELS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={draft.channel === value ? "button-like active-pill" : "button-like"}
                  onClick={() => setDraft({ ...draft, channel: value })}
                >
                  {t(CHANNEL_KEYS[value])}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="field">
            <span className="field-label">{t("gc.notes")}</span>
            <textarea
              aria-label={t("gc.notes")}
              rows={2}
              value={draft.notes ?? ""}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            />
          </label>

          <div className="row-gap" style={{ flexWrap: "wrap" }}>
            <button
              type="button"
              className="action-btn"
              style={{ minHeight: 48 }}
              disabled={file.isPending}
              onClick={submit}
            >
              {file.isPending ? t("gc.saving") : t("gc.save")}
            </button>
            <button
              type="button"
              className="link"
              onClick={() => {
                setOpen(false);
                setMessage(null);
              }}
            >
              {t("gc.cancel")}
            </button>
          </div>
        </div>
      )}

      {message && <p className="error">{message}</p>}

      {/* The link half: foreman+ only. An installer reading what the GC said is
          useful; an installer emailing him is not. */}
      {isLead && <GcLinkPanel projectId={projectId} project={project} />}
    </section>
  );
}
/**
 * The link half of the GC card (Wave H, H2): hand this job to its builder, and
 * talk to him on the page he opens.
 *
 * Foreman+ only, and hidden entirely below that — an installer reading what the
 * GC said is useful, an installer emailing him is not.
 */
function GcLinkPanel({ projectId, project }: { projectId: string; project: Project | null }) {
  const t = useT();
  const { lang } = useLanguage();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The plaintext token, held ONLY for as long as this card is open. The
  // database keeps a sha256 and nothing else, so this is the one copy on our
  // side and it goes when the page does — which the copy: hint says out loud.
  const [minted, setMinted] = useState<MintedGcLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [reply, setReply] = useState("");

  const link = useQuery({
    queryKey: gcLinkKey(projectId),
    queryFn: () => currentGcLink(projectId),
  });
  const thread = useQuery({
    queryKey: gcThreadKey(projectId),
    queryFn: () => listGcMessages(projectId),
  });

  const brand = gcBrandOf(project?.gc_brand);
  const live = link.data?.link ?? null;

  useEffect(() => {
    // Prefill from the job's own contact email — the office typed it once when
    // the job was made and should not type it again.
    setEmail((current) => current || live?.sent_to_email || project?.contact_email || "");
  }, [live?.sent_to_email, project?.contact_email]);

  const send = useMutation({
    mutationFn: async () => {
      const address = email.trim();
      if (!address) throw new Error(t("gc.link.needEmail"));
      const made = await createGcLink(projectId, address, brand);
      setMinted(made);
      const result = await sendGcLinkEmail(
        made.link_id,
        made.token,
        `${window.location.origin}${import.meta.env.BASE_URL}`,
      );
      return result;
    },
    onSuccess: async (result) => {
      setProblem(null);
      setCopied(false);
      const to = result.to ?? email.trim();
      let line: string;
      if (result.unconfigured) {
        // "Not configured" is not a failure: the link exists and can be texted.
        // Saying so is the difference between a foreman copying it and a foreman
        // pressing the button again.
        line = t("gc.link.emailOff");
      } else if (!result.ok) {
        line = result.error ?? t("gc.link.emailOff");
      } else if (result.from) {
        // Which of the company's two mailboxes it came from, because the brands
        // mail from two addresses now and "which one did he get?" is the first
        // thing the office asks when a builder says nothing arrived.
        line = t("gc.link.sentToFrom", { email: to, from: result.from });
      } else {
        line = t("gc.link.sentTo", { email: to });
      }
      setNote(line);
      await queryClient.invalidateQueries({ queryKey: gcLinkKey(projectId) });
    },
    onError: (e) => {
      setNote(null);
      setProblem(formatApiError(e));
    },
  });

  const revoke = useMutation({
    mutationFn: (linkId: string) => revokeGcLink(linkId),
    onSuccess: async () => {
      setMinted(null);
      setNote(t("gc.link.off"));
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: gcLinkKey(projectId) });
    },
    onError: (e) => setProblem(formatApiError(e)),
  });

  const brandChoice = useMutation({
    mutationFn: (next: GcBrand) => setProjectGcBrand(projectId, next),
    onSuccess: async () => {
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      await queryClient.invalidateQueries({ queryKey: ["projectsAll"] });
    },
    onError: (e) => setProblem(formatApiError(e)),
  });

  const say = useMutation({
    mutationFn: () => postGcMessage(projectId, reply),
    onSuccess: async () => {
      setReply("");
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: gcThreadKey(projectId) });
    },
    onError: (e) => setProblem(formatApiError(e)),
  });

  // A database behind the migration has no gc_links table; the whole half of
  // the card simply is not offered, rather than showing buttons that 404.
  if (link.data && !link.data.known) return null;

  const url = minted
    ? gcLinkUrl(window.location.origin, import.meta.env.BASE_URL, minted.token)
    : null;

  // The "nothing was sent" note under the button is component state and is gone
  // on the next load of the job, so the STANDING line has to carry the truth.
  // gcLinkDelivery is where the rule lives and where it is tested.
  const delivery = gcLinkDelivery(live);
  let sentLine: string | null = null;
  if (delivery === "sent") {
    sentLine = t("gc.link.sentTo", { email: live?.sent_to_email ?? "" });
  } else if (delivery === "unsent") {
    sentLine = t("gc.link.notSent");
  }

  return (
    <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
      <h3 style={{ margin: "0 0 6px", fontSize: "1rem" }}>{t("gc.link.heading")}</h3>

      <div className="row-gap" style={{ flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <span className="field-label">{t("gc.brand.label")}</span>
        {(["stg", "forge"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={brand === value ? "button-like active-pill" : "button-like"}
            disabled={brandChoice.isPending}
            onClick={() => brandChoice.mutate(value)}
          >
            {value === "stg" ? t("gc.brand.stg") : t("gc.brand.forge")}
          </button>
        ))}
      </div>

      <p className="muted" style={{ margin: "8px 0 0" }}>
        {live
          ? t("gc.link.live", { date: shortDay(live.expires_at, lang) })
          : t("gc.link.none")}
        {sentLine ? ` · ${sentLine}` : ""}
        {live?.used_at ? ` · ${t("gc.link.answered", { date: shortDay(live.used_at, lang) })}` : ""}
      </p>

      <label className="field" style={{ marginTop: 8 }}>
        <span className="field-label">{t("gc.link.email")}</span>
        <input
          type="email"
          aria-label={t("gc.link.email")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>

      <div className="row-gap" style={{ flexWrap: "wrap", marginTop: 8 }}>
        <button
          type="button"
          className="action-btn"
          style={{ minHeight: 48 }}
          disabled={send.isPending}
          onClick={() => {
            const address = email.trim();
            if (!address) {
              setProblem(t("gc.link.needEmail"));
              return;
            }
            // Said BEFORE the tap: a fresh link turns the old one off, and a
            // builder holding the old one should not find that out by tapping
            // it. Confirmed, because this leaves the building.
            if (!window.confirm(t("gc.link.confirm", { email: address }))) return;
            send.mutate();
          }}
        >
          {send.isPending
            ? t("gc.link.sending")
            : live
              ? t("gc.link.resend")
              : t("gc.link.send")}
        </button>
        {live && (
          <button
            type="button"
            className="link"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate(live.id)}
          >
            {t("gc.link.revoke")}
          </button>
        )}
      </div>

      {url && (
        <div style={{ marginTop: 8 }}>
          <p className="wh-row-sub" style={{ margin: 0 }}>{t("gc.link.onceOnly")}</p>
          <p className="muted" style={{ wordBreak: "break-all", margin: "4px 0" }}>{url}</p>
          <button
            type="button"
            className="link"
            onClick={() => {
              void navigator.clipboard?.writeText(url).then(() => setCopied(true));
            }}
          >
            {copied ? t("gc.link.copied") : t("gc.link.copy")}
          </button>
        </div>
      )}

      {note && <p className="wh-row-sub">{note}</p>}

      <h3 style={{ margin: "16px 0 2px", fontSize: "1rem" }}>{t("gc.thread.heading")}</h3>
      <p className="muted" style={{ margin: 0 }}>{t("gc.thread.notCrewChat")}</p>

      {thread.data?.rows.length === 0 && <p className="muted">{t("gc.thread.empty")}</p>}
      {thread.data?.rows.map((line) => (
        <div key={line.id} style={{ marginTop: 8 }}>
          <p className="field-label" style={{ margin: 0 }}>
            {line.author === "gc" ? t("gc.thread.them") : t("gc.thread.us")}
            {" · "}
            {shortDay(line.created_at, lang)}
          </p>
          <p style={{ margin: 0 }}>{line.body}</p>
        </div>
      ))}

      <textarea
        aria-label={t("gc.thread.placeholder")}
        placeholder={t("gc.thread.placeholder")}
        rows={2}
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        style={{ width: "100%", marginTop: 8 }}
      />
      <button
        type="button"
        className="action-btn"
        style={{ minHeight: 48, marginTop: 4 }}
        disabled={say.isPending || !reply.trim()}
        onClick={() => say.mutate()}
      >
        {t("gc.thread.send")}
      </button>

      {problem && <p className="error">{problem}</p>}
    </div>
  );
}


/** One check-in, read back as a sentence rather than a table of six fields. */
function CheckinSummary({ checkin, lang }: { checkin: GcCheckin; lang: string }) {
  const t = useT();
  const day = (value: string | null) => shortDay(value, lang) || "—";
  return (
    <div>
      <p className="wh-row-sub" style={{ margin: "4px 0" }}>
        {t("gc.lastSpoke", { date: day(checkin.contacted_at) })}
        {checkin.contact_name ? ` · ${checkin.contact_name}` : ""}
        {CHANNEL_KEYS[checkin.channel] ? ` · ${t(CHANNEL_KEYS[checkin.channel])}` : ""}
        {/* Said out loud, because an answer the builder typed himself and an
            answer somebody remembered from a call are not the same evidence. */}
        {checkin.source === "gc" ? ` · ${t("gc.answeredByGc")}` : ""}
      </p>
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(150px, 100%), 1fr))",
          gap: "6px 16px",
          margin: 0,
        }}
      >
        <Fact label={t("gc.expectedEnd")} value={day(checkin.expected_end_date)} />
        <Fact label={t("gc.roofOn")} value={day(checkin.roof_on_date)} />
        <Fact
          label={t("gc.framingChecked")}
          value={checkin.framing_checked ? t("gc.yes") : t("gc.no")}
        />
        <Fact
          label={t("gc.setPreference")}
          value={SET_KEYS[checkin.set_preference] ? t(SET_KEYS[checkin.set_preference]) : "—"}
        />
        <Fact label={t("gc.exterior")} value={checkin.exterior_material} />
        <Fact label={t("gc.interior")} value={checkin.interior_material} />
      </dl>
      {checkin.notes && <p className="muted" style={{ marginTop: 4 }}>{checkin.notes}</p>}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="field-label">{label}</dt>
      <dd style={{ margin: 0 }}>{value}</dd>
    </div>
  );
}
