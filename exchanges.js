// Seed list of well-known Ethereum exchange wallets (lowercase). Extend/override with env:
// EXCHANGE_LABELS_JSON='{"0xabc...":"Exchange name"}'. Always double-check labels on Etherscan before relying on them.
const SEED = {
  "0x28c6c06298d514db089934071355e5743bf21d60": "Binance",
  "0x21a31ee1afc51d94c2efccaa2092ad1028285549": "Binance",
  "0xdfd5293d8e347dfe59e90efd55b2956a1343963d": "Binance",
  "0xf977814e90da44bfa03b6295a0616a897441acec": "Binance",
  "0x71660c4005ba85c37ccec55d0c4493e66fe775d3": "Coinbase",
  "0x503828976d22510aad0201ac7ec88293211d23da": "Coinbase",
  "0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0": "Kraken",
  "0x6cc5f688a315f3dc28a7781717a9a798a59fda7b": "OKX"
};
let extra = {};
try { extra = JSON.parse(process.env.EXCHANGE_LABELS_JSON || "{}"); } catch { /* ignore bad JSON */ }
const MAP = { ...SEED, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), String(v).slice(0, 30)])) };
export const labelOf = addr => MAP[String(addr || "").toLowerCase()] || null;
