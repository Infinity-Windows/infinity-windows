import { describe, expect, it } from "vitest";
import { applyFailure, deserializeEntry, serializeEntry, type OutboxEntry } from "./outbox-core";
import { recoverPhotoUpload } from "./recoverPhotoUploads";
import { MemoryOutboxStore } from "./outboxStore";

const EMAIL = "worker@example.test";
const failure = {code:"42P10",message:"there is no unique or exclusion constraint matching the ON CONFLICT specification"};
function failed(): OutboxEntry {
  return applyFailure({id:"stable-photo-id",op:"photo_upload",payload:{createdBy:EMAIL,projectId:"job",path:"original.jpg"},createdAt:1,attemptCount:0,lastError:null,status:"queued",nextAttemptAt:0,hasBlob:true},failure,10);
}
describe("recovery after the attachment index repair",()=>{
  it("revives the actual permanent database failure, preserving the original file and retry key",async()=>{
    const before=failed();expect(before.status).toBe("failed");
    const store=new MemoryOutboxStore();const blob=new Blob(["original-photo"]);
    await store.put(before,blob);
    const recovered=recoverPhotoUpload(before,EMAIL,20);
    await store.put(recovered);
    expect(recovered).toMatchObject({id:before.id,createdAt:1,status:"queued",attemptCount:0,lastError:null,nextAttemptAt:20,payload:{path:"original.jpg",createdBy:EMAIL}});
    expect(await (await store.getBlob(before.id))?.text()).toBe("original-photo");
  });
  it("does not automatically revive another account's files or entries with unknown authors",()=>{
    const before=failed();
    expect(recoverPhotoUpload(before,"someone-else@example.test",20)).toBe(before);
    expect(recoverPhotoUpload(before,null,20)).toBe(before);
    const unknown={...before,payload:{...before.payload,createdBy:null}};
    expect(recoverPhotoUpload(unknown,EMAIL,20)).toBe(unknown);
  });
  it("does not revive payroll, unrelated errors, or an upload without its file",()=>{
    const before=failed();
    for(const e of [{...before,op:"clock_in" as const},{...before,lastError:"row-level security policy denied"},{...before,hasBlob:false}]){
      expect(recoverPhotoUpload(e,EMAIL,20)).toBe(e);
    }
  });
  it("persists a one-time repair marker so a repeated server error cannot loop",()=>{
    const repaired=recoverPhotoUpload(failed(),EMAIL,20);
    const failedAgain=deserializeEntry(serializeEntry(applyFailure(repaired,failure,30)))!;
    expect(recoverPhotoUpload(failedAgain,EMAIL,40)).toBe(failedAgain);
  });
});
