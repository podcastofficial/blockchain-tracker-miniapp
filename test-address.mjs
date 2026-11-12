// Run: node scripts/test-address.mjs   (no dependencies, no network)
import { keccak256, toChecksumEvm, isValidEvm, isValidTron, isValidSolana, extractAddresses, resolveChains } from "../lib/address.js";
let fail = 0; const t = (name, ok) => { if (!ok) fail++; console.log(ok ? "PASS" : "FAIL", name); };
t("keccak256('')", keccak256("") === "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
t("keccak256('abc')", keccak256("abc") === "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
for (const a of ["0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed","0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359","0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB","0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb"])
  t("EIP-55 " + a.slice(0, 10), toChecksumEvm(a) === a && isValidEvm(a));
t("EVM bad checksum rejected", !isValidEvm("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAEd"));
t("EVM all-lowercase accepted", isValidEvm("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"));
t("EVM wrong length rejected", !isValidEvm("0x5aaeb6053f3e94c9b9a09f33669435e7ef1bea"));
t("Tron USDT valid", isValidTron("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"));
t("Tron typo rejected", !isValidTron("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u"));
t("Solana wSOL valid", isValidSolana("So11111111111111111111111111111111111111112"));
t("Solana system program valid", isValidSolana("11111111111111111111111111111111"));
t("Solana random word rejected", !isValidSolana("abcdefghijklmnopqrstuvwxyzabcdefghij"));
const tx = "0x" + "ab".repeat(32);
t("tx hash not an address", extractAddresses(`tx ${tx}`).addresses.length === 0);
const r = extractAddresses("Wallet: 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed and TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t and So11111111111111111111111111111111111111112, again 0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed");
t("3 unique addresses, EVM deduped case-insensitively", r.addresses.length === 3 && r.addresses.map(a => a.family).join() === "evm,tron,solana");
t("bad-checksum EVM reported as invalid", extractAddresses("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAEd").invalid.length === 1);
t("address inside text_link entity", extractAddresses("click", [{ url: "https://etherscan.io/address/0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }]).addresses.length === 1);
t("cap at 5", extractAddresses(Array.from({ length: 8 }, (_, i) => "0x" + String(i + 1).repeat(40)).join(" ")).addresses.length === 5);
t("EVM default => ambiguous (never assumes Ethereum)", resolveChains("evm", []).status === "ambiguous");
t("EVM single enabled => resolved", resolveChains("evm", ["base", "solana"]).network === "base");
t("EVM not enabled", resolveChains("evm", ["solana"]).status === "not_enabled");
t("Tron resolved", resolveChains("tron", []).network === "tron");
console.log(fail ? `\n${fail} FAILED` : "\nall passed"); process.exit(fail ? 1 : 0);
