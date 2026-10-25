import { type CborValue, decodeCbor } from './cbor';

/**
 * C2PA / Content Credentials: manifests are stored in JUMBF boxes (ISO 19566-5):
 *   JPEG → APP11 segments, PNG → caBX chunk, WebP/WAV → "C2PA" RIFF chunk,
 *   MP4/HEIC/AVIF → `uuid` box D8FEC3D6-1B0E-483C-9297-5828877EC481.
 *
 * We parse the manifest store to report the claim generator, AI "digital source type" actions and
 * certificate subject hints. We do NOT validate signatures or hashes, so everything here is
 * presence/claims only and labelled as unverified in the output.
 */

export interface JumbfBox {
  label?: string;
  typeUuid?: string;
  children: JumbfBox[];
  contents: { type: string; data: Uint8Array }[];
}

export interface C2paSummary {
  present: boolean;
  manifestCount: number;
  claimGenerator?: string;
  claimGeneratorInfo: string[];
  actions: string[];
  digitalSourceTypes: string[];
  softwareAgents: string[];
  signerHints: string[];
  title?: string;
  parseError?: string;
}

export const C2PA_UUID_ISOBMFF = 'd8fec3d61b0e483c92975828877ec481';

const MAX_BOXES = 2_000;

function u32(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
}
const fourcc = (b: Uint8Array, o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Parse a sequence of JUMBF/ISO boxes. */
export function parseJumbf(bytes: Uint8Array): JumbfBox[] {
  let count = 0;
  const parseSeq = (data: Uint8Array, depth: number): JumbfBox[] => {
    const out: JumbfBox[] = [];
    let o = 0;
    while (o + 8 <= data.length) {
      if (++count > MAX_BOXES || depth > 16) throw new Error('JUMBF: too many boxes');
      let size = u32(data, o);
      const type = fourcc(data, o + 4);
      let header = 8;
      if (size === 1) {
        if (o + 16 > data.length) break;
        size = Number((BigInt(u32(data, o + 8)) << 32n) + BigInt(u32(data, o + 12)));
        header = 16;
      } else if (size === 0) size = data.length - o;
      if (size < header || o + size > data.length) break;
      const payload = data.subarray(o + header, o + size);
      if (type === 'jumb') out.push(parseSuperbox(payload, depth));
      o += size;
    }
    return out;
  };
  const parseSuperbox = (payload: Uint8Array, depth: number): JumbfBox => {
    const box: JumbfBox = { children: [], contents: [] };
    let o = 0;
    while (o + 8 <= payload.length) {
      if (++count > MAX_BOXES) throw new Error('JUMBF: too many boxes');
      const size = u32(payload, o);
      const type = fourcc(payload, o + 4);
      if (size < 8 || o + size > payload.length) break;
      const body = payload.subarray(o + 8, o + size);
      if (type === 'jumd') {
        box.typeUuid = hex(body.subarray(0, 16));
        const toggles = body[16] ?? 0;
        if (toggles & 0x02) {
          const end = body.indexOf(0, 17);
          box.label = new TextDecoder().decode(body.subarray(17, end < 0 ? body.length : end));
        }
      } else if (type === 'jumb') {
        box.children.push(parseSuperbox(body, depth + 1));
      } else {
        box.contents.push({ type, data: body });
      }
      o += size;
    }
    return box;
  };
  return parseSeq(bytes, 0);
}

function walk(box: JumbfBox, fn: (b: JumbfBox) => void) {
  fn(box);
  for (const c of box.children) walk(c, fn);
}

function asString(v: CborValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function generatorInfoNames(v: CborValue | undefined): string[] {
  const list = Array.isArray(v) ? v : v && typeof v === 'object' && !(v instanceof Uint8Array) ? [v] : [];
  return list
    .map((x) => {
      if (x && typeof x === 'object' && !(x instanceof Uint8Array) && !Array.isArray(x)) {
        const o = x as Record<string, CborValue>;
        const name = asString(o.name);
        const version = asString(o.version);
        return name ? (version ? `${name} ${version}` : name) : undefined;
      }
      return undefined;
    })
    .filter((x): x is string => Boolean(x));
}

/** Pull O= and CN= values out of DER certificates embedded in a COSE signature (no validation). */
export function derSubjectHints(bytes: Uint8Array): string[] {
  const out: string[] = [];
  for (let i = 0; i + 7 < bytes.length && out.length < 8; i++) {
    // OID 2.5.4.10 (organizationName) or 2.5.4.3 (commonName): 06 03 55 04 0A|03
    if (
      bytes[i] === 0x06 &&
      bytes[i + 1] === 0x03 &&
      bytes[i + 2] === 0x55 &&
      bytes[i + 3] === 0x04 &&
      (bytes[i + 4] === 0x0a || bytes[i + 4] === 0x03)
    ) {
      const tag = bytes[i + 5]!;
      const len = bytes[i + 6]!;
      if ([0x0c, 0x13, 0x14, 0x16].includes(tag) && len > 0 && len < 128 && i + 7 + len <= bytes.length) {
        const s = new TextDecoder('utf-8', { fatal: false })
          .decode(bytes.subarray(i + 7, i + 7 + len))
          .trim();
        if (s && !out.includes(s)) out.push(s);
      }
    }
  }
  return out;
}

/** Summarize a C2PA manifest store from raw JUMBF bytes. Never throws. */
export function summarizeC2pa(jumbf: Uint8Array): C2paSummary {
  const summary: C2paSummary = {
    present: true,
    manifestCount: 0,
    claimGeneratorInfo: [],
    actions: [],
    digitalSourceTypes: [],
    softwareAgents: [],
    signerHints: [],
  };
  try {
    const roots = parseJumbf(jumbf);
    const store = roots.find((r) => r.label === 'c2pa') ?? roots[0];
    if (!store) {
      summary.parseError = 'No JUMBF superbox found';
      return summary;
    }
    const manifests = store.label === 'c2pa' ? store.children : [store];
    summary.manifestCount = manifests.length;
    // The active manifest is the last one in the store.
    for (const manifest of manifests) {
      walk(manifest, (b) => {
        const label = b.label ?? '';
        const cbor = b.contents.find((c) => c.type === 'cbor');
        if (/^c2pa\.claim(\.v2)?$/.test(label) && cbor) {
          const claim = safeDecode(cbor.data);
          if (claim && typeof claim === 'object' && !Array.isArray(claim) && !(claim instanceof Uint8Array)) {
            const c = claim as Record<string, CborValue>;
            summary.claimGenerator = asString(c.claim_generator) ?? summary.claimGenerator;
            const info = generatorInfoNames(c.claim_generator_info);
            if (info.length) summary.claimGeneratorInfo = info;
            summary.title = asString(c['dc:title']) ?? summary.title;
          }
        }
        if (/^c2pa\.actions(\.v2)?$/.test(label) && cbor) {
          const a = safeDecode(cbor.data) as Record<string, CborValue> | undefined;
          const actions = a && Array.isArray(a.actions) ? a.actions : [];
          for (const act of actions) {
            if (!act || typeof act !== 'object' || Array.isArray(act) || act instanceof Uint8Array) continue;
            const o = act as Record<string, CborValue>;
            const name = asString(o.action);
            if (name && !summary.actions.includes(name)) summary.actions.push(name);
            const dst = asString(o.digitalSourceType);
            if (dst && !summary.digitalSourceTypes.includes(dst)) summary.digitalSourceTypes.push(dst);
            const agent = asString(o.softwareAgent) ?? generatorInfoNames(o.softwareAgent)[0];
            if (agent && !summary.softwareAgents.includes(agent)) summary.softwareAgents.push(agent);
          }
        }
        if (label === 'c2pa.signature') {
          for (const c of b.contents)
            for (const h of derSubjectHints(c.data))
              if (!summary.signerHints.includes(h)) summary.signerHints.push(h);
        }
      });
    }
  } catch (err) {
    summary.parseError = (err as Error).message;
  }
  return summary;
}

function safeDecode(b: Uint8Array): CborValue | undefined {
  try {
    return decodeCbor(b);
  } catch {
    return undefined;
  }
}

/**
 * Reassemble JUMBF from JPEG APP11 segments. Each segment payload is:
 *   "JP" (2) | En box instance (2) | Z sequence (4) | box data
 * Continuation segments (Z > 1) repeat the 8-byte LBox/TBox header, which is dropped.
 */
export function jumbfFromApp11(segments: Uint8Array[]): Uint8Array | null {
  const byInstance = new Map<number, { z: number; data: Uint8Array }[]>();
  for (const seg of segments) {
    if (seg.length < 8 || seg[0] !== 0x4a || seg[1] !== 0x50) continue;
    const en = (seg[2]! << 8) | seg[3]!;
    const z = u32(seg, 4);
    const list = byInstance.get(en) ?? [];
    list.push({ z, data: seg.subarray(8) });
    byInstance.set(en, list);
  }
  const parts: Uint8Array[] = [];
  for (const list of byInstance.values()) {
    list.sort((a, b) => a.z - b.z);
    for (const [i, p] of list.entries()) parts.push(i === 0 ? p.data : p.data.subarray(8));
  }
  if (!parts.length) return null;
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
