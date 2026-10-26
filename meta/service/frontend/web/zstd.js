// Zstd for the service's key containers.
//
// Inflating is what every incoming blob needs (sealy writes zstd); deflating is
// needed only for keys, because zkp_lib inflates the registered public key with
// ZSTD_decompress before reading its coefficients at a fixed offset. Rather than
// ship a zstd encoder for that, this writes a frame of raw (uncompressed)
// blocks: standard zstd per RFC 8478, accepted by every decoder, and the few
// hundred bytes it costs over a compressed frame do not matter for a 32 KB key.

export { decompress as inflate } from "./vendor/fzstd/fzstd.js";

const MAGIC = 0xfd2fb528;
const MAX_BLOCK_SIZE = 1 << 17; // 128 KiB, the zstd block ceiling
const RAW_BLOCK = 0;
// Single_Segment_flag, plus a 4-byte Frame_Content_Size (the 2-byte form would
// have to subtract 256, the 4-byte one is written as is).
const FRAME_HEADER_DESCRIPTOR = 0xa0;

export function rawFrame(payload) {
  const blocks = Math.max(1, Math.ceil(payload.length / MAX_BLOCK_SIZE));
  const out = new Uint8Array(9 + blocks * 3 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  out[4] = FRAME_HEADER_DESCRIPTOR;
  view.setUint32(5, payload.length, true);

  let cursor = 9;
  for (let offset = 0; offset < payload.length || offset === 0; offset += MAX_BLOCK_SIZE) {
    const size = Math.min(MAX_BLOCK_SIZE, payload.length - offset);
    const last = offset + size >= payload.length ? 1 : 0;
    const header = (size << 3) | (RAW_BLOCK << 1) | last;
    out[cursor] = header & 0xff;
    out[cursor + 1] = (header >> 8) & 0xff;
    out[cursor + 2] = (header >> 16) & 0xff;
    cursor += 3;
    out.set(payload.subarray(offset, offset + size), cursor);
    cursor += size;
  }
  return out;
}
