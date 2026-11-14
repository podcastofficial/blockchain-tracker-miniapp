// Run: node scripts/test-community.mjs — end-to-end test of detection -> queue -> enrichment -> Telegram, with the database,
// Telegram API and data providers stubbed (needs `npm install` so pg resolves). No network access.
process.env.DATABASE_URL = "postgres://localhost/x"; process.env.TELEGRAM_BOT_TOKEN = "T"; process.env.BOT_USERNAME = "mbc_bot";
import pg from "pg";

// ---------- stub database ----------
const base = { id: 1, chat_id: -100, chat_type: "supergroup", status: "active", can_post: true, auto_detect: true, command_detect: true, networks: [], dedupe_window_minutes: 60,
  max_notifications_per_hour: 30, detect_wallets: true, detect_contracts: true, detect_tokens: true };
let community, notifs, keys, replies, recentSeen, nextId, adminUpserts = 0;
const reset = (over = {}) => { community = { ...base, ...over }; notifs = []; keys = new Set(); replies = 0; recentSeen = false; nextId = 1; sent.length = 0; tgMode = "ok"; rpcFail = false; };
pg.Pool.prototype.query = async function (sql, p = []) {
  if (/WHERE c\.chat_id=\$1/.test(sql)) return { rows: [community], rowCount: 1 };
  if (/WHERE c\.id=\$1/.test(sql)) return { rows: [community], rowCount: 1 };
  if (/INSERT INTO community_usage/.test(sql) && /RETURNING replies/.test(sql)) return { rows: [{ replies: ++replies }], rowCount: 1 };
  if (/INSERT INTO community_usage/.test(sql)) return { rows: [], rowCount: 1 };
  if (/INSERT INTO community_addresses/.test(sql)) return { rows: [{ id: 7, is_new: !recentSeen, status: "active", prev_seen: recentSeen ? new Date() : null }], rowCount: 1 };
  if (/INSERT INTO community_notifications/.test(sql)) {
    if (keys.has(p[1])) return { rows: [], rowCount: 0 }; keys.add(p[1]);
    const n = { id: nextId++, community_id: p[0], dedupe_key: p[1], subject: JSON.parse(p[2]), mode: p[3], reply_to_message_id: p[4], status: "pending", attempts: 0, next_attempt_at: 0 };
    notifs.push(n); return { rows: [{ id: n.id }], rowCount: 1 };
  }
  if (/SET status='sending'/.test(sql)) {
    const n = notifs.find(x => (p[0] === null || x.id === Number(p[0])) && ["pending", "retry"].includes(x.status) && x.next_attempt_at <= Date.now());
    if (!n) return { rows: [], rowCount: 0 }; n.status = "sending"; n.attempts++; return { rows: [{ ...n }], rowCount: 1 };
  }
  if (/SET status='suppressed', last_error='rate_limited'/.test(sql)) { notifs.find(x => x.id === p[0]).status = "suppressed"; return { rows: [], rowCount: 1 }; }
  if (/SET status='retry'/.test(sql)) { const n = notifs.find(x => x.id === p[0]); n.status = "retry"; n.next_attempt_at = Date.now() + Number(p[1]) * 1000; n.last_error = p[2]; return { rows: [], rowCount: 1 }; }
  if (/UPDATE community_notifications SET status=\$2/.test(sql)) { const n = notifs.find(x => x.id === p[0]); n.status = p[1]; n.last_error = p[2]; if (p[3]) n.kind = p[3]; return { rows: [], rowCount: 1 }; }
  if (/SELECT status FROM community_notifications WHERE id=\$1/.test(sql)) { const n = notifs.find(x => x.id === p[0]); return { rows: n ? [{ status: n.status }] : [], rowCount: n ? 1 : 0 }; }
  if (/INSERT INTO community_admins/.test(sql)) { adminUpserts++; return { rows: [], rowCount: 1 }; }
  if (/SET can_post=FALSE/.test(sql)) { community.can_post = false; return { rows: [], rowCount: 1 }; }
  if (/SELECT \* FROM community_addresses WHERE id=/.test(sql)) return { rows: [{ id: 7, family: "evm", address: EVM, address_norm: EVM.toLowerCase(), network: null, submitted_by_telegram_id: 5, status: "pending_chain" }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
};
pg.Pool.prototype.connect = async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release() {} });

