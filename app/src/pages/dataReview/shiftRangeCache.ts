import type { QueryClient } from "@tanstack/react-query";
import type { TimeShift } from "../../lib/timeclock";
const freshness=new WeakMap<object,number>();
/** Reuse only fresh, fully loaded snapshots with the exact same owner/job scope.
 * Stale windows are read authoritatively again, including deletions and moves. */
export async function readShiftRange(client:QueryClient,key:readonly unknown[],from:number,until:number,signal:AbortSignal,read:(from:number,until:number)=>Promise<TimeShift[]>) {
 if(!Number.isFinite(from)||!Number.isFinite(until))return read(from,until);
 const now=Date.now();const candidates=client.getQueryCache().findAll({queryKey:key.slice(0,3)}).filter(query=>query.queryKey.length===key.length&&JSON.stringify(query.queryKey[3])===JSON.stringify(key[3])&&query.state.data!==undefined&&!query.state.isInvalidated&&typeof query.queryKey[4]==="number"&&typeof query.queryKey[5]==="number"&&now-Math.min(query.state.dataUpdatedAt,freshness.get(query.state.data as object)??Infinity)<5*60000).map(query=>({from:Number(query.queryKey[4]),until:Number(query.queryKey[5]),rows:query.state.data as TimeShift[],at:Math.min(query.state.dataUpdatedAt,freshness.get(query.state.data as object)??Infinity)})).filter(window=>window.from<until&&window.until>from&&window.until>window.from);
 const spans=candidates.map(window=>[Math.max(from,window.from),Math.min(until,window.until)]).sort((a,b)=>a[0]-b[0]);
 const gaps:[number,number][]=[];let cursor=from;
 for(const [start,end] of spans){if(start>cursor)gaps.push([cursor,start]);cursor=Math.max(cursor,end);}if(cursor<until)gaps.push([cursor,until]);
 const rows=new Map<string,TimeShift>();
 for(const window of candidates.sort((a,b)=>a.at-b.at)){for(const [id,row] of rows){const time=Date.parse(row.clock_in_at);if(time>=window.from&&time<window.until)rows.delete(id);}for(const row of window.rows){const time=Date.parse(row.clock_in_at);if(time>=from&&time<until)rows.set(row.id,row);}}
 for(const [start,end] of gaps){signal.throwIfAborted();for(const row of await read(start,end))rows.set(row.id,row);}
 signal.throwIfAborted();const result=[...rows.values()];freshness.set(result,Math.min(now,...candidates.map(window=>window.at)));return result;
}
