// Community Crypto Monitor — Phase 2: pure address engine (no network, no database).
// Strict validators (EIP-55 checksum, Tron base58check, Solana 32-byte), candidate extraction, chain resolution, explorer links.
import crypto from "node:crypto";

// ---- Keccak-256 (Ethereum's hash; node:crypto only ships NIST SHA3, which differs by padding) ----
const M64 = (1n << 64n) - 1n;
const rotl = (x, n) => n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64;
const ROT = [0,1,62,28,27, 36,44,6,55,20, 3,10,43,25,39, 41,45,15,21,8, 18,2,61,56,14];
const RC = (() => { const out = []; let R = 1; for (let i = 0; i < 24; i++) { let c = 0n; for (let j = 0; j < 7; j++) { R = ((R << 1) ^ ((R >> 7) * 0x71)) % 256; if (R & 2) c ^= 1n << BigInt((1 << j) - 1); } out.push(c); } return out; })();
function keccakF(A) {
  for (let r = 0; r < 24; r++) {
    const C = [], B = new Array(25);
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let x = 0; x < 5; x++) { const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1); for (let y = 0; y < 25; y += 5) A[x + y] ^= D; }
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x + 5 * y]);
    for (let y = 0; y < 25; y += 5) for (let x = 0; x < 5; x++) A[x + y] = B[x + y] ^ ((~B[(x + 1) % 5 + y] & M64) & B[(x + 2) % 5 + y]);
    A[0] ^= RC[r];
  }
}
export function keccak256(input) {
  const msg = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input), rate = 136;
  const padded = Buffer.alloc(Math.ceil((msg.length + 1) / rate) * rate); msg.copy(padded); padded[msg.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
  const A = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) { for (let i = 0; i < rate / 8; i++) A[i] ^= padded.readBigUInt64LE(off + i * 8); keccakF(A); }
  const out = Buffer.alloc(32); for (let i = 0; i < 4; i++) out.writeBigUInt64LE(A[i], i * 8);
  return out.toString("hex");
}

// ---- Base58 ----
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58decode(s) {
  let n = 0n; for (const c of s) { const i = B58.indexOf(c); if (i < 0) return null; n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = "0" + hex;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  let zeros = 0; while (zeros < s.length && s[zeros] === "1") zeros++;
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

// ---- Validators ----
export function toChecksumEvm(addr) {
  const a = addr.toLowerCase().replace(/^0x/, ""), h = keccak256(a);
  return "0x" + [...a].map((c, i) => parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c).join("");
}
// All-lowercase / all-uppercase hex is accepted (no checksum claimed); mixed case MUST match EIP-55.
export function isValidEvm(a) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(a)) return false;
  const body = a.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return toChecksumEvm(a) === a;
}
export function isValidTron(a) {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return false;
  const raw = b58decode(a); if (!raw || raw.length !== 25 || raw[0] !== 0x41) return false;
  const sum = crypto.createHash("sha256").update(crypto.createHash("sha256").update(raw.subarray(0, 21)).digest()).digest();
  return sum.subarray(0, 4).equals(raw.subarray(21));
}
export function isValidSolana(a) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return false;
  const raw = b58decode(a); return !!raw && raw.length === 32;
}

// ---- Networks (plan targets: Ethereum, BNB Chain, Polygon, Arbitrum, Base, Solana, Tron) ----
export const NETWORKS = {
  ethereum: { name: "Ethereum",  family: "evm",    addr: "https://etherscan.io/address/",  tx: "https://etherscan.io/tx/" },
  bsc:      { name: "BNB Chain", family: "evm",    addr: "https://bscscan.com/address/",   tx: "https://bscscan.com/tx/" },
  polygon:  { name: "Polygon",   family: "evm",    addr: "https://polygonscan.com/address/", tx: "https://polygonscan.com/tx/" },
  arbitrum: { name: "Arbitrum",  family: "evm",    addr: "https://arbiscan.io/address/",   tx: "https://arbiscan.io/tx/" },
  base:     { name: "Base",      family: "evm",    addr: "https://basescan.org/address/",  tx: "https://basescan.org/tx/" },
  tron:     { name: "Tron",      family: "tron",   addr: "https://tronscan.org/#/address/", tx: "https://tronscan.org/#/transaction/" },
  solana:   { name: "Solana",    family: "solana", addr: "https://solscan.io/account/",    tx: "https://solscan.io/tx/" }
};
export const NET_CODES = Object.keys(NETWORKS);
export const explorerAddrLink = (net, a) => NETWORKS[net] ? NETWORKS[net].addr + a : null;

