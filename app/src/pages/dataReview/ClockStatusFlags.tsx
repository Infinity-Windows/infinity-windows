import {CircleAlert} from "lucide-react";
export function ClockStatusFlags({unresolved}:{running:number;unresolved:number}) {
 if(unresolved<=0)return null;
 return <small className="clock-status-flags">{unresolved>0&&<span title={`${unresolved} unresolved clock records`} aria-label={`${unresolved} unresolved clock records`}>{unresolved} <CircleAlert size={12} aria-hidden="true"/></span>}</small>;
}
