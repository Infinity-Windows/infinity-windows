import { useLanguage } from "../../lib/i18n";

// Workday details are saved with the activity session note.
export interface PilotOptions {
  travelPurpose?: string;
  travelOther?: string;
  consultingWith?: string;
  waitingReason?: string;
}
export function PilotActivityOptions({ activity, value, onChange }: {
  activity: string; value: PilotOptions; onChange: (value: PilotOptions) => void;
}) {
  const { lang } = useLanguage(), es = lang === "es";
  const text = (en: string, spanish: string) => es ? spanish : en;
  const travel = ["Travel", "Travel with product", "Company delivery"].includes(activity);
  const consulting = ["Consulting / planning", "Pre-planning"].includes(activity);
  const waiting = activity === "Waiting / blocked";
  const context: Record<string, [string, string]> = {
    "Staging": ["Hauling the unit and gathering supplies / tools", "Acarreo de la unidad y preparación de materiales / herramientas"],
    "Setting frame": ["Setting, leveling and securing the frame / unit", "Colocar, nivelar y fijar el marco / la unidad"],
    "Sealing": ["Caulking, taping and backer rod", "Sellador, cinta y cordón de respaldo"],
    "Repairs": ["Significant repairs or fixing mistakes", "Reparaciones importantes o corrección de errores"],
    "RO framing": ["Adding or fixing rough-opening framing", "Agregar o reparar el bastidor del vano"],
    "Problem-solving": ["Unit planning and problem-solving", "Planificación y resolución de problemas de la unidad"],
    "Cleanup": ["Cleaning and site maintenance", "Limpieza y mantenimiento de la obra"],
  };
  return <div className="wd-pilot-options">
    {context[activity] && <p>{context[activity][es ? 1 : 0]}</p>}
    {travel && <><label>{text("Travel purpose", "Motivo del traslado")}<select aria-label={text("Travel purpose", "Motivo del traslado")} value={value.travelPurpose ?? ""} onChange={e => onChange({ ...value, travelPurpose: e.target.value })}><option value="">{text("Choose…", "Elegir…")}</option><option value="supply-pickup">{text("Supply pickup", "Recoger materiales")}</option><option value="other">{text("Other", "Otro")}</option></select></label>{value.travelPurpose === "other" && <label>{text("Travel description", "Descripción del traslado")}<input aria-label={text("Travel description", "Descripción del traslado")} value={value.travelOther ?? ""} onChange={e => onChange({ ...value, travelOther: e.target.value })}/></label>}</>}
    {consulting && <label>{text("Consulting / planning with", "Consulta / planificación con")}<select aria-label={text("Consulting / planning with", "Consulta / planificación con")} value={value.consultingWith ?? ""} onChange={e => onChange({ ...value, consultingWith: e.target.value })}><option value="">{text("Choose…", "Elegir…")}</option><option value="gc-owner">{text("GC / owner", "Contratista general / propietario")}</option><option value="supervisor">{text("Supervisor", "Supervisor")}</option></select></label>}
    {waiting && <label>{text("Waiting / blocked reason", "Motivo de espera / bloqueo")}<textarea aria-label={text("Waiting / blocked reason", "Motivo de espera / bloqueo")} rows={2} value={value.waitingReason ?? ""} onChange={e => onChange({ ...value, waitingReason: e.target.value })}/></label>}
  </div>;
}
