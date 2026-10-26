// The service's login proof, in the browser: the same zkp_lib C library the
// service verifies with, compiled to WebAssembly (see ../../build_zkp_wasm.sh).
// Proofs are byte-identical to the native library's, which the tests assert.
//
// It parses the serialized SEAL keys itself, so feed it the keys as generated
// by seal.js. The proof is deterministic and carries no challenge from the
// server, so the reference client makes one at registration and reuses it for
// every login.

import initZkpModule from "./vendor/zkp/zkp_lib.mjs";

const PROOF_CAPACITY = 0x10000; // ZKP_PROOF_CAPACITY in zkp_core.h

class Zkp {
  constructor(module) {
    this.module = module;
  }

  prove(publicKey, secretKey) {
    const pk = this._copyIn(publicKey);
    const sk = this._copyIn(secretKey);
    const proof = this.module._malloc(PROOF_CAPACITY);
    try {
      const size = this.module._zkp_prove(pk.ptr, pk.length, sk.ptr, sk.length, proof);
      return this.module.HEAPU8.slice(proof, proof + size);
    } finally {
      [proof, sk.ptr, pk.ptr].forEach((ptr) => this.module._free(ptr));
    }
  }

  verify(publicKey, proof) {
    const pk = this._copyIn(publicKey);
    const encoded = this._copyIn(proof);
    try {
      return !!this.module._zkp_verify(pk.ptr, pk.length, encoded.ptr, encoded.length);
    } finally {
      [encoded.ptr, pk.ptr].forEach((ptr) => this.module._free(ptr));
    }
  }

  // Growing the heap replaces HEAPU8, so it is read after every allocation.
  _copyIn(bytes) {
    const ptr = this.module._malloc(bytes.length);
    this.module.HEAPU8.set(bytes, ptr);
    return { ptr, length: bytes.length };
  }
}

let instance = null;

export function initZkp() {
  instance ??= initZkpModule().then((module) => new Zkp(module));
  return instance;
}
