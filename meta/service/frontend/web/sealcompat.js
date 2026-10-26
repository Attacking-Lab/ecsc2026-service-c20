// Relabels the container of a serialized Microsoft SEAL object between the
// service's SEAL version and node-seal's.
//
// SEAL only loads blobs whose header version matches its own (4.1 accepts
// {4,1} and {3,>=4}, 4.0 accepts {4,0} and {3,>=4}), and the service runs sealy
// 0.3.0 (SEAL 4.0.0) while node-seal 7 ships SEAL 4.1.2. The payloads are
// identical for BFV — 4.1 only changed serialization for BGV, which puts
// ciphertexts in NTT form on load — so this is a rename of the container, not a
// conversion of the data.
//
// One serialized object (seal/serialization.h, <type>::save_members):
//   header   magic u16 | header_size u8 | major u8 | minor u8 | compr u8 |
//            reserved u16 | size u64      (16 bytes, size covers the header)
//   payload  a fixed per-type prefix, then nested blobs that carry their own
//            header: the DynArray of coefficients, plus the PRNG info when the
//            ciphertext is seeded. Nested blobs are never compressed.
// Output is written uncompressed, which every SEAL build accepts, except for
// keys: zkp_lib inflates those itself, so they keep a zstd container.

import { inflate, rawFrame } from "./zstd.js";

const MAGIC = 0xa15e;
const HEADER_SIZE = 16;
const COMPR_NONE = 0;
const COMPR_ZSTD = 2;
const VERSION_MAJOR = 4;

export const SERVICE_MINOR = 0; // sealy 0.3.0 -> SEAL 4.0.0
export const NODE_SEAL_MINOR = 1; // node-seal 7.0.0 -> SEAL 4.1.2

// Payload bytes before the first nested blob.
const PREFIX = {
  // parms_id(32) coeff_count(8) scale(8)
  plaintext: 48,
  // parms_id(32) is_ntt_form(1) size(8) poly_modulus_degree(8)
  // coeff_modulus_size(8) scale(8) correction_factor(8)
  ciphertext: 73,
};

function readHeader(bytes, offset) {
  if (offset + HEADER_SIZE > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = {
    magic: view.getUint16(offset, true),
    headerSize: bytes[offset + 2],
    major: bytes[offset + 3],
    minor: bytes[offset + 4],
    compr: bytes[offset + 5],
    reserved: view.getUint16(offset + 6, true),
    size: Number(view.getBigUint64(offset + 8, true)),
  };
  const valid =
    header.magic === MAGIC &&
    header.headerSize === HEADER_SIZE &&
    header.major === VERSION_MAJOR &&
    header.minor <= NODE_SEAL_MINOR &&
    header.compr <= COMPR_ZSTD &&
    header.reserved === 0 &&
    header.size >= HEADER_SIZE &&
    offset + header.size <= bytes.length;
  return valid ? header : null;
}

function decompress(payload, compr) {
  if (compr === COMPR_NONE) return payload;
  if (compr === COMPR_ZSTD) return inflate(payload);
  throw new Error(`unsupported SEAL compression mode ${compr}`);
}

function relabelNested(payload, prefix, minor) {
  let offset = prefix;
  if (!readHeader(payload, offset)) {
    throw new Error(`no nested SEAL blob at offset ${prefix}`);
  }
  while (offset < payload.length) {
    const nested = readHeader(payload, offset);
    if (!nested) break;
    payload[offset + 4] = minor;
    offset += nested.size;
  }
  return payload;
}

function relabel(bytes, kind, minor, zstd) {
  const prefix = PREFIX[kind];
  if (prefix === undefined) throw new Error(`unknown SEAL object kind ${kind}`);

  const header = readHeader(bytes, 0);
  if (!header) throw new Error("not a serialized SEAL object");

  const relabelled = relabelNested(
    Uint8Array.from(decompress(bytes.subarray(HEADER_SIZE, header.size), header.compr)),
    prefix,
    minor,
  );
  const payload = zstd ? rawFrame(relabelled) : relabelled;

  const out = new Uint8Array(HEADER_SIZE + payload.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, MAGIC, true);
  out[2] = HEADER_SIZE;
  out[3] = VERSION_MAJOR;
  out[4] = minor;
  out[5] = zstd ? COMPR_ZSTD : COMPR_NONE;
  view.setUint16(6, 0, true);
  view.setBigUint64(8, BigInt(out.length), true);
  out.set(payload, HEADER_SIZE);
  return out;
}

// `kind` is "plaintext" (Plaintext, SecretKey) or "ciphertext" (Ciphertext,
// PublicKey) — the two payload layouts the service exchanges. Pass zstd for a
// key, which zkp_lib expects to find in a zstd container.
export const toNodeSeal = (bytes, kind) => relabel(bytes, kind, NODE_SEAL_MINOR, false);
export const toService = (bytes, kind, { zstd = false } = {}) =>
  relabel(bytes, kind, SERVICE_MINOR, zstd);
