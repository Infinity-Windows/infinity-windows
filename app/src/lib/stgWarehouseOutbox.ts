import { isNetworkError } from './offline/outbox-core';
import { sendWarehouseCommand, type WarehouseCommand } from './stgWarehouse';
import { signedInId } from './signedIn';
import { formatApiError } from './errors';
export interface PartnerQueuedCommand { command: WarehouseCommand; error?: string }
const key = (actor: string) => `stg-warehouse-outbox-v1:${actor}`;
export function readPartnerOutbox(actor: string): PartnerQueuedCommand[] {
  const raw = localStorage.getItem(key(actor));
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('Saved warehouse actions could not be read. Contact the office.');
  return parsed as PartnerQueuedCommand[];
}
function save(actor: string, rows: PartnerQueuedCommand[]) {
  localStorage.setItem(key(actor),JSON.stringify(rows));
  window.dispatchEvent(new Event('stg-warehouse-outbox'));
}
function currentActor() {
  const actor = signedInId();
  if (!actor) throw new Error('Your session expired. Please sign in again.');
  return actor;
}
export async function queuePartnerCommand(command: WarehouseCommand) {
  const actor = await currentActor();
  const rows = readPartnerOutbox(actor);
  if (!rows.some(r => r.command.id === command.id)) {
    if (rows.length >= 100) throw new Error('Send or review the saved warehouse actions before adding more.');
    // The server checks this identity again. A user switch between checking the
    // session and sending the request can never execute another login's queue.
    save(actor,[...rows,{command:{...command,input:{...command.input,actor}}}]);
  }
  return actor;
}
const running = new Map<string,Promise<number>>();
export function flushPartnerOutbox(actor: string): Promise<number> {
  const prior=running.get(actor);if(prior)return prior;
  const task=(async()=>{
    let sent=0;
    while(true){
      if(await currentActor()!==actor)return sent;
      const next=readPartnerOutbox(actor)[0];
      if(!next || next.error)return sent;
      try {
        await sendWarehouseCommand(next.command);
        save(actor,readPartnerOutbox(actor).filter(r=>r.command.id!==next.command.id));sent++;
      } catch(e) {
        if(isNetworkError(e))return sent;
        save(actor,readPartnerOutbox(actor).map(r=>r.command.id===next.command.id ? {...r,error:formatApiError(e)} : r));
        return sent;
      }
    }
  })().finally(()=>running.delete(actor));
  running.set(actor,task);return task;
}
export function retryPartnerCommand(actor:string,id:string) {
  save(actor,readPartnerOutbox(actor).map(r=>r.command.id===id?{command:r.command}:r));
}
export function dismissPartnerCommand(actor:string,id:string) {
  save(actor,readPartnerOutbox(actor).filter(r=>r.command.id!==id));
}
