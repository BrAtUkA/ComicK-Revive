/**
 * CryptoJS/OpenSSL-compatible AES decryption for Madara's "chapter protector"
 * (port of Tachiyomi's lib/cryptoaes). The protector encrypts the page-list
 * JSON with AES-256-CBC, key+IV derived from a password and salt via
 * OpenSSL's EVP_BytesToKey (MD5, one iteration). WebCrypto has AES-CBC but
 * no MD5, hence the small MD5 below. Viewer/dashboard contexts only
 * (needs crypto.subtle, i.e. a secure context).
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const K = new Uint32Array(64).map((_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32));

/** RFC 1321 MD5 over raw bytes. */
function md5(input: Uint8Array): Uint8Array<ArrayBuffer> {
  const bitLen = input.length * 8;
  const paddedLen = (((input.length + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(paddedLen);
  buf.set(input);
  buf[input.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(paddedLen - 8, bitLen >>> 0, true);
  view.setUint32(paddedLen - 4, Math.floor(bitLen / 2 ** 32), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      const sum = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((sum << S[i]) | (sum >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true);
  ov.setUint32(4, b0, true);
  ov.setUint32(8, c0, true);
  ov.setUint32(12, d0, true);
  return out;
}

/** OpenSSL EVP_BytesToKey: D_i = MD5(D_{i-1} || password || salt), one iteration. */
function evpBytesToKey(
  password: Uint8Array,
  salt: Uint8Array,
  keyLen: number,
  ivLen: number
): { key: Uint8Array; iv: Uint8Array } {
  const generated: Uint8Array[] = [];
  let total = 0;
  let prev = new Uint8Array(0);
  while (total < keyLen + ivLen) {
    const data = new Uint8Array(prev.length + password.length + salt.length);
    data.set(prev);
    data.set(password, prev.length);
    data.set(salt, prev.length + password.length);
    prev = md5(data);
    generated.push(prev);
    total += prev.length;
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of generated) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return { key: all.slice(0, keyLen), iv: all.slice(keyLen, keyLen + ivLen) };
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const bytes = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Decrypt an OpenSSL/CryptoJS-style payload: base64 ciphertext + hex salt +
 * passphrase, AES-256-CBC with EVP-derived key/IV. Throws on bad input or
 * failed padding; callers translate that into a source error.
 */
export async function decryptOpenSslAes(
  ciphertextB64: string,
  saltHex: string,
  password: string
): Promise<string> {
  const ciphertext = base64ToBytes(ciphertextB64);
  const { key, iv } = evpBytesToKey(new TextEncoder().encode(password), hexToBytes(saltHex), 32, 16);
  // .buffer casts: all three are freshly allocated, exact-size views, and
  // TS's BufferSource rejects the generic Uint8Array<ArrayBufferLike>
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key.buffer as ArrayBuffer, { name: 'AES-CBC' }, false, ['decrypt']
  );
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: iv.buffer as ArrayBuffer }, cryptoKey, ciphertext.buffer as ArrayBuffer
  );
  return new TextDecoder().decode(plain);
}
