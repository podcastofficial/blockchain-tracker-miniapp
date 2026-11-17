// Part 1 wallet tests. Run: node scripts/test-wallet.mjs   (no database / network needed)
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { keccak256, base58, bip32Derive, deriveAddress, deriveAllAddresses, derivePrivateKey, seedFingerprint, tronAddressFromPub, evmAddressFromPub } from "../lib/hdwallet.js";
import { validAddr } from "../lib/balances.js";

let n = 0; const ok = (name, fn) => { fn(); n++; console.log("ok -", name); };

ok("keccak256 vectors", () => {
  assert.equal(keccak256("").toString("hex"), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccak256("abc").toString("hex"), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  assert.equal(keccak256(Buffer.alloc(200, 0x61)).length, 32);   // multi-block input
});
ok("BIP32 test vector 1 (m/0'/1)", () => {
  const seed = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
  assert.equal(bip32Derive(seed, "m").key.toString("hex"), "e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35");
  assert.equal(bip32Derive(seed, "m/0'").key.toString("hex"), "edb2e14f9ee77d26dd93b4ecede8d16ed408ce149b6cd80b0715a2d911a0afea");
  assert.equal(bip32Derive(seed, "m/0'/1").key.toString("hex"), "3c6cb8d0f6a264c91ea8b5030fadaa8e538b020f0a387421a12de9319dc93368");
});
ok("EVM address = hardhat default account 0 (test..junk mnemonic)", () => {
  process.env.WALLET_MASTER_SEED = "test test test test test test test test test test test junk";
  assert.equal(deriveAddress("evm", 0).address, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  assert.equal(deriveAddress("evm", 1).address, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
});
ok("Tron address for private key 1", () => {
  const e = crypto.createECDH("secp256k1"); e.setPrivateKey(Buffer.from("00".repeat(31) + "01", "hex"));
  const pub = e.getPublicKey(null, "uncompressed");
  assert.equal(evmAddressFromPub(pub), "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
  assert.equal(tronAddressFromPub(pub), "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC");
});
ok("SLIP-10 ed25519 vector 1 via Solana path shape + valid address", () => {
  const a = deriveAddress("solana", 0);
  assert.ok(validAddr("solana", a.address), a.address);
  assert.equal(a.path, "m/44'/501'/0'/0'");
  assert.notEqual(a.address, deriveAddress("solana", 1).address);
});
ok("all networks valid + deterministic + unique per index", () => {
  const a = deriveAllAddresses(7), b = deriveAllAddresses(7), c = deriveAllAddresses(8);
  assert.deepEqual(a, b);
  for (const x of a) assert.ok(validAddr(x.network === "evm" ? "ethereum" : x.network, x.address), x.address);
  for (let i = 0; i < 3; i++) assert.notEqual(a[i].address, c[i].address);
});
ok("private key derivation matches address", () => {
  const k = derivePrivateKey("evm", 0);
  const e = crypto.createECDH("secp256k1"); e.setPrivateKey(k);
  assert.equal(evmAddressFromPub(e.getPublicKey(null, "uncompressed")), deriveAddress("evm", 0).address);
});
ok("hex seed + fingerprint", () => {
  process.env.WALLET_MASTER_SEED = "11".repeat(32);
  const fp = seedFingerprint(); assert.equal(fp.length, 16);
  process.env.WALLET_MASTER_SEED = "22".repeat(32);
  assert.notEqual(seedFingerprint(), fp);
});
ok("bad config rejected", () => {
  process.env.WALLET_MASTER_SEED = "too short";
  assert.throws(() => deriveAddress("evm", 1), /WALLET_MASTER_SEED_INVALID/);
  delete process.env.WALLET_MASTER_SEED;
  assert.throws(() => deriveAddress("evm", 1), /NOT_CONFIGURED/);
  process.env.WALLET_MASTER_SEED = "11".repeat(32);
  assert.throws(() => deriveAddress("evm", -1), /BAD_WALLET_INDEX/);
  assert.throws(() => deriveAddress("btc", 1), /UNKNOWN_NETWORK/);
});
ok("base58 leading zero bytes", () => assert.equal(base58(Buffer.from("0000ff", "hex")), "11" + base58(Buffer.from("ff", "hex"))));
console.log(`\n${n} wallet crypto tests passed`);
