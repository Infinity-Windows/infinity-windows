// The design switch in Settings (crew redesign K-X2, 2026-09-23) — the
// person's own "Use the new design" choice, and for the owner the two
// release-level controls: the master switch (K-X2) and the paid-time rule's
// effective date (K1.3 / Q69).
//
// Both designs mount this card, so a person on the new design can go back
// from the same place they left. The owner controls key off the REAL role:
// an owner previewing "installer" still sees them (they are about the
// company, not about the previewed role), and a non-owner never does — the
// RPCs refuse anyway, but a button that always fails is fat.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getCompanySettings,
  setNewDesignSwitch,
  setPaidTimeRuleDate,
  type CompanySettings,
} from "../../lib/companySettings";
import { useDesign } from "../../lib/design/context";
import { useT } from "../../lib/i18n";
import "../../lib/i18n/designCatalog";
import { isOwner } from "../../lib/install/types";
import {
  normalizeRuleDate,
  paidTimeRuleState,
} from "../../lib/paidTimeRule";
import { toastError, toastSuccess } from "../../lib/toast";
import { useEffectiveRole } from "../../lib/useEffectiveRole";

function todayLocalISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "2026-10-05" → the date as the phone's locale prints it. */
function prettyDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function DesignSettings() {
  const t = useT();
  const { design, choice, masterOn, setChoice } = useDesign();
  const { realRole } = useEffectiveRole();
  const onNew = design === "new";
  // The person's own choice may be "new" while the master switch is off — say
  // so, rather than showing a switch that appears to do nothing.
  const heldOff = masterOn === false && choice === "new";

  return (
    <>
      <section className="detail-card design-card" style={{ marginBottom: 12 }} aria-label={t("design.heading")}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("design.heading")}</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>{t("design.help")}</p>
        <p style={{ margin: "0 0 8px", fontWeight: 600 }}>
          {onNew ? t("design.current.new") : t("design.current.classic")}
        </p>
        {heldOff && <p className="muted" style={{ fontSize: 14 }}>{t("design.masterOff")}</p>}
        <div className="row-gap">
          <button
            type="button"
            className={`button-like design-choice${choice === "new" ? " active-pill" : ""}`}
            aria-pressed={choice === "new"}
            disabled={choice === null}
            onClick={() => setChoice("new")}
          >
            {t("design.useNew")}
          </button>
          <button
            type="button"
            className={`button-like design-choice${choice === "classic" ? " active-pill" : ""}`}
            aria-pressed={choice === "classic"}
            disabled={choice === null}
            onClick={() => setChoice("classic")}
          >
            {t("design.useClassic")}
          </button>
        </div>
      </section>
      {isOwner(realRole) && <OwnerReleaseControls />}
    </>
  );
}

/** Owner only: the master switch and the paid-time rule date. */
function OwnerReleaseControls() {
  const t = useT();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["companySettings"], queryFn: getCompanySettings });
  const row = settings.data ?? null;
  // A database that predates the column reads undefined → the controls
  // simply do not offer themselves (the house rule for a feature ahead of
  // its migration).
  const masterKnown = row != null && row.new_design_r1_enabled !== undefined;
  const masterOn = row?.new_design_r1_enabled ?? true;
  const today = todayLocalISO();
  const [date, setDate] = useState<string>("");
  const ruleDate = row?.paid_time_from_start_day_on ?? null;
  const state = paidTimeRuleState(row, today);

  const applyRow = (next: CompanySettings) => {
    queryClient.setQueryData(["companySettings"], next);
    void queryClient.invalidateQueries({ queryKey: ["companySettings"] });
  };
  const flipMaster = useMutation({
    mutationFn: (enabled: boolean) => setNewDesignSwitch("r1", enabled),
    onSuccess: applyRow,
    onError: (e) => toastError(e),
  });
  const saveDate = useMutation({
    mutationFn: (on: string | null) => setPaidTimeRuleDate(on),
    onSuccess: (next) => {
      applyRow(next);
      setDate("");
      toastSuccess(t("paidTime.saved"));
    },
    onError: (e) => toastError(e),
  });

  if (!masterKnown) return null;
  const pendingDate = normalizeRuleDate(date);

  return (
    <>
      <section className="detail-card" style={{ marginBottom: 12 }} aria-label={t("design.owner.heading")}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("design.owner.heading")}</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>{t("design.owner.help")}</p>
        <p style={{ margin: "0 0 8px", fontWeight: 600 }}>
          {masterOn ? t("design.owner.on") : t("design.owner.off")}
        </p>
        <button
          type="button"
          className={`button-like design-choice${masterOn ? "" : " active-pill"}`}
          disabled={flipMaster.isPending}
          onClick={() => flipMaster.mutate(!masterOn)}
        >
          {flipMaster.isPending
            ? t("design.owner.saving")
            : masterOn
              ? t("design.owner.turnOff")
              : t("design.owner.turnOn")}
        </button>
      </section>

      <section className="detail-card" style={{ marginBottom: 12 }} aria-label={t("paidTime.heading")}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("paidTime.heading")}</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>{t("paidTime.help")}</p>
        <p style={{ margin: "0 0 8px", fontWeight: 600 }}>
          {state === "off"
            ? t("paidTime.state.off")
            : state === "scheduled"
              ? t("paidTime.state.scheduled", { date: prettyDate(ruleDate!) })
              : t("paidTime.state.on", { date: prettyDate(ruleDate!) })}
        </p>
        <label className="field-label" htmlFor="paid-time-from">{t("paidTime.from")}</label>
        <input
          id="paid-time-from"
          type="date"
          className="design-date"
          value={date}
          min={today}
          onChange={(e) => setDate(e.target.value)}
        />
        <div className="row-gap" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="button-like design-choice active-pill"
            disabled={!pendingDate || saveDate.isPending}
            onClick={() => saveDate.mutate(pendingDate)}
          >
            {t("paidTime.save")}
          </button>
          {ruleDate && (
            <button
              type="button"
              className="button-like design-choice"
              disabled={saveDate.isPending}
              onClick={() => saveDate.mutate(null)}
            >
              {t("paidTime.clear")}
            </button>
          )}
        </div>
      </section>
    </>
  );
}
