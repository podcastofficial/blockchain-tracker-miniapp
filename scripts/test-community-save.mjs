// Run: node scripts/test-community-save.mjs — "Save to My Tracker" button, with stubbed DB + Telegram (needs `npm install` so pg resolves).
process.env.DATABASE_URL = "postgres://localhost/x"; process.env.TELEGRAM_BOT_TOKEN = "T"; process.env.BOT_USERNAME = "mbc_bot";
import pg from "pg";
const WALLET = "0xaeCc2d7A9A30366dA476c2408f6f42B1517Be36a", TOKEN = "0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D";
let users, notes, watch, answers, missingCol;
const reset = () => {
  users = { 111: { id: 1, is_blocked: false }, 222: { id: 2, is_blocked: true } }; watch = { 1: [] }; answers = []; missingCol = false;
  notes = { 7: { subject: { type: "address", family: "evm", address: WALLET, norm: WALLET.toLowerCase(), network: "bsc" }, result_kind: "wallet", display_name: null, chat_id: "-100" },
            8: { subject: { type: "address", family: "evm", address: TOKEN, norm: TOKEN.toLowerCase(), network: "bsc" }, result_kind: "token", display_name: "ARK", chat_id: "-100" },
            9: { subject: { type: "tx", family: "evm", hash: "0x" + "ab".repeat(32) }, result_kind: "tx", display_name: null, chat_id: "-100" } };
};
pg.Pool.prototype.query = async function (sql, p = []) {
  if (/FROM community_notifications n JOIN communities c/.test(sql)) {
    if (missingCol && /n\.display_name/.test(sql)) throw new Error('column "display_name" does not exist');
    const n = notes[p[0]]; return { rows: n ? [{ ...n, ...(/NULL AS display_name/.test(sql) ? { display_name: null } : {}) }] : [], rowCount: n ? 1 : 0 };
  }
  if (/FROM users WHERE telegram_user_id/.test(sql)) { const u = users[p[0]]; return { rows: u ? [u] : [], rowCount: u ? 1 : 0 }; }
  return { rows: [], rowCount: 0 };                                          // user_subscriptions: free plan
};
pg.Pool.prototype.connect = async () => ({
  release() {},
  query: async (sql, p = []) => {
    if (/SELECT items FROM user_watchlists/.test(sql)) return { rows: [{ items: watch[1] }], rowCount: 1 };
    if (/UPDATE user_watchlists SET items/.test(sql)) { watch[1] = JSON.parse(p[1]); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  }
});
globalThis.fetch = async (url, o = {}) => { const b = JSON.parse(o.body || "{}"); if (String(url).endsWith("answerCallbackQuery")) answers.push(b); return { json: async () => ({ ok: true, result: true }) }; };

const { handleSaveCallback, buildItem } = await import("../lib/community_save.js");
const { processCommunityCallback } = await import("../lib/community_track.js");
const { formatAddressNotification, formatTxNotification } = await import("../lib/community_notify.js");
let fail = 0; const t = (n, ok) => { if (!ok) fail++; console.log(ok ? "PASS" : "FAIL", n); };
const tap = (id, from = 111, chat = -100, data) => handleSaveCallback({ id: "cb" + Math.random(), data: data ?? "sv:" + id, from: { id: from }, message: { message_id: 5, chat: { id: chat, type: "channel" } } });
const last = () => answers[answers.length - 1];
reset();

await tap(7);
t("wallet saved to the tapper's watchlist (type wallet, Community category, readable name)", watch[1].length === 1 && watch[1][0].type === "wallet" && watch[1][0].network === "bsc" && watch[1][0].address === WALLET && watch[1][0].category === "Community" && /BNB Chain 0xaeCc…e36a/.test(watch[1][0].name) && /Saved/.test(last().text));
await tap(7);
t("second tap: no duplicate", watch[1].length === 1 && /Already/.test(last().text));
await tap(8);
t("token saved as a contract named after the token", watch[1].length === 2 && watch[1][1].type === "contract" && watch[1][1].name === "ARK" && watch[1][1].category === "Token");
t("entry has the same shape the app's watchlist expects", ["id", "type", "network", "address", "name", "category", "createdAt"].every(k => k in watch[1][1]) && watch[1][1].id === `contract:bsc:${TOKEN.toLowerCase()}`);
await tap(7, 999);
t("user without an account is told to open the Mini App once (alert)", /Open the Multi Blockchain Tracker Mini App/.test(last().text) && last().show_alert === true && watch[1].length === 2);
await tap(7, 222);
t("blocked user refused", /can't use/.test(last().text) && watch[1].length === 2);
const before = answers.length; await tap(7, 111, -999);
t("button pressed in a different chat is refused (no cross-chat use)", /no longer available/.test(last().text) && watch[1].length === 2 && answers.length === before + 1);
await tap(9);
t("transaction notifications cannot be saved", /no longer available/.test(last().text));
await tap(12345);
t("unknown notification id refused", /no longer available/.test(last().text));
const n0 = answers.length; await tap(0, 111, -100, "sv:abc; DROP");
t("malformed callback data ignored silently", answers.length === n0);
reset(); watch[1] = Array.from({ length: 10 }, (_, i) => ({ id: "w" + i, type: "wallet", network: "bsc", address: "0x" + String(i).repeat(40), name: "w", category: "x", createdAt: new Date().toISOString() }));
await tap(7);
t("free-plan wallet limit enforced", watch[1].length === 10 && /limit \(10\)/.test(last().text) && last().show_alert === true);
await tap(8);
t("limits are per type: contracts still allowed", watch[1].length === 11 && watch[1][10].type === "contract");
reset(); missingCol = true; await tap(8);
t("works before db/community_phase3b.sql is run (falls back to a generated name)", watch[1].length === 1 && /BNB Chain/.test(watch[1][0].name));
reset(); await processCommunityCallback({ id: "x", data: "sv:7", from: { id: 111 }, message: { message_id: 1, chat: { id: -100, type: "channel" } } });
t("routed through the community callback dispatcher", watch[1].length === 1);
t("buildItem: wallet vs token/contract mapping", buildItem(notes[7].subject, "wallet").type === "wallet" && buildItem(notes[8].subject, "token", "ARK").type === "contract" && buildItem(notes[8].subject, "contract").category === "Community");

// rate limiting (same user, rapid taps)
reset(); for (let i = 0; i < 12; i++) await tap(7, 111);
t("rapid tapping is rate limited", /Too many taps/.test(last().text));

// buttons
const d = kind => ({ kind, network: "bsc", address: WALLET, native: { symbol: "BNB", amount: 1, usd: 600 }, stables: [], notes: [], unavailable: [], source: [], updatedAt: new Date().toISOString(), token: null });
const kb = m => (m.reply_markup?.inline_keyboard || []).flat();
for (const k of ["wallet", "contract", "token"]) t(`${k} notification has Save button with callback sv:<id> (≤64 bytes)`, kb(formatAddressNotification(d(k), { notifId: 4242 })).some(b => b.callback_data === "sv:4242" && Buffer.byteLength(b.callback_data) <= 64));
t("no Save button when there is no notification id", !kb(formatAddressNotification(d("wallet"))).some(b => b.callback_data));
t("Explorer and Open Tracker buttons are still there", kb(formatAddressNotification(d("wallet"), { notifId: 1 })).some(b => /Explorer/.test(b.text)));
t("transaction notification has no Save button", !kb(formatTxNotification({ hash: "0x" + "a".repeat(64), network: "bsc", status: "success", updatedAt: new Date().toISOString() })).some(b => b.callback_data));
console.log(fail ? `\n${fail} FAILED` : "\nall passed"); process.exit(fail ? 1 : 0);
