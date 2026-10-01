// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearQcSubmittedCommand, persistQcSubmittedCommand, readQcSubmittedCommand,
  validateQcSubmittedCommand, type QcSubmittedCommand } from "./qcReviewRecovery";

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const command: QcSubmittedCommand = { decisionId:"11111111-1111-4111-8111-111111111111",
  projectId:"22222222-2222-4222-8222-222222222222", openingId:"33333333-3333-4333-8333-333333333333",
  status:"callback", note:"Check the sill", expectedReviewVersion:"none", term:"sealant" };
const key=(viewer:string)=>`qcReview:submitted:v1:${viewer}`;
beforeEach(()=>{
  const values=new Map<string,string>();
  vi.stubGlobal("window", { sessionStorage: {
    getItem: (key:string)=>values.get(key) ?? null,
    setItem: (key:string,value:string)=>{values.set(key,value);},
    removeItem: (key:string)=>{values.delete(key);},
    clear: ()=>values.clear(),
    get length(){return values.size;},
  }});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

describe("submitted QC command recovery",()=>{
  it("restores exactly the original request after remount, isolated by the real viewer",()=>{
    expect(persistQcSubmittedCommand(A,command)).toBe(true);
    expect(readQcSubmittedCommand(B)).toEqual({kind:"empty"});
    expect(readQcSubmittedCommand(A)).toEqual({kind:"command",command});
    const restored=readQcSubmittedCommand(A);
    if(restored.kind!=="command") throw new Error("missing command");
    expect(persistQcSubmittedCommand(A,restored.command)).toBe(true);
    expect(restored.command.decisionId).toBe(command.decisionId);
  });
  it("cannot replace an unresolved request with a changed identity or payload",()=>{
    expect(persistQcSubmittedCommand(A,command)).toBe(true);
    for(const change of [{decisionId:B},{projectId:B},{openingId:B},{status:"passed",term:""},
      {note:"Other note"},{expectedReviewVersion:B},{term:"other-term"}]) {
      expect(persistQcSubmittedCommand(A,{...command,...change} as QcSubmittedCommand)).toBe(false);
      expect(readQcSubmittedCommand(A)).toEqual({kind:"command",command});
    }
  });
  it("binds fields rather than object property order",()=>{
    expect(persistQcSubmittedCommand(A,command)).toBe(true);
    const {term,...rest}=command;
    expect(persistQcSubmittedCommand(A,{term,...rest})).toBe(true);
  });
  it("clears only the matching command after an explicit receipt or definite refusal",()=>{
    persistQcSubmittedCommand(A,command); persistQcSubmittedCommand(B,command);
    expect(clearQcSubmittedCommand(A,B)).toBe(false);
    expect(clearQcSubmittedCommand(A,command.decisionId)).toBe(true);
    expect(readQcSubmittedCommand(A)).toEqual({kind:"empty"});
    expect(readQcSubmittedCommand(B)).toEqual({kind:"command",command});
  });
  it("rejects wrong-owner envelopes even when copied under another user's key",()=>{
    persistQcSubmittedCommand(A,command);
    window.sessionStorage.setItem(key(B),window.sessionStorage.getItem(key(A))!);
    expect(readQcSubmittedCommand(B)).toEqual({kind:"invalid"});
    expect(persistQcSubmittedCommand(B,command)).toBe(false);
  });
  it("rejects malformed IDs, state tokens, unnormalized/oversized notes and unknown payload fields",()=>{
    for(const change of [{decisionId:"bad"},{projectId:null},{openingId:""},{status:"pending"},
      {expectedReviewVersion:"v1"},{note:" x "},{note:"x".repeat(4001)},{note:"a\0b"},
      {term:"x".repeat(201)},{status:"passed",term:"sealant"},{photoUrl:"https://private.example/signed"}]) {
      expect(validateQcSubmittedCommand({...command,...change})).toBeNull();
    }
    expect(validateQcSubmittedCommand({...command,note:"x".repeat(4000)})).not.toBeNull();
    expect(validateQcSubmittedCommand({...command,expectedReviewVersion:B})).not.toBeNull();
  });
  it("never stores unit facts, evidence, AI output or an unsubmitted draft",()=>{
    expect(persistQcSubmittedCommand(A,{...command,assignedWindowId:B} as QcSubmittedCommand)).toBe(false);
    expect(window.sessionStorage.length).toBe(0);
    persistQcSubmittedCommand(A,command);
    expect(Object.keys(JSON.parse(window.sessionStorage.getItem(key(A))!).command).sort())
      .toEqual(["decisionId","projectId","openingId","status","note","expectedReviewVersion","term"].sort());
  });
  it("fails before a send can be authorized when storage is unavailable or drops writes",()=>{
    const spy=vi.spyOn(window.sessionStorage,"setItem").mockImplementation(()=>{throw new Error("blocked");});
    expect(persistQcSubmittedCommand(A,command)).toBe(false);
    spy.mockImplementation(()=>{});
    expect(persistQcSubmittedCommand(A,command)).toBe(false);
  });
  it("distinguishes corrupt data from unavailable storage and never replaces either",()=>{
    window.sessionStorage.setItem(key(A),"{bad json");
    expect(readQcSubmittedCommand(A)).toEqual({kind:"invalid"});
    expect(persistQcSubmittedCommand(A,command)).toBe(false);
    vi.spyOn(window.sessionStorage,"getItem").mockImplementation(()=>{throw new Error("blocked");});
    expect(readQcSubmittedCommand(A)).toEqual({kind:"unavailable"});
    expect(persistQcSubmittedCommand(A,command)).toBe(false);
  });
  it("keeps a maximum-length escaped note recoverable",()=>{
    const escaped={...command,note:"\u0001".repeat(4000)};
    expect(persistQcSubmittedCommand(A,escaped)).toBe(true);
    expect(readQcSubmittedCommand(A)).toEqual({kind:"command",command:escaped});
  });
});
