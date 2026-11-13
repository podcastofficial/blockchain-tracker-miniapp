// Run: node scripts/test-community-api.mjs — API authorization/validation tests with stubbed DB + Telegram (needs `npm install` so pg resolves).
process.env.DATABASE_URL = "postgres://localhost/x"; process.env.TELEGRAM_BOT_TOKEN = "T"; process.env.BOT_USERNAME = "mbc_bot";
process.env.APP_SESSION_SECRET = "x".repeat(40);
import pg from "pg";
const { createSession } = await import("../lib/session.js");
const { communityApi, validateSettings } = await import("../lib/community_api.js");

const comms = { 1: { id: 1, chat_id: "-100", chat_type: "supergroup", title: "Alpha", username: null, status: "active", can_read_messages: true, can_post: true, added_at: new Date() },
                2: { id: 2, chat_id: "-200", chat_type: "channel", title: "Beta", username: "beta", status: "active", can_read_messages: true, can_post: true, added_at: new Date() } };
let q, settingsRow, tgStatus, tgNetDown, tgCalls;
const reset = () => { q = []; settingsRow = null; tgNetDown = false; tgCalls = []; tgStatus = { "-100:111": "administrator", "-100:222": "member", "-200:111": "member", "-200:333": "creator" }; };
pg.Pool.prototype.query = async function (sql, p = []) {
  q.push({ sql, p });
  if (/FROM communities WHERE id=\$1/.test(sql)) return { rows: comms[p[0]] ? [comms[p[0]]] : [], rowCount: comms[p[0]] ? 1 : 0 };
  if (/JOIN community_admins a ON a\.community_id=c\.id/.test(sql)) return { rows: p[0] === "111" ? [{ ...comms[1], addresses: 4, sent24h: 9 }] : [], rowCount: 1 };
  if (/FROM community_admins WHERE community_id=\$1 AND telegram_user_id=\$2/.test(sql)) return { rows: [], rowCount: p[1] === "111" && p[0] === 1 ? 1 : 0 };
  if (/FROM community_settings WHERE community_id/.test(sql)) return { rows: settingsRow ? [settingsRow] : [], rowCount: settingsRow ? 1 : 0 };
  if (/INSERT INTO community_settings/.test(sql)) { settingsRow = { ...(settingsRow || {}) }; const cols = sql.match(/\(community_id, ([^)]+)\) VALUES/)[1].split(", "); cols.forEach((c, i) => { settingsRow[c] = p[i + 1]; }); return { rows: [], rowCount: 1 }; }
  if (/FROM community_addresses WHERE community_id=\$1 GROUP BY status/.test(sql)) return { rows: [{ status: "active", n: 4 }, { status: "pending_chain", n: 1 }], rowCount: 2 };
  if (/FROM community_notifications WHERE community_id=\$1 AND created_at > NOW\(\) - INTERVAL '7 days' GROUP BY/.test(sql)) return { rows: [{ status: "sent", kind: "wallet", n: 5, n24: 2 }, { status: "sent", kind: "token", n: 3, n24: 1 }, { status: "dead", kind: "", n: 1, n24: 0 }], rowCount: 3 };
  if (/FROM community_usage/.test(sql)) return { rows: [{ hour_bucket: new Date(), scanned: 12, replies: 3, addresses: 4 }], rowCount: 1 };
  if (/FILTER \(WHERE status='retry'\)/.test(sql)) return { rows: [{ retrying: 1, dead: 1 }], rowCount: 1 };
  if (/ORDER BY hit_count DESC/.test(sql)) return { rows: [{ address: "0xabc", network: "base", kind: "token", hit_count: 7, last_seen_at: new Date() }], rowCount: 1 };
  if (/FROM community_addresses/.test(sql) && /LIMIT \$5 OFFSET \$6/.test(sql)) return { rows: [{ id: 1, address: "0xabc", status: "active" }], rowCount: 1 };
  if (/FROM community_audit_logs/.test(sql)) return { rows: [{ action: "settings.updated", actor: "111", metadata: {}, created_at: new Date() }], rowCount: 1 };
  if (/UPDATE community_addresses SET status='removed'/.test(sql)) return { rows: p[1] === 1 && p[0] === 5 ? [{ address_norm: "0xabc" }] : [], rowCount: p[1] === 1 && p[0] === 5 ? 1 : 0 };
  return { rows: [], rowCount: 1 };
};
globalThis.fetch = async (url, o = {}) => {
  const method = String(url).split("/").pop(), b = JSON.parse(o.body || "{}"); tgCalls.push({ method, ...b });
  if (tgNetDown) throw new Error("down");
  if (method === "getChatMember") { const st = tgStatus[b.chat_id + ":" + b.user_id]; return { json: async () => st ? { ok: true, result: { status: st } } : { ok: false, error_code: 400, description: "user not found" } }; }
  return { json: async () => ({ ok: true, result: true }) };
};

