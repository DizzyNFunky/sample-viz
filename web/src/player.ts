/** WebAudio playback of the current (preview) audio with a sample-accurate playhead. */

export class Player {
  private ctx: AudioContext | null = null;
  private src: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;
  private bufferKey: string | null = null;
  private startedAt = 0;
  private from = 0;
  private to = 0;
  private loop = false;
  private sr = 48000;
  onEnded: (() => void) | null = null;

  get playing() {
    return this.src !== null;
  }

  private context(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext({ latencyHint: "interactive" });
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  private getBuffer(channels: Float32Array[], sampleRate: number, key: string): AudioBuffer {
    if (this.buffer && this.bufferKey === key) return this.buffer;
    const ctx = this.context();
    const len = Math.max(1, channels[0]?.length ?? 1);
    const buf = ctx.createBuffer(channels.length, len, sampleRate);
    channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    this.buffer = buf;
    this.bufferKey = key;
    return buf;
  }

  /** Play [from, to) samples; loops that range when `loop` is set. */
  play(channels: Float32Array[], sampleRate: number, key: string, from: number, to: number, loop: boolean) {
    this.stop();
    const ctx = this.context();
    const buf = this.getBuffer(channels, sampleRate, key);
    to = Math.min(to, buf.length);
    from = Math.max(0, Math.min(from, to - 1));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    this.sr = sampleRate;
    this.from = from;
    this.to = to;
    this.loop = loop;
    if (loop) {
      src.loop = true;
      src.loopStart = from / sampleRate;
      src.loopEnd = to / sampleRate;
      src.start(0, from / sampleRate);
    } else {
      src.start(0, from / sampleRate, (to - from) / sampleRate);
    }
    src.onended = () => {
      if (this.src === src) {
        this.src = null;
        this.onEnded?.();
      }
    };
    this.startedAt = ctx.currentTime;
    this.src = src;
  }

  stop() {
    const src = this.src;
    this.src = null;
    if (src) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      src.disconnect();
    }
  }

  /** Current playhead in samples, or null when stopped. */
  position(): number | null {
    if (!this.src || !this.ctx) return null;
    const elapsed = (this.ctx.currentTime - this.startedAt) * this.sr;
    if (this.loop) return this.from + (elapsed % Math.max(1, this.to - this.from));
    return Math.min(this.from + elapsed, this.to);
  }
}
