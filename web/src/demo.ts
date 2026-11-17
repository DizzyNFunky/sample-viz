/**
 * A synthetic example sound so the editor can be tried without a file:
 * a log sine sweep, a steady 1 kHz tone, a noise burst and a decaying 3 kHz ping.
 * Each element is easy to find and edit on the spectrogram.
 */
import { DecodedAudio } from "./wav";

export function demoSound(sampleRate = 48000, seconds = 3): DecodedAudio {
  const n = Math.round(sampleRate * seconds);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const f0 = 100;
  const ratio = 80; // sweep 100 Hz -> 8 kHz
  const k = Math.log(ratio) / seconds;
  let seed = 1;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32 - 0.5;
  };
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const sweepPhase = ((2 * Math.PI * f0) / k) * (Math.exp(k * t) - 1);
    let v = 0.35 * Math.sin(sweepPhase) + 0.2 * Math.sin(2 * Math.PI * 1000 * t);
    if (t > 1.2 && t < 1.5) v += 0.6 * rand();
    if (t > 2.2) v += 0.25 * Math.sin(2 * Math.PI * 3000 * t) * Math.exp(-(t - 2.2) * 4);
    // short fades so the edges don't click
    const edge = Math.min(1, t / 0.01, (seconds - t) / 0.01);
    left[i] = v * edge;
    right[i] = v * edge * 0.85;
  }
  return { sampleRate, channels: [left, right], format: { kind: "pcm", bits: 24 } };
}