const call = async (method, path, { user = "111", body, noAuth } = {}) => {
  const req = { method, url: path, headers: {}, cookies: noAuth ? {} : { bt_session: createSession({ id: 1, telegram_user_id: user }) }, body, socket: { remoteAddress: "1.1.1.1" } };
  let out; const res = { setHeader() {}, status(c) { return { json: j => { out = { status: c, body: j }; } }; } };
  await communityApi(req, res, path.split("?")[0]); return out;
};
let fail = 0; const t = (n, ok) => { if (!ok) fail++; console.log(ok ? "PASS" : "FAIL", n); };
reset();

t("no session -> 401", (await call("GET", "/api/community", { noAuth: true })).status === 401);
let r = await call("GET", "/api/community");
t("list: only the caller's communities, bot username + network names included", r.status === 200 && r.body.communities.length === 1 && r.body.communities[0].title === "Alpha" && r.body.bot === "mbc_bot" && r.body.networks.base === "Base");
t("list: another user sees none", (await call("GET", "/api/community", { user: "999" })).body.communities.length === 0);
r = await call("GET", "/api/community/1/settings");
t("admin reads settings (defaults when no row)", r.status === 200 && r.body.settings.auto_detect === true && r.body.settings.max_notifications_per_hour === 30);
t("non-admin of that chat -> 404 (live check)", (await call("GET", "/api/community/1/settings", { user: "222" })).status === 404);
t("admin of ANOTHER chat cannot read this one", (await call("GET", "/api/community/2/stats", { user: "111" })).status === 404);
t("unknown community -> 404", (await call("GET", "/api/community/999/settings")).status === 404);
t("demoted admin: cached membership removed", q.some(x => /DELETE FROM community_admins/.test(x.sql)));
t("channel creator allowed", (await call("GET", "/api/community/2/settings", { user: "333" })).status === 200);

r = await call("POST", "/api/community/1/settings", { body: { auto_detect: false, networks: ["base", "solana"], dedupe_window_minutes: 30 } });
t("admin saves settings", r.status === 200 && r.body.settings.auto_detect === false && r.body.settings.networks.join() === "base,solana" && r.body.changed.length === 3);
const au = q.filter(x => /INSERT INTO community_audit_logs/.test(x.sql)).pop();
t("change written to the audit log with before/after", au && au.p[2] === "111" && au.p[3] === "settings.updated" && JSON.parse(au.p[4]).changes.auto_detect.from === true);
q.length = 0; r = await call("POST", "/api/community/1/settings", { body: { auto_detect: false } });
t("unchanged save writes nothing", r.status === 200 && r.body.changed.length === 0 && !q.some(x => /INSERT INTO community_(settings|audit)/.test(x.sql)));
t("non-admin cannot change settings", (await call("POST", "/api/community/1/settings", { user: "222", body: { auto_detect: false } })).status === 404);
for (const [name, body] of [["unknown network", { networks: ["dogechain"] }], ["window 0", { dedupe_window_minutes: 0 }], ["limit 601", { max_notifications_per_hour: 601 }], ["string bool", { auto_detect: "yes" }], ["float", { dedupe_window_minutes: 1.5 }], ["empty", {}]])
  t("rejects " + name, (await call("POST", "/api/community/1/settings", { body })).status === 400);
