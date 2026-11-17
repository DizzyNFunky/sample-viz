/** WAV decode/encode that preserves the original sample rate and bit depth. */

export type SampleFormat = { kind: "pcm"; bits: 8 | 16 | 24 | 32 } | { kind: "float"; bits: 32 | 64 };

export interface DecodedAudio {
  sampleRate: number;
  channels: Float32Array[];
  format: SampleFormat;
}

export function decodeWav(buf: ArrayBuffer): DecodedAudio | null {
  const dv = new DataView(buf);
  if (buf.byteLength < 12) return null;
  const tag = (o: number) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;

  let fmt: { tag: number; channels: number; rate: number; bits: number; align: number } | null = null;
  let dataOff = -1;
  let dataLen = 0;
  let o = 12;
  while (o + 8 <= buf.byteLength) {
    const id = tag(o);
    const size = dv.getUint32(o + 4, true);
    const body = o + 8;
    if (id === "fmt ") {
      let fmtTag = dv.getUint16(body, true);
      if (fmtTag === 0xfffe && size >= 26) fmtTag = dv.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE
      fmt = {
        tag: fmtTag,
        channels: dv.getUint16(body + 2, true),
        rate: dv.getUint32(body + 4, true),
        align: dv.getUint16(body + 12, true),
        bits: dv.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      dataOff = body;
      dataLen = Math.min(size, buf.byteLength - body);
      if (fmt) break;
    }
    o = body + size + (size & 1);
  }
  if (!fmt || dataOff < 0) throw new Error("WAV is missing fmt or data chunk");

  const isFloat = fmt.tag === 3;
  if (fmt.tag !== 1 && !isFloat) throw new Error(`unsupported WAV encoding (format tag ${fmt.tag})`);
  const bytes = fmt.bits / 8;
  const nch = fmt.channels;
  const align = fmt.align || bytes * nch;
  const frames = Math.floor(dataLen / align);
  const channels = Array.from({ length: nch }, () => new Float32Array(frames));

  for (let i = 0; i < frames; i++) {
    let p = dataOff + i * align;
    for (let c = 0; c < nch; c++, p += bytes) {
      let v: number;
      if (isFloat) v = bytes === 4 ? dv.getFloat32(p, true) : dv.getFloat64(p, true);
      else if (bytes === 1) v = (dv.getUint8(p) - 128) / 128;
      else if (bytes === 2) v = dv.getInt16(p, true) / 32768;
      else if (bytes === 3) v = ((dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getInt8(p + 2) << 16)) / 8388608);
      else v = dv.getInt32(p, true) / 2147483648;
      channels[c][i] = v;
    }
  }
  const format: SampleFormat = isFloat
    ? { kind: "float", bits: fmt.bits === 64 ? 64 : 32 }
    : { kind: "pcm", bits: fmt.bits as 8 | 16 | 24 | 32 };
  return { sampleRate: fmt.rate, channels, format };
}

/** Decode WAV natively (exact rate/depth); fall back to the browser decoder for other formats. */
export async function decodeAudio(buf: ArrayBuffer): Promise<DecodedAudio> {
  const wav = decodeWav(buf);
  if (wav) return wav;
  const ctx = new OfflineAudioContext(1, 1, 48000);
  const ab = await ctx.decodeAudioData(buf.slice(0));
  return {
    sampleRate: ab.sampleRate,
    channels: Array.from({ length: ab.numberOfChannels }, (_, i) => ab.getChannelData(i).slice()),
    format: { kind: "pcm", bits: 24 },
  };
}

export function encodeWav(channels: Float32Array[], sampleRate: number, format: SampleFormat): Blob {
  const nch = channels.length;
  const frames = channels[0]?.length ?? 0;
  const isFloat = format.kind === "float";
  const bits = format.bits;
  const bytes = bits / 8;
  const align = nch * bytes;
  const dataLen = frames * align;
  const buf = new ArrayBuffer(44 + dataLen + (dataLen & 1));
  const dv = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((ch, i) => dv.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  dv.setUint32(4, buf.byteLength - 8, true);
  str(8, "WAVE");
  str(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, isFloat ? 3 : 1, true);
  dv.setUint16(22, nch, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * align, true);
  dv.setUint16(32, align, true);
  dv.setUint16(34, bits, true);
  str(36, "data");
  dv.setUint32(40, dataLen, true);

  let p = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++, p += bytes) {
      const v = channels[c][i];
      if (isFloat) {
        if (bytes === 4) dv.setFloat32(p, v, true);
        else dv.setFloat64(p, v, true);
        continue;
      }
      const s = Math.max(-1, Math.min(1, v));
      if (bytes === 1) dv.setUint8(p, Math.round(s * 127) + 128);
      else if (bytes === 2) dv.setInt16(p, Math.round(s * 32767), true);
      else if (bytes === 3) {
        const q = Math.round(s * 8388607);
        dv.setUint8(p, q & 0xff);
        dv.setUint8(p + 1, (q >> 8) & 0xff);
        dv.setUint8(p + 2, (q >> 16) & 0xff);
      } else dv.setInt32(p, Math.round(s * 2147483647), true);
    }
  }
  return new Blob([buf], { type: "audio/wav" });
}
