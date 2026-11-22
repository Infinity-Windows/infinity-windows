/** Display only; source labels and identity remain unchanged. */
export function unitDisplay(value:string|null|undefined){
 const label=value?.trim();
 if(!label||/^unknown(?:\b|$)/i.test(label))return "--";
 return /^conflicting(?:\b|$)/i.test(label)?"Conflict":label;
}
