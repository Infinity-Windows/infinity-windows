import {it,expect,vi} from "vitest";
import {QueryClient} from "@tanstack/react-query";
import type {TimeShift} from "../../lib/timeclock";
import {readShiftRange} from "./shiftRangeCache";
it("loads just uncovered dates, reuses complete empty intervals, and isolates sessions",async()=>{
 const client=new QueryClient();const key=["dataReview","owner:1","clockedShifts",["j"],100,200];
 client.setQueryData(key,[{id:"a",clock_in_at:new Date(150).toISOString()}] as TimeShift[]);
 const read=vi.fn(async(_from:number,_until:number)=>[] as TimeShift[]);const signal=new AbortController().signal;
 const result=await readShiftRange(client,[...key.slice(0,4),50,250],50,250,signal,read);
 expect(read.mock.calls.map(args=>args)).toEqual([[50,100],[200,250]]);expect(result).toHaveLength(1);
 read.mockClear();await readShiftRange(client,[...key.slice(0,4),120,180],120,180,signal,read);expect(read).not.toHaveBeenCalled();
 await readShiftRange(client,["dataReview","owner:2",...key.slice(2)],100,200,signal,read);expect(read).toHaveBeenCalledWith(100,200);
 client.clear();
});

it("does not reuse stale or invalidated snapshots",async()=>{
 const client=new QueryClient();const key=["dataReview","owner:1","clockedShifts",["j"],100,200];
 client.setQueryData(key,[],{updatedAt:Date.now()-6*60000});
 const read=vi.fn(async(_from:number,_until:number)=>[] as TimeShift[]);
 await readShiftRange(client,key,100,200,new AbortController().signal,read);expect(read).toHaveBeenCalledWith(100,200);
 client.setQueryData(key,[]);await client.invalidateQueries({queryKey:key});read.mockClear();
 await readShiftRange(client,key,100,200,new AbortController().signal,read);expect(read).toHaveBeenCalledWith(100,200);client.clear();
});

it("newer empty coverage removes older records rather than resurrecting them",async()=>{
 const client=new QueryClient(),prefix=["dataReview","owner:1","clockedShifts",["j"]];
 client.setQueryData([...prefix,100,200],[{id:"removed",clock_in_at:new Date(150).toISOString()}],{updatedAt:Date.now()-1000});
 client.setQueryData([...prefix,100,250],[],{updatedAt:Date.now()});
 const read=vi.fn(async()=>[] as TimeShift[]);
 expect(await readShiftRange(client,[...prefix,120,180],120,180,new AbortController().signal,read)).toEqual([]);expect(read).not.toHaveBeenCalled();client.clear();
});