// ---- Candidate extraction ----
// Looks in message text/caption plus URLs carried by entities (text_link). Never matches inside longer alphanumeric tokens,
// so 64-hex transaction hashes are not mistaken for addresses.
const B = "(?<![A-Za-z0-9])", E = "(?![A-Za-z0-9])";
const RE = {
  evm: new RegExp(`${B}0x[a-fA-F0-9]{40}${E}`, "g"),
  tron: new RegExp(`${B}T[1-9A-HJ-NP-Za-km-z]{33}${E}`, "g"),
  solana: new RegExp(`${B}[1-9A-HJ-NP-Za-km-z]{32,44}${E}`, "g")
};
export const MAX_ADDRESSES_PER_MESSAGE = 5;
export function extractAddresses(text, entities = []) {
  const urls = (entities || []).map(e => e.url).filter(Boolean).join(" ");
  const src = `${text || ""} ${urls}`.slice(0, 8000);
  const found = new Map(), invalid = [];
  const add = (family, raw) => {
    const key = family === "evm" ? raw.toLowerCase() : raw;
    if (found.has(family + key)) return;
    const ok = { evm: isValidEvm, tron: isValidTron, solana: isValidSolana }[family](raw);
    if (ok) found.set(family + key, { family, address: family === "evm" ? raw : raw, norm: key });
    else if (family === "evm") invalid.push(raw); // looked like 0x + 40 hex but failed the checksum: worth telling the submitter
  };
  for (const m of src.matchAll(RE.evm)) add("evm", m[0]);
  for (const m of src.matchAll(RE.tron)) if (isValidTron(m[0])) add("tron", m[0]);
  for (const m of src.matchAll(RE.solana)) if (!found.has("tron" + m[0]) && isValidSolana(m[0])) add("solana", m[0]);
  const list = [...found.values()];
  return { addresses: list.slice(0, MAX_ADDRESSES_PER_MESSAGE), truncated: list.length > MAX_ADDRESSES_PER_MESSAGE, invalid: invalid.slice(0, 3) };
}

// ---- Chain resolution ----
// enabled = community's selected networks (empty = every supported network). Never assumes Ethereum for a 0x address.
export function resolveChains(family, enabled = []) {
  const on = enabled?.length ? enabled.filter(n => NETWORKS[n]) : NET_CODES;
  const candidates = on.filter(n => NETWORKS[n].family === family);
  if (!candidates.length) return { status: "not_enabled", candidates: [] };
  if (candidates.length === 1) return { status: "resolved", network: candidates[0], candidates };
  return { status: "ambiguous", candidates };
}

// ---- Transaction hashes ----
// EVM: 0x + 64 hex. Solana: base58 signature (64 bytes). Tron: 64 hex WITHOUT 0x — too generic to scan automatically
// (any SHA-256 looks like one), so it is only returned when allowPlainHex is set (explicit /track or /tx commands).
const TXRE = {
  evm: new RegExp(`${B}0x[a-fA-F0-9]{64}${E}`, "g"),
  solana: new RegExp(`${B}[1-9A-HJ-NP-Za-km-z]{86,88}${E}`, "g"),
  hex64: new RegExp(`${B}[a-fA-F0-9]{64}${E}`, "g")
};
export function extractTxHashes(text, { allowPlainHex = false, max = MAX_ADDRESSES_PER_MESSAGE } = {}) {
  const src = String(text || "").slice(0, 8000), seen = new Set(), out = [];
  const add = (family, hash, norm) => { const k = family + norm; if (!seen.has(k)) { seen.add(k); out.push({ family, hash, norm }); } };
  for (const m of src.matchAll(TXRE.evm)) add("evm", m[0], m[0].toLowerCase());
  for (const m of src.matchAll(TXRE.solana)) { const raw = b58decode(m[0]); if (raw && raw.length === 64) add("solana", m[0], m[0]); }
  if (allowPlainHex) for (const m of src.matchAll(TXRE.hex64)) add("tron", m[0], m[0].toLowerCase());
  return out.slice(0, max);
}
export const explorerTxLink = (net, h) => NETWORKS[net] ? NETWORKS[net].tx + h : null;
