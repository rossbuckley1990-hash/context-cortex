// Format recognition by structure, never by file name. A detection is an observation
// about bytes; whether a program accepts or produces a format is decided by trials.

const ascii = (s) => Buffer.from(s, "latin1");
const at = (b, off, sig) => b.length >= off + sig.length && b.subarray(off, off + sig.length).equals(sig);

/** [media type, test] in order: more specific signatures first. */
const SIGNATURES = [
  ["image/png", (b) => at(b, 0, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["image/jpeg", (b) => at(b, 0, Buffer.from([0xff, 0xd8, 0xff]))],
  ["image/gif", (b) => at(b, 0, ascii("GIF87a")) || at(b, 0, ascii("GIF89a"))],
  ["image/webp", (b) => at(b, 0, ascii("RIFF")) && at(b, 8, ascii("WEBP"))],
  ["audio/wav", (b) => at(b, 0, ascii("RIFF")) && at(b, 8, ascii("WAVE"))],
  ["image/avif", (b) => at(b, 4, ascii("ftyp")) && (at(b, 8, ascii("avif")) || at(b, 8, ascii("avis")))],
  ["image/heic", (b) => at(b, 4, ascii("ftyp")) && ["heic", "heix", "mif1"].some((t) => at(b, 8, ascii(t)))],
  ["video/mp4", (b) => at(b, 4, ascii("ftyp")) && ["isom", "mp41", "mp42", "iso2", "avc1"].some((t) => at(b, 8, ascii(t)))],
  ["image/tiff", (b) => at(b, 0, Buffer.from([0x49, 0x49, 0x2a, 0x00])) || at(b, 0, Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))],
  ["image/bmp", (b) => at(b, 0, ascii("BM")) && b.length >= 26],
  ["image/x-portable-anymap", (b) => b.length >= 3 && b[0] === 0x50 && b[1] >= 0x31 && b[1] <= 0x37 && /\s/.test(String.fromCharCode(b[2]))],
  ["application/pdf", (b) => at(b, 0, ascii("%PDF-"))],
  ["application/zip", (b) => at(b, 0, Buffer.from([0x50, 0x4b, 0x03, 0x04])) || at(b, 0, Buffer.from([0x50, 0x4b, 0x05, 0x06]))],
  ["application/gzip", (b) => at(b, 0, Buffer.from([0x1f, 0x8b]))],
  ["application/x-bzip2", (b) => at(b, 0, ascii("BZh"))],
  ["application/x-xz", (b) => at(b, 0, Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))],
  ["application/zstd", (b) => at(b, 0, Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))],
  ["audio/flac", (b) => at(b, 0, ascii("fLaC"))],
  ["audio/ogg", (b) => at(b, 0, ascii("OggS"))],
  ["audio/mpeg", (b) => at(b, 0, ascii("ID3")) || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0)],
];

/** File-name extensions some programs require on their inputs and outputs. */
const EXTENSIONS = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/avif": ".avif",
  "image/heic": ".heic", "image/tiff": ".tif", "image/bmp": ".bmp", "image/x-portable-anymap": ".pnm",
  "image/x-portable-pixmap": ".ppm", "image/x-portable-graymap": ".pgm", "audio/wav": ".wav", "audio/flac": ".flac",
  "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "video/mp4": ".mp4", "application/pdf": ".pdf", "application/zip": ".zip",
  "application/gzip": ".gz", "application/x-bzip2": ".bz2", "application/x-xz": ".xz", "application/zstd": ".zst",
  "text/plain": ".txt", "application/json": ".json", "text/csv": ".csv",
};

export const KNOWN_FORMATS = [...SIGNATURES.map(([t]) => t), "text/plain", "application/json"];

function utf8Text(b) {
  if (b.length === 0 || b.includes(0)) return false;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(b);
  if (text.includes("�")) return false;
  let control = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) control++;
  }
  return control === 0;
}

/**
 * Detect a format from bytes. Returns { format, basis }:
 * basis "magic" (a signature matched), "text" (valid UTF-8 without control bytes) or "unknown".
 */
export function detect(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  for (const [type, test] of SIGNATURES) if (test(b)) return { format: type, basis: "magic" };
  if (utf8Text(b)) {
    try {
      JSON.parse(b.toString("utf8"));
      if (/^\s*[[{]/.test(b.toString("utf8"))) return { format: "application/json", basis: "text" };
    } catch {
      /* not JSON */
    }
    return { format: "text/plain", basis: "text" };
  }
  return { format: null, basis: "unknown" };
}

/** Whether detection can confirm a declared format: true, false (it is something else), or null (cannot tell). */
export function confirms(detected, declared) {
  if (!declared || declared === "application/octet-stream") return true;
  if (!detected.format) return null;
  if (detected.format === declared) return true;
  // JSON is text; text/plain accepts it.
  if (declared === "text/plain" && detected.format === "application/json") return true;
  if (declared.startsWith("image/x-portable") && detected.format === "image/x-portable-anymap") return true;
  if (!KNOWN_FORMATS.includes(declared)) return null;
  return false;
}

export const extensionFor = (format) => EXTENSIONS[format] ?? "";

/** Deterministic damage for negative controls and witness calibration. */
export const MUTATIONS = {
  truncate: (b) => b.subarray(0, Math.floor(b.length / 2)),
  "corrupt-header": (b) => {
    const c = Buffer.from(b);
    for (let i = 0; i < Math.min(8, c.length); i++) c[i] = 0;
    return c;
  },
  "flip-middle": (b) => {
    const c = Buffer.from(b);
    if (c.length) c[Math.floor(c.length / 2)] ^= 0xff;
    return c;
  },
  empty: () => Buffer.alloc(0),
};

export function mutate(bytes, kind) {
  const f = MUTATIONS[kind];
  if (!f) throw new Error(`unknown mutation ${kind}; known: ${Object.keys(MUTATIONS).join(", ")}`);
  return Buffer.from(f(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)));
}