t("unknown fields ignored, not written", (await call("POST", "/api/community/1/settings", { body: { auto_detect: true, chat_id: 5, status: "active" } })).status === 200 && !q.some(x => /chat_id=EXCLUDED|status=EXCLUDED/.test(x.sql)));

tgNetDown = true;
t("Telegram unreachable: reads fall back to cached admin list", (await call("GET", "/api/community/1/settings")).status === 200);
t("Telegram unreachable: changes are refused (strict)", (await call("POST", "/api/community/1/settings", { body: { auto_detect: true } })).status === 404);
t("Telegram unreachable: unknown user not trusted", (await call("GET", "/api/community/1/settings", { user: "222" })).status === 404);
tgNetDown = false;

r = await call("GET", "/api/community/1/stats");
t("stats shape", r.status === 200 && r.body.stats.addresses.active === 4 && r.body.stats.notifications.sent7d === 8 && r.body.stats.notifications.sent24h === 3 && r.body.stats.notifications.byKind.token === 3 && r.body.stats.notifications.dead7d === 1 && r.body.stats.scanned24h === 12 && r.body.stats.queue.retrying === 1);
q.length = 0; await call("GET", "/api/community/1/addresses?status=active&network=base&q=50%25_x");
const aq = q.find(x => /LIMIT \$5 OFFSET \$6/.test(x.sql));
t("addresses: scoped to community id, LIKE wildcards escaped, parameterised", aq && aq.p[0] === 1 && aq.p[3] === "50\\%\\_x" && aq.p[1] === "active" && aq.p[2] === "base" && !/50%/.test(aq.sql));
q.length = 0; await call("GET", "/api/community/1/addresses?status=DROP&network=nope&offset=-5");
const bq = q.find(x => /LIMIT \$5 OFFSET \$6/.test(x.sql));
t("addresses: bad filters become null / offset clamped", bq.p[1] === null && bq.p[2] === null && bq.p[5] === 0);
t("audit list", (await call("GET", "/api/community/1/audit")).body.audit.length === 1);

r = await call("POST", "/api/community/1/control", { body: { action: "pause" } });
t("pause", r.status === 200 && r.body.status === "paused" && q.some(x => /UPDATE communities SET status=\$2/.test(x.sql) && x.p[1] === "paused"));
t("bad control action", (await call("POST", "/api/community/1/control", { body: { action: "explode" } })).status === 400);
tgCalls.length = 0; r = await call("POST", "/api/community/1/control", { body: { action: "disconnect" } });
t("disconnect: bot leaves the chat, audited", r.body.status === "disconnected" && tgCalls.some(c => c.method === "leaveChat" && c.chat_id === "-100"));
t("non-admin cannot disconnect", (await call("POST", "/api/community/1/control", { user: "222", body: { action: "disconnect" } })).status === 404);
q.length = 0; r = await call("POST", "/api/community/1/address-remove", { body: { addressId: 5 } });
t("remove address (scoped by community id in SQL)", r.status === 200 && q.some(x => /id=\$1 AND community_id=\$2/.test(x.sql)));
t("remove address from another community's id space -> 404", (await call("POST", "/api/community/1/address-remove", { body: { addressId: 6 } })).status === 404);
t("remove address: invalid id", (await call("POST", "/api/community/1/address-remove", { body: { addressId: "x" } })).status === 400);
t("GET on control route not allowed", (await call("GET", "/api/community/1/control")).status === 404);

pg.Pool.prototype.query = async () => { const e = new Error('relation "communities" does not exist'); e.code = "42P01"; throw e; };
r = await call("GET", "/api/community");
t("missing tables -> clear 503 COMMUNITY_NOT_SET_UP (not a generic 500)", r.status === 503 && r.body.error === "COMMUNITY_NOT_SET_UP");
const v = validateSettings({ networks: ["base", "base"] });
t("validateSettings dedupes networks", v.value.networks.length === 1);
console.log(fail ? `\n${fail} FAILED` : "\nall passed"); process.exit(fail ? 1 : 0);
