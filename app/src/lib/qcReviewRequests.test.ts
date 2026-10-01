import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./supabase",()=>({supabase:{}}));
import { runQcOwnedRequest } from "./qcReviewRequests";
import { rememberSignedIn } from "./signedIn";
const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
afterEach(()=>rememberSignedIn(null));
const signIn=(id:string)=>rememberSignedIn({user:{id}});
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}

describe("QC request sign-in ownership",()=>{
  it("does not call a transport for the wrong or already ended owner",async()=>{
    signIn(B); const send=vi.fn();
    await expect(runQcOwnedRequest(A,new AbortController().signal,send)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it("aborts during token resolution before a request could dispatch as the next account",async()=>{
    signIn(A);const token=deferred<void>();const dispatched=vi.fn();
    const result=runQcOwnedRequest(A,new AbortController().signal,async signal=>{
      await token.promise;signal.throwIfAborted();dispatched();return "saved";
    });
    signIn(B);token.resolve();
    await expect(result).rejects.toThrow();expect(dispatched).not.toHaveBeenCalled();
  });
  it("discards a late completion even if a transport ignores abort",async()=>{
    signIn(A);const reply=deferred<string>();let signal!:AbortSignal;
    const result=runQcOwnedRequest(A,new AbortController().signal,s=>{signal=s;return reply.promise;});
    signIn(B);expect(signal.aborted).toBe(true);reply.resolve("saved");
    await expect(result).rejects.toThrow();
  });
  it("rejects an old sign-in after A signs out and back in",async()=>{
    signIn(A);const reply=deferred<string>();
    const result=runQcOwnedRequest(A,new AbortController().signal,()=>reply.promise);
    rememberSignedIn(null);signIn(A);reply.resolve("saved");
    await expect(result).rejects.toThrow();
  });
  it("aborts on component unmount or query cancellation, without changing shared clients",async()=>{
    for(const source of ["lifetime","query"]) {
      signIn(A);const lifetime=new AbortController(),query=new AbortController(),reply=deferred<string>();
      let signal!:AbortSignal;
      const result=runQcOwnedRequest(A,lifetime.signal,s=>{signal=s;return reply.promise;},query.signal);
      (source==="lifetime"?lifetime:query).abort();expect(signal.aborted).toBe(true);
      reply.resolve("read");await expect(result).rejects.toThrow();
    }
  });
  it("accepts current-owner success and removes its auth subscription",async()=>{
    signIn(A);let signal!:AbortSignal;
    expect(await runQcOwnedRequest(A,new AbortController().signal,async s=>{signal=s;return "saved";})).toBe("saved");
    signIn(B);expect(signal.aborted).toBe(false);
  });
});
