// HD wallet core (zero extra dependencies, Node built-in crypto only).
//   One master seed (env WALLET_MASTER_SEED) -> a unique deposit address for every user on:
//     EVM   (ETH, BSC, Polygon, Arbitrum, Base, Optimism, Avalanche all share ONE 0x address)  m/44'/60'/0'/0/<i>   (BIP32 secp256k1)
//     TRON  (TRX + TRC20)                                                                       m/44'/195'/0'/0/<i>
//     SOL   (SOL + SPL)                                                                         m/44'/501'/<i>'/0'   (SLIP-10 ed25519, Phantom style)
//   Private keys are NEVER stored. They are re-derived from the seed only when funds must be swept / sent.
//   WALLET_MASTER_SEED = a BIP39 phrase (12-24 words, separated by spaces) OR 32-64 bytes hex. Keep it ONLY in server env.
import crypto from "node:crypto";

/* ---------------- keccak-256 (Ethereum flavour, NOT sha3-256) ---------------- */
const M64 = (1n << 64n) - 1n;
const rotl = (x, n) => n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64;
function keccakF(s) {
  let R = 1;
  for (let round = 0; round < 24; round++) {
    const C = [0n, 0n, 0n, 0n, 0n];
    for (let x = 0; x < 5; x++) C[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[y + x] ^= D;
    }
    let x = 1, y = 0, cur = s[1];
    for (let t = 0; t < 24; t++) {
      [x, y] = [y, (2 * x + 3 * y) % 5];
      const tmp = s[x + 5 * y];
      s[x + 5 * y] = rotl(cur, ((t + 1) * (t + 2) / 2) % 64);
      cur = tmp;
    }
    for (let yy = 0; yy < 25; yy += 5) {
      const row = s.slice(yy, yy + 5);
      for (let xx = 0; xx < 5; xx++) s[yy + xx] = row[xx] ^ (~row[(xx + 1) % 5] & M64 & row[(xx + 2) % 5]);
    }
    let rc = 0n;
    for (let j = 0; j < 7; j++) {
      R = ((R << 1) ^ ((R >> 7) * 0x71)) % 256;
      if (R & 2) rc ^= 1n << BigInt((1 << j) - 1);
    }
    s[0] ^= rc;
  }
}
export function keccak256(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const rate = 136, s = new Array(25).fill(0n);
  const padded = Buffer.alloc(Math.ceil((data.length + 1) / rate) * rate);
  data.copy(padded); padded[data.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) s[i] ^= padded.readBigUInt64LE(off + i * 8);
    keccakF(s);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(s[i], i * 8);
  return out;
}

/* ---------------- base58 / base58check ---------------- */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(buf) {
  let n = BigInt("0x" + (buf.toString("hex") || "0")), out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = "1" + out; else break; }
  return out;
}
const sha256 = b => crypto.createHash("sha256").update(b).digest();
function base58check(payload) {
  return base58(Buffer.concat([payload, sha256(sha256(payload)).subarray(0, 4)]));
}

/* ---------------- master seed ---------------- */
let seedCache = null;
export function masterSeed() {
  const raw = String(process.env.WALLET_MASTER_SEED || "").trim();
  if (!raw) throw new Error("WALLET_MASTER_SEED_NOT_CONFIGURED");
  if (seedCache && seedCache.raw === raw) return seedCache.seed;
  let seed;
  if (/^(0x)?[0-9a-fA-F]{64,128}$/.test(raw)) {
    seed = Buffer.from(raw.replace(/^0x/, ""), "hex");
  } else {
    const words = raw.normalize("NFKD").split(/\s+/).filter(Boolean);
    if (![12, 15, 18, 21, 24].includes(words.length)) throw new Error("WALLET_MASTER_SEED_INVALID");
    seed = crypto.pbkdf2Sync(words.join(" "), "mnemonic" + String(process.env.WALLET_MASTER_PASSPHRASE || "").normalize("NFKD"), 2048, 64, "sha512");
  }
  seedCache = { raw, seed };
  return seed;
}
// Non-secret fingerprint: lets us refuse to run if someone swaps the seed after wallets were issued.
export function seedFingerprint(seed = masterSeed()) {
  return crypto.createHash("sha256").update(Buffer.concat([Buffer.from("wallet-fp:"), seed])).digest("hex").slice(0, 16);
}

