// Run: node scripts/test-templates.mjs — editable alert texts: rendering rules, validation, admin API, channel/onchain output.
// Database + network are stubbed (needs `npm install` so pg resolves).
process.env.DATABASE_URL = "postgres://localhost/x"; process.env.TELEGRAM_BOT_TOKEN = "T"; process.env.BOT_USERNAME = "mbc_bot";
import pg from "pg";
const store = new Map(), queries = [];
pg.Pool.prototype.query = async function (sql, p = []) {
  queries.push(sql);
  if (/SELECT key, text FROM alert_templates/.test(sql)) return { rows: [...store].map(([key, text]) => ({ key, text })), rowCount: store.size };
  if (/SELECT key, text, updated_at FROM alert_templates/.test(sql)) return { rows: [...store].map(([key, text]) => ({ key, text, updated_at: new Date() })), rowCount: store.size };
  if (/INSERT INTO alert_templates/.test(sql)) { store.set(p[0], p[1]); return { rows: [], rowCount: 1 }; }
  if (/DELETE FROM alert_templates/.test(sql)) { store.delete(p[0]); return { rows: [], rowCount: 1 }; }
  return { rows: [], rowCount: 0 };
};
const T = await import("../lib/templates.js");
const { templatesAdmin } = await import("../lib/templates_admin.js");
const { composePost } = await import("../lib/rich.js");
let fail = 0; const t = (n, ok) => { if (!ok) fail++; console.log(ok ? "PASS" : "FAIL", n); };

// ---- rendering ----
t("empty value hides its line", T.renderTemplate("A\nFee: {fee}\nB", { fee: "" }) === "A\nB");
t("optional {x?} keeps the line", T.renderTemplate("Price {p} {c?}", { p: "1" }) === "Price 1");
t("values are HTML-escaped", T.renderTemplate("{n}", { n: "<b>&" }) === "&lt;b&gt;&amp;");
t("H() values are inserted as is", T.renderTemplate("{n}", { n: T.H("<b>x</b>") }) === "<b>x</b>");
t("two separators in a row collapse", !/━{6,}\n━{6,}/.test(T.renderTemplate("a\n" + T.SEP + "\n{x}\n" + T.SEP + "\nb", { x: "" })));

// ---- every default is valid and renders with its sample ----
const keys = Object.keys(T.DEFAULT_TEMPLATES);
t("all " + keys.length + " built-in templates validate", keys.every(k => !T.validateTemplate(k, T.DEFAULT_TEMPLATES[k].text).error));
t("every template has sample data", keys.every(k => T.SAMPLES[k]));
t("every default fits one Telegram message", keys.every(k => T.renderTemplate(T.DEFAULT_TEMPLATES[k].text, T.SAMPLES[k]).length < 3500));

// ---- validation ----
t("unknown placeholder rejected", T.validateTemplate("tx", "{nope}").error === "UNKNOWN_PLACEHOLDER");
t("unclosed tag rejected", T.validateTemplate("tx", "<b>{hash}").error === "TEMPLATE_BAD_HTML");
t("script tag rejected", T.validateTemplate("tx", "<script>{hash}</script>").error === "TEMPLATE_BAD_HTML");
t("javascript: link rejected", T.validateTemplate("tx", '<a href="javascript:alert(1)">{hash}</a>').error === "TEMPLATE_BAD_HTML");
t("https link accepted", !T.validateTemplate("tx", '<a href="https://x.io">{hash}</a>').error);
t("raw < rejected", T.validateTemplate("tx", "a < b {hash}").error === "TEMPLATE_BAD_HTML");
t("empty / too long rejected", T.validateTemplate("tx", "  ").error === "TEMPLATE_EMPTY" && T.validateTemplate("tx", "x".repeat(3001)).error === "TEMPLATE_TOO_LONG");

