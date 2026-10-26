// Client-side FHE for the C20 service: the same BFV parameters, key formats and
// binary/base64 wire encodings the reference client (`client/client.py`) uses,
// on top of node-seal (Microsoft SEAL compiled to WebAssembly).
//
// Every blob that crosses the wire is relabelled for the service's SEAL version
// (see sealcompat.js). Keys are handed out as raw bytes because `/register` and
// `/games/<g>/afk`, `/games/<g>/whisper`, `/games/<g>/roll`, and
// `/games/<g>/rolls/<id>/resolve` post raw bytes. JSON
// responses carry cryptographic blobs as base64.

import initNodeSeal from "./vendor/node-seal/index.js";
import { toNodeSeal, toService } from "./sealcompat.js";

const POLY_MODULUS_DEGREE = 2048;
const PLAIN_MODULUS_BITS = 16;
const PLAIN_MODULUS = 61441;

export const SLOT_COUNT = POLY_MODULUS_DEGREE;

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function fromBase64(b64) {
  const raw = atob(b64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// The service treats message contents as opaque, so the slot layout is ours to
// pick: one UTF-8 byte per slot, which fits the 16-bit plain modulus.
export function textToValues(text) {
  return Array.from(new TextEncoder().encode(text));
}

export function valuesToText(values) {
  const bytes = [];
  for (const value of values) {
    if (value === 0) break;
    bytes.push(value);
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

class ServiceCrypto {
  constructor(seal, context) {
    this.seal = seal;
    this.context = context;
    this.encoder = new seal.BatchEncoder(context);
  }

  // Keys go out in a zstd container because the service's zkp_lib inflates
  // them itself before reading the coefficients (see zkp.js).
  generateKeypair() {
    const generator = new this.seal.KeyGenerator(this.context);
    const publicKey = generator.createPublicKey();
    const secretKey = generator.secretKey();
    try {
      return {
        publicKey: this._save(publicKey, "ciphertext", { zstd: true }),
        secretKey: this._save(secretKey, "plaintext", { zstd: true }),
      };
    } finally {
      [publicKey, secretKey, generator].forEach((handle) => handle.delete());
    }
  }

  encodeValues(values) {
    const plain = this._encode(values);
    try {
      return this._save(plain, "plaintext");
    } finally {
      plain.delete();
    }
  }

  decodeValues(plaintext) {
    const plain = this._load("Plaintext", plaintext, "plaintext");
    try {
      return Array.from(this.encoder.decodeBigInt64(plain), Number);
    } finally {
      plain.delete();
    }
  }

  encrypt(publicKey, values) {
    const key = this._load("PublicKey", publicKey, "ciphertext");
    const plain = this._encode(values);
    const cipher = new this.seal.Ciphertext();
    const encryptor = new this.seal.Encryptor(this.context, key);
    try {
      encryptor.encrypt(plain, cipher);
      return this._save(cipher, "ciphertext");
    } finally {
      [encryptor, cipher, plain, key].forEach((handle) => handle.delete());
    }
  }

  // What the game owner posts when resolving a roll: the service
  // expects the plaintext, still encoded, not the decoded values.
  decryptToPlaintext(secretKey, ciphertext) {
    const key = this._load("SecretKey", secretKey, "plaintext");
    const cipher = this._load("Ciphertext", ciphertext, "ciphertext");
    const plain = new this.seal.Plaintext();
    const decryptor = new this.seal.Decryptor(this.context, key);
    try {
      decryptor.decrypt(cipher, plain);
      return this._save(plain, "plaintext");
    } finally {
      [decryptor, plain, cipher, key].forEach((handle) => handle.delete());
    }
  }

  decrypt(secretKey, ciphertext) {
    return this.decodeValues(this.decryptToPlaintext(secretKey, ciphertext));
  }

  encryptText(publicKey, text) {
    return this.encrypt(publicKey, textToValues(text));
  }

  randomRollValues() {
    const values = [];
    const random = new Uint16Array(SLOT_COUNT);
    while (values.length < SLOT_COUNT) {
      crypto.getRandomValues(random);
      for (const value of random) {
        if (value < PLAIN_MODULUS - 1) values.push(value + 1);
        if (values.length === SLOT_COUNT) break;
      }
    }
    return values;
  }

  decryptText(secretKey, ciphertext) {
    return valuesToText(this.decrypt(secretKey, ciphertext));
  }

  _encode(values) {
    if (values.length > SLOT_COUNT) throw new Error("too many plaintext slots");
    const slots = new BigInt64Array(SLOT_COUNT);
    values.forEach((value, i) => (slots[i] = BigInt(value)));
    const plain = new this.seal.Plaintext();
    this.encoder.encode(slots, plain);
    return plain;
  }

  _load(type, bytes, kind) {
    const handle = new this.seal[type]();
    handle.loadFromArray(this.context, toNodeSeal(bytes, kind));
    return handle;
  }

  _save(handle, kind, options) {
    return toService(handle.saveToArray(this.seal.ComprModeType.none), kind, options);
  }
}

let instance = null;

export function initSeal() {
  instance ??= initNodeSeal().then((seal) => {
    const parms = new seal.EncryptionParameters(seal.SchemeType.bfv);
    parms.setPolyModulusDegree(POLY_MODULUS_DEGREE);
    parms.setCoeffModulus(seal.CoeffModulus.BFVDefault(POLY_MODULUS_DEGREE, seal.SecLevelType.tc128));
    parms.setPlainModulus(seal.PlainModulus.Batching(POLY_MODULUS_DEGREE, PLAIN_MODULUS_BITS));
    const context = new seal.SEALContext(parms, false, seal.SecLevelType.tc128);
    if (!context.parametersSet()) throw new Error("SEAL parameters rejected");
    return new ServiceCrypto(seal, context);
  });
  return instance;
}
