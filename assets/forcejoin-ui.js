// Compulsory join (channel + group): full-screen gate, "Join our community" card on the Dashboard, and the Admin Panel card.
// Self-contained. Talks only to /api/forcejoin/status and /api/admin/fj*.
// Add before </body> in index.html:  <script src="/assets/forcejoin-ui.js" defer></script>
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const BTX = () => window.BT;
  const call = (p, o) => BTX().apiRequest(p, o);
  const post = (p, body) => call(p, { method: "POST", body: JSON.stringify(body) });
  const icon = k => (k === "channel" ? "📢" : "💬");
  const safeUrl = u => (/^https:\/\/t\.me\//i.test(String(u || "")) ? u : null);
  function openTg(u) {
    u = safeUrl(u); if (!u) return;
    try { const t = window.Telegram && window.Telegram.WebApp; if (t && t.openTelegramLink) { t.openTelegramLink(u); return; } } catch (e) { /* fall through */ }
    window.open(u, "_blank", "noopener,noreferrer");
  }

  /* ----------------------------------- styles ----------------------------------- */
  const css = document.createElement("style");
  css.textContent = `
.fj-gate{position:fixed;inset:0;z-index:99999;display:none;align-items:center;justify-content:center;padding:18px;background:var(--bg,#fff);overflow:auto}
.fj-gate.on{display:flex}
.fj-box{width:min(440px,100%);background:var(--panel,#fff);color:var(--text,#0f1730);border:1px solid var(--border,#e2e7f3);border-radius:20px;padding:22px 18px;box-shadow:var(--shadow,0 18px 44px #1b2a5a33);text-align:center}
.fj-logo{width:64px;height:64px;border-radius:16px;margin:0 auto 10px;display:block}
.fj-title{font-size:19px;font-weight:800;margin:4px 0 6px}
.fj-sub{font-size:12px;color:var(--muted,#667192);line-height:1.5;margin:0 0 14px}
.fj-row{display:flex;align-items:center;gap:10px;padding:12px;border:1px solid var(--border,#e2e7f3);border-radius:14px;margin-bottom:10px;text-align:left;background:var(--panel2,#f3f5fc)}
.fj-ico{font-size:22px;flex:0 0 auto}
.fj-txt{flex:1;min-width:0}.fj-txt b{display:block;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fj-txt small{color:var(--muted,#667192);font-size:10.5px}
.fj-msg{min-height:16px;font-size:11.5px;margin:8px 0 2px;color:var(--red,#ef4444)}
.fj-done{color:var(--green,#10b981);font-weight:800;font-size:12px;white-space:nowrap}
.fj-kv{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid var(--border,#e2e7f3);font-size:12px}
.fj-kv .grow{flex:1;min-width:150px}.fj-kv .grow b{display:block;font-size:12.5px}.fj-kv .grow small{color:var(--muted,#667192);font-size:10.5px;word-break:break-all}
.fj-btns{display:flex;gap:6px;flex-wrap:wrap}
.fj-off{opacity:.55}
`;
  document.head.appendChild(css);

  /* --------------------------- full-screen gate (users) --------------------------- */
  let gate, gateOn = false, ignoreAuth = false, busy = false;
  function mountGate() {
    if (gate) return gate;
    gate = document.createElement("div"); gate.className = "fj-gate"; gate.id = "fjGate"; gate.setAttribute("role", "dialog"); gate.setAttribute("aria-modal", "true");
    gate.innerHTML = '<div class="fj-box"><img class="fj-logo" src="/assets/logo-192.png" alt=""><div class="fj-title">Join to continue</div>' +
      '<p class="fj-sub">To use Multi Blockchain Tracker you must join our official channel and community group first.</p>' +
      '<div id="fjList"></div><div class="fj-msg" id="fjMsg"></div>' +
      '<button class="btn primary" id="fjCheck" type="button" style="width:100%;padding:13px;font-size:12px">✅ I\'ve Joined – Continue</button></div>';
    document.body.appendChild(gate);
    gate.addEventListener("click", e => {
      const b = e.target.closest("[data-fj-url]"); if (b) { openTg(b.dataset.fjUrl); return; }
      if (e.target.closest("#fjCheck")) verify();
    });
    return gate;
  }
  function drawGateList(items) {
    $("fjList").innerHTML = items.map(i => `<div class="fj-row"><span class="fj-ico">${icon(i.kind)}</span><div class="fj-txt"><b>${esc(i.title)}</b><small>${i.kind === "channel" ? "Official channel" : "Community group"}</small></div>` +
      (i.joined ? '<span class="fj-done">✓ Joined</span>' : `<button class="btn primary small" type="button" data-fj-url="${esc(i.url)}">Join</button>`) + "</div>").join("");
  }
  function showGate(items) {
    mountGate(); gateOn = true;
    if (Array.isArray(items)) drawGateList(items);
    gate.classList.add("on"); document.documentElement.style.overflow = "hidden";
  }
  function hideGate() {
    gateOn = false; if (gate) gate.classList.remove("on"); document.documentElement.style.overflow = "";
    ignoreAuth = true; try { window.dispatchEvent(new Event("bt-auth")); } finally { ignoreAuth = false; }   // reload every page's data now that access is open
  }
  async function verify() {
    if (busy) return; busy = true;
    const btn = $("fjCheck"), msg = $("fjMsg"); btn.disabled = true; msg.textContent = "Checking…";
    try {
      const d = await call("/forcejoin/status?fresh=1");
      drawGateList(d.items || []);
      if (!d.gateActive || d.allJoined) { msg.textContent = ""; hideGate(); await refresh(false); }
      else msg.textContent = "You have not joined: " + d.items.filter(i => !i.joined).map(i => i.title).join(", ");
    } catch (e) { msg.textContent = "Could not verify right now. Please try again."; }
    btn.disabled = false; busy = false;
  }

  /* ------------------------------ Dashboard card ------------------------------ */
  let card;
  function mountCard() {
    if (card) return card;
    const head = document.querySelector("#page-dashboard .page-head"); if (!head) return null;
    card = document.createElement("div"); card.className = "card"; card.id = "fjCard"; card.style.cssText = "margin:15px 0;display:none";
    head.insertAdjacentElement("afterend", card);
    card.addEventListener("click", e => { const b = e.target.closest("[data-fj-url]"); if (b) openTg(b.dataset.fjUrl); });
    return card;
  }
  function drawCard(items) {
    const c = mountCard(); if (!c) return;
    if (!items.length) { c.style.display = "none"; return; }
    c.style.display = "";
    c.innerHTML = '<div class="card-head"><div><div class="card-title">Join Our Community</div><div class="card-sub">Official channel and group: updates, support and announcements</div></div></div>' +
      items.map(i => `<div class="fj-row"><span class="fj-ico">${icon(i.kind)}</span><div class="fj-txt"><b>${esc(i.title)}</b><small>${i.kind === "channel" ? "Official channel" : "Community group"}</small></div>` +
        (i.joined ? '<span class="fj-done">✓ Joined</span>' : `<button class="btn primary small" type="button" data-fj-url="${esc(i.url)}">Join</button>`) + "</div>").join("");
  }

  async function refresh(fresh) {
    if (!BTX() || !BTX().backendUser) return;
    try {
      const d = await call("/forcejoin/status" + (fresh ? "?fresh=1" : ""));
      drawCard(d.items || []);
      if (d.gateActive && !d.allJoined) showGate(d.items); else if (gateOn) hideGate();
    } catch (e) { /* never block the app because of this check */ }
  }

  /* ------------------------------ Admin Panel card ------------------------------ */
  const AMSG = { INVALID_LINK: "Enter a valid @username or t.me link.", CHAT_NOT_FOUND: "Telegram could not find this chat. For private chats add the bot first.", CHAT_ID_REQUIRED_FOR_INVITE_LINK: "Invite links need the numeric chat ID (starts with -100).",
    USE_USERNAME_OR_INVITE_LINK: "Use the @username or a t.me/+invite link.", ALREADY_ADDED: "This channel/group is already in the list.", LIMIT_REACHED: "Maximum 10 required chats.", FORBIDDEN: "Admin access required." };
  const BOTLBL = { ok: ['<span class="tag green">Bot is admin ✓</span>'], bot_not_admin: ['<span class="tag yellow">⚠ Make the bot admin</span>'], bot_not_in_chat: ['<span class="tag yellow">⚠ Add the bot to this chat</span>'],
    chat_not_found: ['<span class="tag red">Chat not found</span>'], error: ['<span class="tag yellow">Check failed</span>'] };
  let adm, admData = { enabled: true, items: [] }, editId = null;
  function mountAdmin() {
    if (adm) return adm;
    const before = $("chCard"); if (!before) return null;
    adm = document.createElement("div"); adm.className = "card"; adm.id = "fjAdmin"; adm.style.marginTop = "15px";
    adm.innerHTML = '<div class="card-head"><div><div class="card-title">Compulsory Join (Channel &amp; Group)</div><div class="card-sub">Users must join these before the bot menu and Mini App open. Add, remove or switch each one ON/OFF.</div></div><div class="fj-btns"><button class="btn small" id="fjMaster" type="button">…</button><button class="btn primary small" id="fjAdd" type="button">+ Add</button></div></div>' +
      '<div class="notice" style="margin-top:8px">The bot must be an <b>admin</b> in every channel/group listed, otherwise Telegram cannot confirm who joined (the check is skipped for that chat). Admins are never blocked.</div>' +
      '<div id="fjEd" style="display:none;margin-top:12px;padding:14px;border:1.5px solid var(--border);border-radius:12px"><div class="card-title" id="fjEdTitle" style="margin-bottom:10px">Add required chat</div>' +
      '<div class="form-grid"><div class="field"><label for="fjEdName">Display name (optional)</label><input id="fjEdName" maxlength="60" placeholder="Official Channel"></div>' +
      '<div class="field"><label for="fjEdLink">@username or t.me link</label><input id="fjEdLink" maxlength="200" placeholder="@MyChannel or https://t.me/MyChannel" autocapitalize="off" autocomplete="off"></div>' +
      '<div class="field"><label for="fjEdChat">Chat ID (only for private invite links)</label><input id="fjEdChat" maxlength="30" placeholder="-1001234567890" autocomplete="off"></div>' +
      '<div class="field"><label for="fjEdSort">Order (1 = first)</label><input id="fjEdSort" type="number" min="1" max="999" value="100"></div>' +
      '<div class="field"><label for="fjEdOn">Status</label><select id="fjEdOn"><option value="1">ON</option><option value="0">OFF</option></select></div></div>' +
      '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><button class="btn primary" id="fjEdSave" type="button">Save</button><button class="btn" id="fjEdCancel" type="button">Cancel</button></div><div class="form-message" id="fjEdMsg"></div></div>' +
      '<div id="fjAdList" style="margin-top:10px"><div class="empty">Loading…</div></div>';
    before.parentNode.insertBefore(adm, before);
    adm.addEventListener("click", onAdminClick);
    return adm;
  }
  function drawAdmin() {
    const m = $("fjMaster"); m.textContent = "Force join: " + (admData.enabled ? "ON" : "OFF"); m.className = "btn small" + (admData.enabled ? " primary" : "");
    const L = $("fjAdList");
    L.innerHTML = admData.items.length ? admData.items.map(i => `<div class="fj-kv ${i.enabled ? "" : "fj-off"}"><span class="fj-ico">${icon(i.kind)}</span><div class="grow"><b>${esc(i.title)}</b><small>${esc(i.chat_ref)} · ${i.kind}</small></div>` +
      (BOTLBL[i.bot] || BOTLBL.error)[0] + `<span class="tag ${i.enabled ? "green" : ""}">${i.enabled ? "ON" : "OFF"}</span>` +
      `<div class="fj-btns"><button class="btn small" data-fj-act="toggle" data-id="${i.id}" type="button">${i.enabled ? "Turn OFF" : "Turn ON"}</button><button class="btn small" data-fj-act="edit" data-id="${i.id}" type="button">Edit</button><button class="btn danger small" data-fj-act="del" data-id="${i.id}" type="button">Remove</button></div></div>`).join("")
      : '<div class="empty">No required chats. Users can use the app without joining anything.</div>';
  }
  async function loadAdminFJ() {
    if (!BTX() || !BTX().backendUser || !mountAdmin()) return;
    try { admData = await call("/admin/fj"); drawAdmin(); }
    catch (e) { $("fjAdList").innerHTML = '<div class="empty">' + esc(e.status === 403 ? "Admin access required." : "Could not load. Tap Refresh and try again.") + "</div>"; }
  }
  function openEd(item) {
    editId = item ? item.id : null;
    $("fjEdTitle").textContent = item ? "Edit required chat" : "Add required chat";
    $("fjEdName").value = item ? item.title : ""; $("fjEdLink").value = item ? (item.chat_ref.startsWith("@") ? item.chat_ref : item.url) : "";
    $("fjEdChat").value = item && !item.chat_ref.startsWith("@") ? item.chat_ref : ""; $("fjEdSort").value = item ? item.sort_order : 100; $("fjEdOn").value = !item || item.enabled ? "1" : "0";
    $("fjEdMsg").textContent = ""; $("fjEd").style.display = ""; $("fjEdLink").focus();
  }
  async function act(path, body, ok) {
    try { await post(path, body); if (ok) BTX().toast(ok); await loadAdminFJ(); await refresh(true); }
    catch (e) { BTX().toast(AMSG[e.message] || "Action failed"); await loadAdminFJ(); }
  }
  async function onAdminClick(e) {
    if (e.target.closest("#fjAdd")) return openEd(null);
    if (e.target.closest("#fjEdCancel")) { $("fjEd").style.display = "none"; return; }
    if (e.target.closest("#fjMaster")) return act("/admin/fj-master", { enabled: !admData.enabled }, admData.enabled ? "Force join OFF" : "Force join ON");
    if (e.target.closest("#fjEdSave")) {
      const b = $("fjEdSave"), msg = $("fjEdMsg"); b.disabled = true; msg.textContent = "Saving…";
      try {
        const r = await post("/admin/fj-save", { id: editId, title: $("fjEdName").value, link: $("fjEdLink").value, chatId: $("fjEdChat").value, sort: Number($("fjEdSort").value), enabled: $("fjEdOn").value === "1" });
        $("fjEd").style.display = "none"; BTX().toast(r.bot === "ok" ? "Saved" : "Saved – make the bot admin in that chat"); await loadAdminFJ(); await refresh(true);
      } catch (err) { msg.textContent = AMSG[err.message] || "Could not save. Check the link and try again."; }
      b.disabled = false; return;
    }
    const a = e.target.closest("[data-fj-act]"); if (!a) return;
    const id = Number(a.dataset.id), it = admData.items.find(x => x.id === id); if (!it) return;
    if (a.dataset.fjAct === "toggle") return act("/admin/fj-toggle", { id, enabled: !it.enabled }, it.enabled ? "Turned OFF" : "Turned ON");
    if (a.dataset.fjAct === "edit") return openEd(it);
    if (a.dataset.fjAct === "del" && confirm('Remove "' + it.title + '" from the required list?')) return act("/admin/fj-delete", { id }, "Removed");
  }

  /* ----------------------------------- wiring ----------------------------------- */
  function wrapApi() {   // any API call answered with JOIN_REQUIRED (e.g. user left the channel mid-session) shows the gate again
    const B = BTX(); if (!B || B.__fj) return; B.__fj = true;
    const orig = B.apiRequest;
    B.apiRequest = async function (p, o) {
      try { return await orig(p, o); }
      catch (e) { if (e && e.message === "JOIN_REQUIRED" && !String(p).startsWith("/forcejoin")) showGate(e.payload && e.payload.items); throw e; }
    };
  }
  function init() {
    wrapApi(); mountCard(); mountAdmin();
    window.addEventListener("bt-auth", () => { if (!ignoreAuth) refresh(true); });
    window.addEventListener("bt-refresh", () => { refresh(false); const p = $("page-admin"); if (p && p.classList.contains("active")) loadAdminFJ(); });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && gateOn) verify(); });
    document.querySelectorAll('[data-page="admin"]').forEach(b => b.addEventListener("click", () => setTimeout(loadAdminFJ, 400)));
    if (BTX() && BTX().backendUser) refresh(true);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
