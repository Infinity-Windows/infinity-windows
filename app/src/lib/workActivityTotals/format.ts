import type { TotalsCohort, TotalsQuantity, TotalsView } from "./protocol";
/** Presentation only: the original SQL quantities remain exact and unchanged. */
export function durationMicros(value: string): string {
 const micros=BigInt(value);const negative=micros<0n;const seconds=(negative?-micros:micros)/1000000n;
 return `${negative?"−":""}${seconds/3600n}:${String(seconds%3600n/60n).padStart(2,"0")}:${String(seconds%60n).padStart(2,"0")}`;
}
export function quantitySeconds(value: TotalsQuantity, liveElapsedMicros=0n): number|null {
 if(value.state!=="known"||value.microseconds===null)return null;
 const seconds=(BigInt(value.microseconds)+liveElapsedMicros)/1000000n;
 return seconds<=BigInt(Number.MAX_SAFE_INTEGER)?Number(seconds):null;
}
function fixed(numerator:bigint,denominator:bigint,places:number):string{
 if(numerator<0n||denominator<=0n)throw Error("Invalid area ratio");const scale=10n**BigInt(places);
 const rounded=(numerator*scale*2n+denominator)/(denominator*2n);
 return `${rounded/scale}.${String(rounded%scale).padStart(places,"0")}`;
}
export function trustedUnitRate(cohort: TotalsCohort):{squareFeet:string;hoursPer100SquareFeet:string}|null{
 if(cohort.availability!=="available"||!cohort.eligible)return null;
 const [whole,fraction=""]=cohort.areaSquareFeetNumerator.split(".");
 const areaNumerator=BigInt(whole+fraction),areaDenominator=BigInt(cohort.areaSquareFeetDenominator)*10n**BigInt(fraction.length);
 return {squareFeet:fixed(areaNumerator,areaDenominator,2),hoursPer100SquareFeet:fixed(BigInt(cohort.laborNumeratorMicros)*areaDenominator*100n,areaNumerator*3600000000n,2)};
}

export function choiceTotals(view:TotalsView|null,versionId:string,liveElapsedMicros:bigint){
 const row=view?.activities.find(a=>a.definitionVersionId===versionId);
 if(!row)return {personalSeconds:null,scopeTotalSeconds:null};
 const delta=row.personal.includesLive?liveElapsedMicros:0n;
 return {personalSeconds:quantitySeconds(row.personal,delta),scopeTotalSeconds:quantitySeconds(row.scopeTotal,delta)};
}
export function scopeTotalSeconds(view:TotalsView|null,liveElapsedMicros:bigint):number|null{
 if(!view?.complete)return null;
 const hasLive=view.activities.some(a=>a.personal.includesLive);
 return quantitySeconds({state:"known",microseconds:view.scopeKnownMicros,knownMicros:view.scopeKnownMicros},hasLive?liveElapsedMicros:0n);
}
export function personalScopeSeconds(view:TotalsView|null,liveElapsedMicros:bigint):number|null{
 if(!view?.personalComplete)return null;
 const hasLive=view.activities.some(a=>a.personal.includesLive);
 return quantitySeconds({state:"known",microseconds:view.personalKnownMicros,knownMicros:view.personalKnownMicros},hasLive?liveElapsedMicros:0n);
}
