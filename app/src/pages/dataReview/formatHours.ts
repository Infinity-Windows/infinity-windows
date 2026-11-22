/** Keep small-hour precision; large totals are comma-separated whole hours. */
export function formatHours(value:number,precision=2):string {
 return Math.abs(value)>=1000?value.toLocaleString("en-US",{maximumFractionDigits:0}):value.toFixed(precision);
}
