import { BackChip } from "../components/BackChip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getMyProfile, listProfiles } from "../lib/install/api";
import { isForemanPlus } from "../lib/install/types";
import { addTool, listTools, setToolHolder } from "../lib/ops";
import { useT } from "../lib/i18n";

function dueSoon(date: string | null): boolean {
  if (!date) return false;
  const days = (new Date(date).getTime() - Date.now()) / 86400000;
  return days < 30;
}

export function Tools() {
  const t = useT();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const lead = isForemanPlus(me.data?.role);
  const tools = useQuery({ queryKey: ["tools"], queryFn: listTools });
  const crew = useQuery({ queryKey: ["profiles"], queryFn: listProfiles });
  const [name, setName] = useState("");
  const [due, setDue] = useState("");

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["tools"] });
  const add = useMutation({ mutationFn: () => addTool(name, due || null), onSuccess: () => { setName(""); setDue(""); refresh(); } });
  const setHolder = useMutation({
    mutationFn: (a: { id: string; holder: string | null }) => setToolHolder(a.id, a.holder),
    onSuccess: refresh,
  });

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{t("tools.title")}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {t("tools.subtitle")}
          </p>
        </div>
        <BackChip fallback="/" label={t("tools.home")} />
      </header>

      <ul className="unit-list work-list">
        {(tools.data ?? []).map((tool) => (
          <li key={tool.id} className="find-row">
            <div>
              <strong>{tool.name}</strong>
              <div className="muted" style={{ fontSize: 12 }}>
                {tool.profiles?.display_name
                  ? t("tools.withPerson", { name: tool.profiles.display_name })
                  : t("tools.inShop")}
                {tool.calibration_due && (
                  <span className={dueSoon(tool.calibration_due) ? "warn-text" : ""}>
                    {" "}
                    {t("tools.calibDue", { date: tool.calibration_due })}
                  </span>
                )}
              </div>
            </div>
            {lead && (
              <select
                style={{ marginLeft: "auto", maxWidth: "45vw", marginBottom: 0 }}
                value={tool.holder_id ?? ""}
                onChange={(e) => setHolder.mutate({ id: tool.id, holder: e.target.value || null })}
              >
                <option value="">{t("tools.shop")}</option>
                {(crew.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}
              </select>
            )}
          </li>
        ))}
        {tools.data?.length === 0 && <p className="muted">{t("tools.noneTracked")}</p>}
      </ul>

      {lead && (
        <>
          <h2>{t("tools.addToolHeading")}</h2>
          <div className="detail-card">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("tools.toolName")} />
            <label className="field-label">{t("tools.calibrationDue")}</label>
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            <button className="primary big" disabled={add.isPending || !name.trim()} onClick={() => add.mutate()}>{t("tools.addTool")}</button>
          </div>
        </>
      )}
    </div>
  );
}
