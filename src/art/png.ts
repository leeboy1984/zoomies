import { deflateSync, inflateSync } from "node:zlib";

/**
 * Minimal dependency-free PNG: writes 8-bit RGBA and reads the usual 8-bit
 * formats (greyscale, RGB, palette, with or without alpha), non-interlaced.
 * Enough for our assets and for normalising AI-generated images.
 */

export interface Image {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row by row. */
  data: Uint8Array;
}

export function createImage(width: number, height: number): Image {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

export function getPixel(img: Image, x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  const d = img.data;
  return [d[i] ?? 0, d[i + 1] ?? 0, d[i + 2] ?? 0, d[i + 3] ?? 0];
}

export function setPixel(img: Image, x: number, y: number, rgba: readonly [number, number, number, number]): void {
  const i = (y * img.width + x) * 4;
  img.data.set(rgba, i);
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encodes 8-bit RGBA. Deterministic: same pixels → same bytes. */
export function encodePng(img: Image): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8; // bits
  ihdr[9] = 6; // RGBA
  const stride = img.width * 4;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0; // filter None
    raw.set(img.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(buf: Buffer): Image {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      interlace = data[12] ?? 0;
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (bitDepth !== 8) throw new Error(`${bitDepth}-bit PNG not supported (8 only)`);
  if (interlace !== 0) throw new Error("interlaced PNG not supported");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`colour type ${colorType} not supported`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? (out[x - channels] ?? 0) : 0;
      const b = prev[x] ?? 0;
      const c = x >= channels ? (prev[x - channels] ?? 0) : 0;
      const v = line[x] ?? 0;
      const pred = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : paeth(a, b, c);
      out[x] = (v + pred) & 0xff;
    }
    prev = out;
  }

  const img = createImage(width, height);
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    let rgba: [number, number, number, number];
    switch (colorType) {
      case 0: {
        const g = pixels[p] ?? 0;
        rgba = [g, g, g, trns && trns.length >= 2 && trns.readUInt16BE(0) === g ? 0 : 255];
        break;
      }
      case 2:
        rgba = [pixels[p] ?? 0, pixels[p + 1] ?? 0, pixels[p + 2] ?? 0, 255];
        break;
      case 3: {
        const idx = pixels[p] ?? 0;
        if (!palette) throw new Error("palette PNG without PLTE");
        rgba = [palette[idx * 3] ?? 0, palette[idx * 3 + 1] ?? 0, palette[idx * 3 + 2] ?? 0, trns ? (trns[idx] ?? 255) : 255];
        break;
      }
      case 4: {
        const g = pixels[p] ?? 0;
        rgba = [g, g, g, pixels[p + 1] ?? 0];
        break;
      }
      default:
        rgba = [pixels[p] ?? 0, pixels[p + 1] ?? 0, pixels[p + 2] ?? 0, pixels[p + 3] ?? 0];
    }
    setPixel(img, i % width, Math.floor(i / width), rgba);
  }
  return img;
}