/* ---------------- BIP32 secp256k1 ---------------- */
const N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const hmac512 = (key, data) => crypto.createHmac("sha512", key).update(data).digest();
const ser32 = i => { const b = Buffer.alloc(4); b.writeUInt32BE(i >>> 0); return b; };
const toBuf32 = n => Buffer.from(n.toString(16).padStart(64, "0"), "hex");
function secpPub(priv, compressed) {
  const e = crypto.createECDH("secp256k1"); e.setPrivateKey(priv);
  return e.getPublicKey(null, compressed ? "compressed" : "uncompressed");
}
function bip32Master(seed) {
  const I = hmac512("Bitcoin seed", seed);
  return { key: I.subarray(0, 32), chain: I.subarray(32) };
}
function bip32Child(node, index) {
  const hardened = index >= 0x80000000;
  const data = Buffer.concat([hardened ? Buffer.concat([Buffer.from([0]), node.key]) : secpPub(node.key, true), ser32(index)]);
  const I = hmac512(node.chain, data);
  const k = (BigInt("0x" + I.subarray(0, 32).toString("hex")) + BigInt("0x" + node.key.toString("hex"))) % N;
  if (k === 0n || BigInt("0x" + I.subarray(0, 32).toString("hex")) >= N) throw new Error("BIP32_INVALID_CHILD");
  return { key: toBuf32(k), chain: I.subarray(32) };
}
export function bip32Derive(seed, path) {
  let node = bip32Master(seed);
  for (const part of path.replace(/^m\/?/, "").split("/").filter(Boolean)) {
    const hard = part.endsWith("'");
    const n = Number(hard ? part.slice(0, -1) : part);
    if (!Number.isInteger(n) || n < 0 || n >= 0x80000000) throw new Error("BAD_PATH");
    node = bip32Child(node, hard ? n + 0x80000000 : n);
  }
  return node;
}

/* ---------------- SLIP-10 ed25519 (Solana) ---------------- */
const ED_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
function slip10Derive(seed, path) {
  const I = hmac512("ed25519 seed", seed);
  let key = I.subarray(0, 32), chain = I.subarray(32);
  for (const part of path.replace(/^m\/?/, "").split("/").filter(Boolean)) {
    if (!part.endsWith("'")) throw new Error("SLIP10_HARDENED_ONLY");
    const n = Number(part.slice(0, -1));
    if (!Number.isInteger(n) || n < 0 || n >= 0x80000000) throw new Error("BAD_PATH");
    const J = hmac512(chain, Buffer.concat([Buffer.from([0]), key, ser32(n + 0x80000000)]));
    key = J.subarray(0, 32); chain = J.subarray(32);
  }
  return { key, chain };
}
function edPublic(priv) {
  const pk = crypto.createPrivateKey({ key: Buffer.concat([ED_PKCS8, priv]), format: "der", type: "pkcs8" });
  return Buffer.from(crypto.createPublicKey(pk).export({ format: "jwk" }).x, "base64url");
}

/* ---------------- addresses ---------------- */
export function evmAddressFromPub(uncompressed) {
  const hex = keccak256(uncompressed.subarray(1)).subarray(12).toString("hex");
  const hash = keccak256(Buffer.from(hex, "ascii")).toString("hex");   // EIP-55 checksum
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? hex[i].toUpperCase() : hex[i];
  return out;
}
export function tronAddressFromPub(uncompressed) {
  return base58check(Buffer.concat([Buffer.from([0x41]), keccak256(uncompressed.subarray(1)).subarray(12)]));
}

export const PATHS = {
  evm: i => `m/44'/60'/0'/0/${i}`,
  tron: i => `m/44'/195'/0'/0/${i}`,
  solana: i => `m/44'/501'/${i}'/0'`
};
export const KEY_NETWORKS = Object.keys(PATHS);

function checkIndex(i) {
  if (!Number.isInteger(i) || i < 0 || i >= 0x7fffffff) throw new Error("BAD_WALLET_INDEX");
}

// Public info only (safe to store / show).
export function deriveAddress(network, index, seed = masterSeed()) {
  checkIndex(index);
  const path = PATHS[network]?.(index);
  if (!path) throw new Error("UNKNOWN_NETWORK");
  if (network === "solana") return { network, path, address: base58(edPublic(slip10Derive(seed, path).key)) };
  const pub = secpPub(bip32Derive(seed, path).key, false);
  return { network, path, address: network === "evm" ? evmAddressFromPub(pub) : tronAddressFromPub(pub) };
}
export function deriveAllAddresses(index, seed = masterSeed()) {
  return KEY_NETWORKS.map(n => deriveAddress(n, index, seed));
}

// SECRET. Only for sweeping / signing withdrawals on the server. Never log, never return from an API.
export function derivePrivateKey(network, index, seed = masterSeed()) {
  checkIndex(index);
  const path = PATHS[network]?.(index);
  if (!path) throw new Error("UNKNOWN_NETWORK");
  return network === "solana" ? slip10Derive(seed, path).key : bip32Derive(seed, path).key;
}
