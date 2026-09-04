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

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import { formatApiError } from "../../lib/errors";
import { useLanguage, useT } from "../../lib/i18n";
import type { TKey } from "../../lib/i18n/catalog";
import {
  GC_CHANNELS,
  GC_SET_PREFERENCES,
  firstMissingAnswer,
  gcCheckinsKey,
  gcCheckinsLatestKey,
  listGcCheckins,
  logGcCheckin,
  type GcCheckin,
  type GcCheckinDraft,
  type GcCheckinProblem,
} from "../../lib/gc";
import { shortDay } from "../../lib/pipeline";

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

export function GcPanel({ projectId, isLead }: { projectId: string; isLead: boolean }) {
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
    </section>
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
