// The GC's name and number, on the GC card at the top of a job (owner,
// 2026-09-07: "put it up top by the main GC information"). The two values
// still live on project_build_facts — the GC handshake seeds the name there,
// and the green-light checklist reads it there — this is only WHERE a person
// sees and edits them. Everyone reads (an installer with a question wants
// the number); foreman+ edit, on blur, through the same offline outbox path
// the Job facts card uses.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  buildFactsKey,
  getBuildFacts,
  greenLightItemsKey,
  saveBuildFact,
  type BuildFactsPatch,
} from "../../lib/install/buildFacts";
import { useT } from "../../lib/i18n";
import { telHref } from "../../lib/travel/links";
import { pushToast, toastError } from "../../lib/toast";

export function GcContactFields({ projectId, isLead }: { projectId: string; isLead: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();

  const facts = useQuery({
    queryKey: buildFactsKey(projectId),
    queryFn: () => getBuildFacts(projectId),
  });

  const save = useMutation({
    mutationFn: (patch: BuildFactsPatch) => saveBuildFact(projectId, patch),
    onSuccess: () => {
      pushToast(t("buildFacts.saved"), "info");
      void queryClient.invalidateQueries({ queryKey: buildFactsKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: greenLightItemsKey(projectId) });
    },
    onError: (e) => toastError(e),
  });

  const f = facts.data ?? null;
  const name = f?.gc_contact_name ?? "";
  const phone = f?.gc_contact_phone ?? "";
  // defaultValue reads once per mount; remount only when the stored row
  // actually changes (a seed from a check-in, another tab's save).
  const revision = f?.updated_at ?? "new";

  if (!isLead) {
    if (!name && !phone) return null;
    const tel = telHref(phone);
    return (
      <p className="wh-row-sub gc-contact-line" style={{ margin: "6px 0 0" }}>
        {t("buildFacts.field.gcContactName")}: {name}
        {name && phone ? " · " : ""}
        {phone && (tel ? <a href={tel}>{phone}</a> : phone)}
      </p>
    );
  }

  const commit = (field: "gc_contact_name" | "gc_contact_phone", raw: string) => {
    const value = raw.trim();
    save.mutate({ [field]: value === "" ? null : value } as BuildFactsPatch);
  };

  return (
    <div className="gc-contact-grid">
      <div className="build-facts-field">
        <label className="field-label" htmlFor={`gc-contact-name-${projectId}`}>
          {t("buildFacts.field.gcContactName")}
        </label>
        <input
          id={`gc-contact-name-${projectId}`}
          key={`name-${revision}`}
          type="text"
          autoComplete="off"
          defaultValue={name}
          onBlur={(e) => {
            if (e.target.value.trim() !== name) commit("gc_contact_name", e.target.value);
          }}
        />
      </div>
      <div className="build-facts-field">
        <label className="field-label" htmlFor={`gc-contact-phone-${projectId}`}>
          {t("buildFacts.field.gcContactPhone")}
        </label>
        <input
          id={`gc-contact-phone-${projectId}`}
          key={`phone-${revision}`}
          type="tel"
          inputMode="tel"
          autoComplete="off"
          defaultValue={phone}
          onBlur={(e) => {
            if (e.target.value.trim() !== phone) commit("gc_contact_phone", e.target.value);
          }}
        />
      </div>
    </div>
  );
}
