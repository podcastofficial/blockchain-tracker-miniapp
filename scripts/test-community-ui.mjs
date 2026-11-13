// Run: node scripts/test-community-ui.mjs — runs the Community Monitor page script from index.html against a stub DOM + stub API (no browser needed).
import fs from "node:fs"; import vm from "node:vm";
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const code = scripts.find(s => s.includes("Community Monitor page (Phase 4)"));
let fail = 0; const t = (n, ok) => { if (!ok) fail++; console.log(ok ? "PASS" : "FAIL", n); };
t("page section, sidebar entry, dashboard card and breadcrumb label exist", /id="page-community"/.test(html) && /data-page="community"><span class="nav-icon">/.test(html) && /class="quick" data-page="community"/.test(html) && /community:"Community Monitor"/.test(html));
const ids = [...html.matchAll(/\bid="(cm[A-Za-z]+)"/g)].map(m => m[1]); t("element ids unique", new Set(ids).size === ids.length);

class El { constructor(id) { this.id = id; this.innerHTML = ""; this.textContent = ""; this.value = ""; this.checked = false; this.style = {}; this.dataset = {}; this.disabled = false; this.classList = { toggle() {}, contains: () => false }; } scrollIntoView() {} }
const els = {}; const getEl = id => els[id] || (els[id] = new El(id));
let clickHandler, netBoxes = [], posted = [], rejectWith = null, confirmAnswer = true, opened = [];
const evil = '<img src=x onerror=alert(1)>';
const data = {
  "/community": { ok: true, bot: "mbc_bot", networks: { ethereum: "Ethereum", base: "Base" }, communities: [{ id: 1, chatId: "-100", type: "supergroup", title: evil, username: null, status: "active", canRead: false, canPost: true, addresses: 4, sent24h: 9 }] },
  "/community/1/stats": { ok: true, stats: { addresses: { active: 4, pending_chain: 1, removed: 0 }, notifications: { sent24h: 3, sent7d: 8, suppressed7d: 2, dead7d: 1, byKind: { wallet: 5, tx: 3 } }, queue: { retrying: 1, dead: 1 }, hourly: [{ hour: new Date().toISOString(), scanned: 12, replies: 3, addresses: 4 }], scanned24h: 12, top: [{ address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", network: "base", kind: "wallet", hit_count: 7 }] } },
  "/community/1/settings": { ok: true, settings: { auto_detect: true, command_detect: false, detect_wallets: true, detect_contracts: true, detect_tokens: false, networks: ["base"], dedupe_window_minutes: 60, max_notifications_per_hour: 30 } },
  "/community/1/audit": { ok: true, audit: [{ action: "settings.updated", actor: "111", metadata: { changes: { auto_detect: {}, networks: {} } }, created_at: new Date().toISOString() }, { action: "community.address_removed", actor: "111", metadata: { address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }, created_at: new Date().toISOString() }] }
};
const ctx = { console, setTimeout, URLSearchParams, URL, Number, confirm: () => confirmAnswer, location: { search: "", hash: "" },
  document: { getElementById: getEl, querySelectorAll: s => s === "[data-cmty-net]" ? netBoxes : [], querySelector: () => null, addEventListener: (e, f) => { if (e === "click") clickHandler = f; } },
  BT: { backendUser: null, toast: m => { ctx.lastToast = m; }, apiRequest: async (path, o = {}) => {
    if (rejectWith) throw new Error(rejectWith);
    if (o.method === "POST") { posted.push({ path, body: JSON.parse(o.body) }); return path.endsWith("/settings") ? { ok: true, settings: data["/community/1/settings"].settings, changed: ["auto_detect"] } : { ok: true, status: JSON.parse(o.body).action === "pause" ? "paused" : "active" }; }
    const p = path.split("?")[0];
    if (p === "/community/1/addresses") return { ok: true, addresses: [{ id: 5, address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", network: "base", kind: "wallet", status: "active", hit_count: 2, last_seen_at: new Date().toISOString() }], nextOffset: null, _q: path };
    return data[p]; } } };
ctx.window = ctx; ctx.window.addEventListener = () => {}; ctx.window.Telegram = { WebApp: { openTelegramLink: u => opened.push(u) } };
vm.createContext(ctx); vm.runInContext(code, ctx);
const click = (dataset = {}, id = "") => clickHandler({ target: { closest: () => ({ dataset, id }) } });
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

await ctx.BT_COMMUNITY.loadList(false);
t("not signed in: tells the user to open it in Telegram", /inside Telegram/.test(getEl("cmtyGate").textContent) && getEl("cmtyBody").style.display === "none");

ctx.BT.backendUser = { id: 1 };
click({ page: "community" }); await tick(60);
t("signed in: list renders, hostile chat title is escaped", getEl("cmtyBody").style.display === "" && !/<img/.test(getEl("cmtyList").innerHTML) && /&lt;img/.test(getEl("cmtyList").innerHTML));
t("add-to-group / add-to-channel links built from the bot username", /startgroup/.test(getEl("cmtyAddBtns").innerHTML) && /startchannel&amp;admin=post_messages/.test(getEl("cmtyAddBtns").innerHTML));
click({ cmtyAdd: "https://t.me/mbc_bot?startgroup" }); t("add button opens Telegram link", opened[0] === "https://t.me/mbc_bot?startgroup");
t("single community opens automatically on Overview", /Active addresses/.test(getEl("cmtyPane").innerHTML));
t("overview shows counts, attention figures and notification types", /stat-value">4</.test(getEl("cmtyPane").innerHTML) && /1 retrying · 1 failed · 2 skipped/.test(getEl("cmtyPane").innerHTML) && /Transactions/.test(getEl("cmtyPane").innerHTML) && /Wallets/.test(getEl("cmtyPane").innerHTML));
t("group without read access shows the privacy/admin warning", /group admin/.test(getEl("cmtyWarn").innerHTML));
t("title is set via textContent (no HTML injection)", getEl("cmtyTitle").textContent === evil);

click({ cmtyTab: "settings" }); await tick();
t("settings form shows current values and network selection", /id="cmtyAuto" checked/.test(getEl("cmtyPane").innerHTML) && /id="cmtyCmd">/.test(getEl("cmtyPane").innerHTML) && /data-cmty-net="base" checked/.test(getEl("cmtyPane").innerHTML) && /value="60"/.test(getEl("cmtyPane").innerHTML));
Object.assign(getEl("cmtyAuto"), { checked: false }); Object.assign(getEl("cmtyCmd"), { checked: true }); Object.assign(getEl("cmtyW"), { checked: true }); Object.assign(getEl("cmtyC"), { checked: true }); Object.assign(getEl("cmtyT"), { checked: false });
getEl("cmtyDedupe").value = "45"; getEl("cmtyLimit").value = "20"; netBoxes = [{ checked: true, dataset: { cmtyNet: "base" } }, { checked: false, dataset: { cmtyNet: "ethereum" } }];
click({}, "cmtySave"); await tick();
t("save sends exactly the form values", posted.length === 1 && JSON.stringify(posted[0].body) === JSON.stringify({ auto_detect: false, command_detect: true, detect_wallets: true, detect_contracts: true, detect_tokens: false, networks: ["base"], dedupe_window_minutes: 45, max_notifications_per_hour: 20 }) && /Saved/.test(getEl("cmtySaveMsg").textContent));
posted.length = 0; getEl("cmtyDedupe").value = "0"; click({}, "cmtySave"); await tick();
t("invalid number blocked in the browser (nothing sent)", posted.length === 0 && /1–10080/.test(getEl("cmtySaveMsg").textContent));

click({ cmtyCtl: "pause" }); await tick(40);
t("pause asks to confirm and posts the action", posted.length === 1 && posted[0].body.action === "pause");
posted.length = 0; confirmAnswer = false; click({ cmtyCtl: "disconnect" }); await tick();
t("declining the confirm sends nothing", posted.length === 0); confirmAnswer = true;

click({ cmtyTab: "addresses" }); await tick(40);
t("address table renders with Remove button and requests the status filter", /0x5aAeb6/.test(getEl("cmtyARows").innerHTML) && /data-cmty-rm="5"/.test(getEl("cmtyARows").innerHTML) && getEl("cmtyAMore").style.display === "none");
posted.length = 0; click({ cmtyRm: "5" }); await tick(40);
t("remove address posts its id", posted[0] && posted[0].body.addressId === 5 && /address-remove/.test(posted[0].path));

click({ cmtyTab: "activity" }); await tick();
t("activity shows readable labels and changed fields", /Settings updated/.test(getEl("cmtyPane").innerHTML) && /Automatic detection, Networks/.test(getEl("cmtyPane").innerHTML) && /Address removed/.test(getEl("cmtyPane").innerHTML));

rejectWith = "COMMUNITY_NOT_FOUND"; click({ cmtyTab: "overview" }); await tick();
t("lost admin access shows a clear message", /no longer an admin/.test(getEl("cmtyPane").innerHTML));
console.log(fail ? `\n${fail} FAILED` : "\nall passed"); process.exit(fail ? 1 : 0);
