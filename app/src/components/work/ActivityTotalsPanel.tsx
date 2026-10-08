import "./ActivityTotalsPanel.css";
import { useLanguage } from "../../lib/i18n";
import { durationMicros, trustedUnitRate } from "../../lib/workActivityTotals/format";
import type { useActivityTotals } from "../../lib/workActivityTotals/useActivityTotals";
const exclusionLabels:Record<string,{en:string;es:string}>={
 coverage_incomplete:{en:"Recorded activity coverage is incomplete",es:"La cobertura de actividad está incompleta"},
 unclassified_coverage:{en:"Some paid time is unclassified",es:"Hay tiempo pagado sin clasificar"},
 payroll_not_trusted:{en:"Payroll needs approval or policy reconciliation",es:"La nómina requiere aprobación o conciliación de la política"},
 dimensions_unverified:{en:"Dimensions have not been independently verified",es:"Las dimensiones no se han verificado de forma independiente"},
 qc_not_current_accepted:{en:"Current final QC is not accepted",es:"No se ha aceptado el control de calidad final actual"},
 active_or_rework:{en:"Work is active, pending or reopened",es:"El trabajo está activo, pendiente o reabierto"},
 no_attributed_labor:{en:"No eligible recorded unit labor",es:"No hay mano de obra registrada elegible de la unidad"},
 area_unknown:{en:"Verified area is unknown",es:"Se desconoce el área verificada"}
};
const machineLabels:Record<string,{en:string;es:string}>={forklift:{en:"Forklift",es:"Montacargas"},scissor_lift:{en:"Scissor lift",es:"Plataforma de tijera"},tele_handler:{en:"Telehandler",es:"Manipulador telescópico"},boom_lift:{en:"Boom lift",es:"Plataforma de brazo"},spider_suction:{en:"Spider suction cup machine",es:"Máquina de ventosas Spider"}};
const copy={
 en:{title:"Recorded activity totals",window:"All retained work for this selection",check:"Check totals",loading:"Checking current totals…",unavailable:"Totals are unavailable. Check the current records.",partial:"Partial — known subtotal",you:"You",scope:"Authorized scope",retired:"Retired activity",machines:"Machine time is included in activity time.",live:"Live display estimate since the last check; refresh confirms changes.",personalPayroll:"Your payroll reconciliation",scopePayroll:"Authorized payroll reconciliation",gross:"Gross clock time",paid:"Paid time",classified:"Classified activity",setup:"Start-of-day setup",gap:"Unclassified time",breaks:"Placed break time",deduction:"Payroll break deduction",adjustment:"Break policy adjustment",unknown:"Unknown",issues:"Records need reconciliation",trusted:"Verified unit rate",rate:"hours per100 sq ft",area:"sq ft",single:"This selected unit only. Labor and area use the same eligible unit.",excluded:"Excluded labor",unallocated:"Floor area is unallocated; general overhead is excluded.",noRate:"A trusted unit rate is unavailable for this selection.",notBid:"This describes recorded work and is not a bid guarantee."},
 es:{title:"Totales de actividad registrados",window:"Todo el trabajo conservado de esta selección",check:"Revisar totales",loading:"Revisando los totales actuales…",unavailable:"Los totales no están disponibles. Revisa los registros actuales.",partial:"Parcial — subtotal conocido",you:"Tú",scope:"Ámbito autorizado",retired:"Actividad retirada",machines:"El tiempo de máquina ya está incluido en la actividad.",live:"Estimación en vivo desde la última revisión; actualizar confirma los cambios.",personalPayroll:"Tu conciliación de nómina",scopePayroll:"Conciliación de nómina autorizada",gross:"Tiempo bruto del reloj",paid:"Tiempo pagado",classified:"Actividad clasificada",setup:"Preparación del inicio del día",gap:"Tiempo sin clasificar",breaks:"Tiempo de descanso registrado",deduction:"Descuento de descanso en nómina",adjustment:"Ajuste de la política de descansos",unknown:"Desconocido",issues:"Los registros necesitan conciliación",trusted:"Ritmo verificado de unidad",rate:"horas por100 pies cuadrados",area:"pies cuadrados",single:"Solo esta unidad. La mano de obra y el área usan la misma unidad elegible.",excluded:"Mano de obra excluida",unallocated:"El área por piso no está asignada; se excluye el trabajo general.",noRate:"No hay un ritmo confiable para esta selección.",notBid:"Describe trabajo registrado; no garantiza una cotización."}
} as const;
interface Props {totals:ReturnType<typeof useActivityTotals>;onRefresh:()=>Promise<void>;}
export function ActivityTotalsPanel({totals,onRefresh}:Props){
 const {lang}=useLanguage();const t=copy[lang==="es"?"es":"en"],view=totals.data;
 const check=()=>{void Promise.resolve().then(onRefresh).then(()=>totals.refresh()).catch(()=>{/* Failed read keeps existing lifetime held. */});};
 if(!view)return <section className="ws-card" aria-label={t.title}><h2 className="ws-h2">{t.title}</h2><p role="status">{totals.state==="loading"?t.loading:t.unavailable}</p><button className="ws-btn" type="button" onClick={check}>{t.check}</button></section>;
 const r=view.reconciliation,rate=trustedUnitRate(view.cohort);
 return <section className="ws-card activity-totals-panel" aria-label={t.title}>
  <h2 className="ws-h2">{t.title}</h2><p className="ws-meta">{t.window} · <time dateTime={view.asOf}>{new Date(view.asOf).toLocaleString(lang==="es"?"es":"en")}</time></p>
  <button className="ws-btn" type="button" onClick={check}>{t.check}</button>
  {!view.complete&&<p role="status">{t.partial}: {durationMicros(view.scopeKnownMicros)}</p>}
  <dl>{view.activities.map(row=><div key={row.definitionVersionId}>
   <dt>{lang==="es"?row.labelEs:row.labelEn}{row.retired&&` · ${t.retired}`}</dt>
   <dd>{t.you}: {row.personal.state==="partial"?`${t.partial}: `:""}{durationMicros(row.personal.knownMicros)} · {t.scope}: {row.scopeTotal.state==="partial"?`${t.partial}: `:""}{durationMicros(row.scopeTotal.knownMicros)}</dd>
   {row.machineSubsets.map(machine=><dd key={machine.machineKind}>{machineLabels[machine.machineKind]?.[lang==="es"?"es":"en"]??(lang==="es"?"Tiempo de máquina":"Machine time")}: {durationMicros(machine.microseconds)}</dd>)}
  </div>)}</dl>
  {view.activities.some(row=>row.machineSubsets.length>0)&&<p className="ws-meta">{t.machines}</p>}
  {view.activities.some(row=>row.personal.includesLive)&&<p className="ws-meta">{t.live}</p>}
  <h3 className="ws-h2">{r.scope==="personal"?t.personalPayroll:t.scopePayroll}</h3>
  <p className="ws-meta">{lang==="es"?"La conciliación abarca los turnos relacionados":"Reconciliation covers the related shifts"}</p>
  <dl>{[[t.gross,r.grossMicros],[t.paid,r.payrollMicros],[t.classified,r.classifiedMicros],[t.setup,r.setupMicros],[t.gap,r.unclassifiedMicros],[t.breaks,r.breakElapsedMicros],[t.deduction,r.breakDeductionMicros],[t.adjustment,r.policyAdjustmentMicros]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value===null?t.unknown:`${r.unresolvedScope?t.partial+": ":""}${durationMicros(value)}`}</dd></div>)}</dl>
  {(r.unresolvedScope||r.issues.some(issue=>issue!=="own_live_provisional"))&&<p role="status">{t.issues}</p>}
  <h3 className="ws-h2">{t.trusted}</h3>
  {rate?<><p>{rate.hoursPer100SquareFeet} {t.rate} · {rate.squareFeet} {t.area}</p><p className="ws-meta">{t.single}</p></>:<p>{t.noRate}</p>}
  {view.cohort.availability==="available"&&!view.cohort.eligible&&<><p>{t.excluded}: {durationMicros(view.cohort.excludedLaborMicros)}</p><ul>{view.cohort.exclusions.map(reason=><li key={reason}>{exclusionLabels[reason]?.[lang==="es"?"es":"en"]??t.issues}</li>)}</ul></>}
  <p className="ws-meta">{t.unallocated} {t.notBid}</p>
 </section>;
}
