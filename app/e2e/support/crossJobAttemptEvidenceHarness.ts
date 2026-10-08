/** Isolated fixture only. No app consumer, actual session or provider. */
import * as storage from '../../src/lib/workCapture/crossJobStorageV4';
import * as legacy from '../../src/lib/workCapture/crossJobStorageV3';
import * as values from '../../src/lib/workCapture/crossJobStorageV3.fixtures';
import * as api from '../../src/lib/workActivity/apiV3';
import * as auth from '../../src/lib/signedIn';
import {predictAllocation} from '../../src/lib/workActivity/allocationPredecessor';
export {seedLegacy,census,complete,get,diagnostics} from './crossJobStorageV3Harness';
export {storage,legacy,values,api,auth,predictAllocation};
let current=values.fences();
export const context=()=>({expected:values.fences(),current:()=>current});
export const setContext=(patch:Partial<typeof current>)=>{current={...current,...patch};};
export const open=()=>storage.openCrossJobJournalV4(indexedDB);
export const admission=(o=values.genesis())=>({snapshot:o.anchor,elapsedMs:0,serverNow:o.anchor.asOf});
export const login=()=>{auth.rememberSignedIn({user:{id:values.id(99)}});auth.rememberSignedIn({user:{id:values.id(1)}});};
