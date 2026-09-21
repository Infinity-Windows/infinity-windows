import type { Page } from "@playwright/test";

// Real browser encoder, with an explicitly synthetic source. Never touches a microphone.
export async function useSyntheticMicrophone(page: Page) {
  await page.addInitScript(() => {
    let bytes = 0;
    Object.defineProperty(window, "syntheticAudioBytes", {get: () => bytes});
    const Native = MediaRecorder;
    Object.defineProperty(window, "MediaRecorder", { value: class extends Native {
      constructor(stream: MediaStream, options?: MediaRecorderOptions) { super(stream, options);
        this.addEventListener("dataavailable", e => { bytes += e.data.size; });
      }
    } });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: async () => {
        const context = new AudioContext(); await context.resume();
        const source = context.createOscillator(), gain = context.createGain(), destination = context.createMediaStreamDestination();
        gain.gain.value = 0.05; source.connect(gain); gain.connect(destination); source.start();
        for (const track of destination.stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => { stop(); source.stop(); void context.close(); };
        }
        return destination.stream;
      },
    } });
  });
}
