import {describe,it,expect} from "vitest";
import {appendDictation} from "./dictation";
import {dictationExtension,readDictationBody,DICTATION_MAX_BYTES} from "../../../supabase/functions/_shared/dictation";
describe("spoken description input",()=>{
  it("preserves typed text and adds a paragraph",()=>expect(appendDictation("Keep this."," New words. ",true)).toBe("Keep this.\nNew words."));
  it("does not add another separator after existing whitespace",()=>expect(appendDictation("Keep this.\n","More.",true)).toBe("Keep this.\nMore."));
  it("keeps single-line fields single-line",()=>expect(appendDictation("First","Second\nline",false)).toBe("First Second line"));
  it("never silently truncates a transcript",()=>expect(appendDictation("Existing","New words",true,10)).toBeNull());
  it("accepts mobile recording codecs but refuses non-audio",()=>{expect(dictationExtension("audio/webm;codecs=opus")).toBe("webm");expect(dictationExtension("audio/mp4")).toBe("mp4");expect(dictationExtension("text/html")).toBeNull();});
  it("limits bytes even without a content length",async()=>{
    const req=new Request("https://example.invalid",{method:"POST",body:new Uint8Array(DICTATION_MAX_BYTES+16385)});
    await expect(readDictationBody(req)).rejects.toThrow("audio_too_large");
  });
});
