import { afterEach, describe, expect, it, vi } from "vitest";
import { pcmWav, speechAudio } from "./voiceAudio";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("speech-only audio normalization", () => {
  it("writes bounded mono PCM with the correct WAV header and clipped samples", async () => {
    const wav = pcmWav(new Float32Array([-2, 0, 2]), 16000), bytes = new DataView(await wav.arrayBuffer());
    expect(wav.type).toBe("audio/wav"); expect(wav.size).toBe(50);
    expect(bytes.getUint32(24,true)).toBe(16000); expect(bytes.getUint32(40,true)).toBe(6);
    expect(bytes.getInt16(44,true)).toBe(-32768); expect(bytes.getInt16(48,true)).toBe(32767);
  });
  it("keeps the original MP4 unchanged and creates a mono speech copy", async () => {
    const original=new Blob(["original AAC"],{type:"audio/mp4"});
    vi.stubGlobal("OfflineAudioContext", class { decodeAudioData(){return Promise.resolve({length:2,duration:2/16000,sampleRate:16000,numberOfChannels:2,getChannelData:(channel:number)=>new Float32Array(channel?[1,0]:[0,1])});} });
    const normalized=await speechAudio(original);
    expect(normalized.type).toBe("audio/wav"); expect(await original.text()).toBe("original AAC");
    expect(new DataView(await normalized.arrayBuffer()).getInt16(44,true)).toBe(16384);
  });
  it("does not re-encode working WebM recordings", async () => {
    const audio=new Blob(["opus"],{type:"audio/webm;codecs=opus"});expect(await speechAudio(audio)).toBe(audio);
  });
  it("bounds a stuck decoder without changing the original", async () => {
    vi.useFakeTimers();vi.stubGlobal("OfflineAudioContext",class{decodeAudioData(){return new Promise(()=>{});}});
    const result=speechAudio(new Blob(["aac"],{type:"audio/mp4"}));const rejected=expect(result).rejects.toThrow("audio_conversion_timeout");
    await vi.advanceTimersByTimeAsync(10000);await rejected;
  });
});