// ---------- stub Telegram + providers ----------
const sent = []; let tgMode = "ok", rpcFail = false, contractAddr = "", walletOnly = true;
const abiStr = s => "0x" + "20".padStart(64, "0") + s.length.toString(16).padStart(64, "0") + Buffer.from(s).toString("hex").padEnd(64, "0");
const json = (data, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => data });
globalThis.fetch = async (url, o = {}) => {
  url = String(url);
  if (url.includes("api.telegram.org")) {
    const b = JSON.parse(o.body), method = url.split("/").pop(); sent.push({ method, ...b });
    if (method === "deleteMessage" && deleteDenied) return json({ ok: false, error_code: 400, description: "message can't be deleted" });
    if (method === "getChatMember") return json({ ok: true, result: { status: b.user_id === 5 ? "administrator" : "member" } });
    if (method !== "sendMessage") return json({ ok: true, result: true });
    if (tgMode === "500") return json({ ok: false, error_code: 500, description: "Internal Server Error" });
    if (tgMode === "kicked") return json({ ok: false, error_code: 403, description: "Forbidden: bot was kicked from the supergroup chat" });
    return json({ ok: true, result: { message_id: 555 } });
  }
  if (url.includes("dexscreener.com")) return rpcFail ? json({}, false) : json(url.includes(contractAddr) && contractAddr ? [{ chainId: "base", dexId: "x", pairAddress: "0xpair", url: "https://dexscreener.com/base/0xpair",
    baseToken: { address: contractAddr, name: "Test Token", symbol: "TST" }, quoteToken: { address: "0x1", symbol: "WETH" }, priceUsd: "0.5", liquidity: { usd: 5000 }, volume: { h24: 12345 },
    marketCap: 1000000, pairCreatedAt: Date.now() - 3 * 3600000, priceChange: { h24: 3.2 } }] : []);
  if (url.includes("coingecko")) return json({ ethereum: { usd: 2000, usd_24h_change: 1 }, binancecoin: { usd: 300 }, "matic-network": { usd: 1 }, "avalanche-2": { usd: 30 }, tron: { usd: 0.1 }, solana: { usd: 150 }, "the-open-network": { usd: 5 } });
  if (url.includes("trongrid")) return json(url.includes("getcontract") ? {} : { data: [{ balance: 5e6, trc20: [] }] });
  if (o.body && url.startsWith("http")) {
    if (rpcFail) return json({}, false);
    const b = JSON.parse(o.body), r = result => json({ jsonrpc: "2.0", id: 1, result });
    switch (b.method) {
      case "eth_getCode": return r(b.params[0].toLowerCase() === contractAddr.toLowerCase() && contractAddr ? "0x6080604052" : "0x");
      case "eth_getBalance": return r("0x" + (1.5e18).toString(16));
      case "eth_call": { const d = b.params[0].data; if (d.startsWith("0x70a08231")) return r("0x0"); return r(d.startsWith("0x95d89b41") ? abiStr("TST") : d.startsWith("0x06fdde03") ? abiStr("Test Token") : "0x" + (18).toString(16).padStart(64, "0")); }
      case "eth_getTransactionByHash": return r(b.params[0] === HASH && url.includes("publicnode.com") && url.includes("ethereum") ? { from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", value: "0x" + (2e18).toString(16), blockNumber: "0x10" } : null);
      case "eth_getTransactionReceipt": return r({ status: "0x1", blockNumber: "0x10" });
      case "eth_getBlockByNumber": return r({ timestamp: "0x" + Math.floor(Date.UTC(2026, 10, 13, 12, 30) / 1000).toString(16) });
    }
  }
  return json({}, false);
};

const { processCommunityMessage, processCommunityCallback } = await import("../lib/community_track.js");
const { processNotification, processQueue, fmtUsd, riskNotes, MAX_ATTEMPTS } = await import("../lib/community_notify.js");
const { decodeAbiString } = await import("../lib/community_enrich.js");
let deleteDenied = false;
let fail = 0; const t = (n, ok) => { if (!ok) fail++; console.log(ok ? "PASS" : "FAIL", n); };
const msg = (text, extra = {}) => ({ message_id: 42, chat: { id: -100, type: "supergroup" }, from: { id: 5 }, text, ...extra });
const msgs = () => sent.filter(s => s.method === "sendMessage");
const EVM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", TOKEN2 = "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb", TRON = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", TOKEN = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const HASH = "0x" + "ab".repeat(32);

// ---------- pure helpers ----------
t("fmtUsd", fmtUsd(1234.5) === "$1,235" && fmtUsd(0.5) === "$0.500" && fmtUsd(null) === "unavailable");
t("decodeAbiString dynamic + bytes32", decodeAbiString(abiStr("TST")) === "TST" && decodeAbiString("0x" + Buffer.from("MKR").toString("hex").padEnd(64, "0")) === "MKR");
t("riskNotes flags are facts, not verdicts", riskNotes({ liquidity: 5000, created: Date.now() - 3600000, websites: [], socials: [] }).length === 3 && riskNotes(null).length === 0);

// ---------- flows ----------
reset({ networks: ["ethereum"] });
await processCommunityMessage(msg("/track " + EVM));
t("wallet: posted to originating chat with balance + explorer link", msgs().length === 1 && msgs()[0].chat_id === -100 && /Wallet detected/.test(msgs()[0].text) && /1\.5 ETH \(~\$3,000\)/.test(msgs()[0].text) && /etherscan\.io\/address/.test(JSON.stringify(msgs()[0].reply_markup)));
t("wallet: attribution + no safety claim", /Powered by Multi Blockchain Tracker/.test(msgs()[0].text) && /not a safety verdict/.test(msgs()[0].text));
t("notification marked sent", notifs[0].status === "sent" && notifs[0].kind === "wallet");

reset({ networks: ["base"] }); contractAddr = TOKEN;
await processCommunityMessage(msg("/track " + TOKEN));
t("token: name, price, liquidity, notes and Token Details button", /Token detected/.test(msgs()[0].text) && /Test Token<\/b> \(TST\)/.test(msgs()[0].text) && /Liquidity:<\/b> \$5,000/.test(msgs()[0].text) && /Low liquidity/.test(msgs()[0].text) && /Token Details/.test(JSON.stringify(msgs()[0].reply_markup)));
t("token: replies to the original message", msgs()[0].reply_to_message_id === 42);

reset({ networks: ["base"] }); rpcFail = true; contractAddr = TOKEN2;
await processCommunityMessage(msg("/track " + TOKEN2));
t("provider outage: still posts, marks data unavailable, invents nothing", msgs().length === 1 && /Unavailable right now/.test(msgs()[0].text) && !/Price:/.test(msgs()[0].text));
rpcFail = false; contractAddr = TOKEN;

reset({ networks: ["tron"] }); contractAddr = "";
await processCommunityMessage(msg("/track " + TRON));
t("tron wallet via /track", /Wallet detected/.test(msgs()[0].text) && /Tron/.test(msgs()[0].text) && /5 TRX/.test(msgs()[0].text));

reset(); contractAddr = "";
await processCommunityMessage(msg("/track " + EVM));
t("ambiguous EVM: asks for network, nothing queued", msgs().length === 1 && /Which network/.test(msgs()[0].text) && notifs.length === 0);
sent.length = 0;
await processCommunityCallback({ id: "cb1", data: "cm:7:base", from: { id: 5 }, message: { message_id: 77, chat: { id: -100, type: "supergroup" }, reply_to_message: { message_id: 42 } } });
t("network choice: details posted as a reply to the member's ORIGINAL message", msgs().length === 1 && /Wallet detected/.test(msgs()[0].text) && /Base/.test(msgs()[0].text) && msgs()[0].reply_to_message_id === 42);
const iSend = sent.findIndex(s => s.method === "sendMessage"), iDel = sent.findIndex(s => s.method === "deleteMessage");
t("network choice: 'loading details…' prompt is deleted AFTER the details are posted", iDel > iSend && iSend >= 0 && sent[iDel].message_id === 77 && sent[iDel].chat_id === -100);
reset(); tgMode = "500";
await processCommunityCallback({ id: "cb2", data: "cm:7:base", from: { id: 5 }, message: { message_id: 78, chat: { id: -100, type: "supergroup" }, reply_to_message: { message_id: 42 } } });
t("if posting failed the prompt is NOT deleted; it says details are coming", !sent.some(s => s.method === "deleteMessage") && sent.some(s => s.method === "editMessageText" && s.message_id === 78 && /shortly/.test(s.text)));
reset(); deleteDenied = true;
await processCommunityCallback({ id: "cb3", data: "cm:7:base", from: { id: 5 }, message: { message_id: 79, chat: { id: -100, type: "supergroup" } } });
t("no permission to delete: prompt is edited to a short 'Done' instead; no original message -> plain post", sent.some(s => s.method === "editMessageText" && s.message_id === 79 && /Done/.test(s.text)) && msgs()[0].reply_to_message_id === undefined);
deleteDenied = false; reset();

reset({ networks: ["ethereum", "base"] });
await processCommunityMessage(msg("/tx " + HASH));
t("tx hash: found on the right chain, status, amount, block time", /Transaction/.test(msgs()[0].text) && /Ethereum/.test(msgs()[0].text) && /Success/.test(msgs()[0].text) && /2 ETH/.test(msgs()[0].text) && /2026-11-13 12:30 UTC/.test(msgs()[0].text) && /etherscan\.io\/tx/.test(JSON.stringify(msgs()[0].reply_markup)));
reset({ networks: ["ethereum"] }); sent.length = 0;
await processCommunityMessage(msg("/tx 0x" + "cd".repeat(32)));
t("tx hash not found: says so plainly", /wasn't found/.test(msgs()[0].text));

// duplicates / retries
reset({ networks: ["ethereum"] });
await processCommunityMessage(msg("/track " + EVM, { message_id: 1 })); recentSeen = true;
await processCommunityMessage(msg("/track " + EVM, { message_id: 2 }));
t("command: a repeat of the same address is still answered", msgs().length === 2);
await processCommunityMessage(msg("/track " + EVM, { message_id: 2 }));
t("same message can never post twice (dedupe key)", msgs().length === 2);

// COMMAND-ONLY: normal messages are never scanned
reset({ networks: ["ethereum"] });
await processCommunityMessage(msg("look at this " + EVM)); await processCommunityMessage(msg(HASH)); await processCommunityMessage(msg(EVM, { chat: { id: -100, type: "channel" }, from: undefined }));
t("plain message / channel post with an address or tx hash: ignored (no reply, nothing queued)", msgs().length === 0 && notifs.length === 0);
reset({ networks: ["ethereum"], auto_detect: true });
await processCommunityMessage(msg("wallet " + EVM));
t("even with the old auto_detect flag on, nothing is scanned", msgs().length === 0 && notifs.length === 0);
reset({ networks: ["ethereum"] });
await processCommunityMessage(msg("/track", { reply_to_message: { message_id: 40, text: "send funds to " + EVM } }));
t("/track as a reply uses the address from the replied message", msgs().length === 1 && /Wallet detected/.test(msgs()[0].text) && msgs()[0].reply_to_message_id === 42);
reset({ networks: ["ethereum"] });
await processCommunityMessage(msg("/tx", { reply_to_message: { message_id: 40, text: "hash " + HASH } }));
t("/tx as a reply uses the hash from the replied message", msgs().length === 1 && /Transaction/.test(msgs()[0].text));
reset({ networks: ["ethereum"] });
await processCommunityMessage(msg("/track"));
t("/track with nothing to look up: shows usage, no lookup", msgs().length === 1 && /Usage: \/track/.test(msgs()[0].text) && notifs.length === 0);

reset({ networks: ["ethereum"] }); tgMode = "500";
await processCommunityMessage(msg("/track " + EVM));
t("telegram 500: kept for retry with backoff, not lost", notifs[0].status === "retry" && notifs[0].attempts === 1 && notifs[0].next_attempt_at > Date.now());
t("not retried before its time", (await processQueue(500)).processed === 0 && notifs[0].attempts === 1);
tgMode = "ok"; notifs[0].next_attempt_at = 0; sent.length = 0;
await processQueue(2000);
t("worker retry delivers it exactly once", notifs[0].status === "sent" && notifs[0].attempts === 2 && msgs().length === 1);

reset({ networks: ["ethereum"] }); tgMode = "500";
await processCommunityMessage(msg("/track " + EVM));
for (let i = 0; i < MAX_ATTEMPTS; i++) { notifs[0].next_attempt_at = 0; await processQueue(500); }
t("dead-letter after max attempts", notifs[0].status === "dead" && notifs[0].attempts === MAX_ATTEMPTS);

reset({ networks: ["ethereum"] }); tgMode = "kicked";
await processCommunityMessage(msg("/track " + EVM));
t("bot kicked: dead immediately, posting disabled", notifs[0].status === "dead" && community.can_post === false);

// limits / settings
reset({ networks: ["ethereum"], max_notifications_per_hour: 1 });
await processCommunityMessage(msg("/track " + EVM, { message_id: 1 })); await processCommunityMessage(msg("/track " + EVM, { message_id: 2 }));
t("hourly limit: second notification suppressed", msgs().length === 1 && notifs[1].status === "suppressed");
reset({ networks: ["ethereum"], detect_wallets: false });
await processCommunityMessage(msg("/track " + EVM, { message_id: 9 }));
t("wallet type toggle off: explicit /track still answers", msgs().length === 1);
reset({ networks: ["ethereum"] });
await processCommunityMessage(msg("/track " + EVM)); sent.length = 0; community.status = "paused"; notifs.push({ id: 99, community_id: 1, subject: { type: "address", family: "evm", address: EVM, network: "ethereum" }, mode: "auto", status: "pending", attempts: 0, next_attempt_at: 0 });
await processNotification(99);
t("queued notification dropped if community was paused meanwhile", notifs.find(n => n.id === 99).status === "suppressed" && msgs().length === 0);
reset(); await processCommunityMessage(msg("/track " + EVM, { from: { id: 9, is_bot: true } }));
t("bot-authored message ignored (no loops)", notifs.length === 0 && msgs().length === 0);
reset();
await processCommunityMessage(msg("/settings"));
t("/settings by an admin: replies with an Open settings link and remembers the admin", msgs().length === 1 && /Open settings/.test(JSON.stringify(msgs()[0].reply_markup)) && /startapp=cm_1/.test(JSON.stringify(msgs()[0].reply_markup)) && adminUpserts === 1);
reset(); await processCommunityMessage(msg("/settings", { from: { id: 77 } }));
t("/settings by a non-admin is refused", msgs().length === 1 && /Only chat admins/.test(msgs()[0].text) && !/Open settings/.test(JSON.stringify(msgs()[0])));
console.log(fail ? `\n${fail} FAILED` : "\nall passed"); process.exit(fail ? 1 : 0);