// ---- admin API ----
const call = async (method, path, body) => new Promise(resolve => {
  const res = { _h: {}, setHeader() {}, status(c) { this.c = c; return this; }, json(b) { resolve({ status: this.c, body: b }); } };
  templatesAdmin({ method, body }, res, path, { id: 1, telegram_user_id: "111" }, async () => {}).then(handled => { if (!handled) resolve({ status: 0 }); });
});
let r = await call("GET", "/api/admin/templates");
t("list: every template with default, current text, placeholders and preview", r.status === 200 && r.body.templates.length === keys.length && r.body.templates.every(x => x.defaultText && x.preview && x.vars) && r.body.templates.every(x => !x.custom));
r = await call("POST", "/api/admin/template-save", { key: "whale", text: "🐋 <b>BIG MOVE</b> {amount} on {network}" });
t("save custom text", r.status === 200 && store.get("whale").includes("BIG MOVE") && /BIG MOVE/.test(r.body.preview));
r = await call("GET", "/api/admin/templates"); t("list marks it custom", r.body.templates.find(x => x.key === "whale").custom === true);
r = await call("POST", "/api/admin/template-save", { key: "whale", text: "<i>{bogus}</i>" });
t("invalid save refused, old text kept", r.status === 422 && r.body.error === "UNKNOWN_PLACEHOLDER" && store.get("whale").includes("BIG MOVE"));
r = await call("POST", "/api/admin/template-preview", { key: "whale", text: "Hi {amount}" }); t("preview does not save", r.status === 200 && r.body.preview === "Hi $56,901,513 USDC" && store.get("whale").includes("BIG MOVE"));
r = await call("POST", "/api/admin/template-save", { key: "whale", text: T.DEFAULT_TEMPLATES.whale.text }); t("saving the default text removes the override", r.status === 200 && !store.has("whale"));
await call("POST", "/api/admin/template-save", { key: "whale", text: "X {amount}" });
r = await call("POST", "/api/admin/template-reset", { key: "whale" }); t("reset restores the default", r.status === 200 && !store.has("whale") && r.body.text === T.DEFAULT_TEMPLATES.whale.text);
r = await call("POST", "/api/admin/template-save", { key: "nope", text: "x" }); t("unknown key → 404", r.status === 404);
r = await call("PUT", "/api/admin/template-save", {}); t("wrong method refused", r.status === 405);

// ---- used by the senders ----
store.set("whale", "🐋 CUSTOM {amount}"); T.clearTemplateCache();
const { scanRule } = await import("../lib/onchain.js");
globalThis.fetch = async (url, o = {}) => {
  const b = o.body ? JSON.parse(o.body) : {}, ok = result => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
  if (b.method === "eth_blockNumber") return ok("0x" + (1000).toString(16));
  if (b.method === "eth_getLogs") return ok([{ topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "0x" + "0".repeat(24) + "a".repeat(40), "0x" + "0".repeat(24) + "b".repeat(40)], data: "0x" + (BigInt(2_000_000) * 10n ** 6n).toString(16).padStart(64, "0"), transactionHash: "0x" + "c".repeat(64), logIndex: "0x1" }]);
  return { ok: false, status: 500, json: async () => ({}) };
};
const out = await scanRule({ kind: "whale", network: "ethereum", min_usd: 10000, state: { block: 990 } });
t("whale event carries a templated html text (custom)", out.events.length > 0 && /CUSTOM \$2,000,000/.test(out.events[0].html));
t("whale event keeps the plain summary for the Mini App history", /^🐋 Whale transfer on ethereum\n\$2,000,000/.test(out.events[0].summary));
store.delete("whale"); T.clearTemplateCache();
const out2 = await scanRule({ kind: "whale", network: "ethereum", min_usd: 10000, state: { block: 990 } });
t("whale event default layout", /Whale transfer<\/b> · 🔷 Ethereum/.test(out2.events[0].html) && /href="https:\/\/etherscan\.io\/tx\//.test(out2.events[0].html));

const list = [{ id: "bitcoin", symbol: "BTC", name: "Bitcoin", price: 100, rank: 1, c1h: 1, c4h: 2, c8h: 3, c24h: 4, spark: [] }];
const post = await composePost({ title: "x", list, template: "📈 <b>{network}</b>\n{coins}\n{more}\n{time}", vars: { network: "Crypto", time: "T" }, media: "none", buttons: false });
t("price post uses the template and the coin cards", /^📈 <b>Crypto<\/b>\n.*BTC/s.test(post.text) && /\nT$/.test(post.text));

console.log(fail ? fail + " FAILED" : "\nall passed"); process.exit(fail ? 1 : 0);
