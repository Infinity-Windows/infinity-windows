import { Children, useState, type ReactNode } from "react";

// Limits rendered rows only. Totals and selection continue to use the full data set.
export function TablePage({children, columns=1, bodies=false, limit:controlledLimit, onMore}: {children:ReactNode;columns?:number;bodies?:boolean;limit?:number;onMore?:()=>void}) {
 const rows=Children.toArray(children);
 const [localLimit,setLimit]=useState(15);
 const limit=controlledLimit??localLimit;
 const more=limit<rows.length?<tr className="report-show-more"><td colSpan={columns}><button type="button" onClick={onMore??(()=>setLimit(n=>n+15))}>Show more</button></td></tr>:null;
 return <>{rows.slice(0,limit)}{more&&(bodies?<tbody>{more}</tbody>:more)}</>;
}
export function ListPage({children}: {children:ReactNode}) {
 const rows=Children.toArray(children);const [limit,setLimit]=useState(15);
 return <>{rows.slice(0,limit)}{limit<rows.length&&<div className="report-show-more"><button type="button" onClick={()=>setLimit(n=>n+15)}>Show more</button></div>}</>;
}
