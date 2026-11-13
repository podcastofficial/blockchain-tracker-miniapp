// MBC Points card for Profile. Self-contained: adds one card to #page-profile, talks only to /api/points/*.
// Add before </body> in index.html:  <script src="/assets/points-ui.js" defer></script>
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const api = async (path, opt = {}) => {
    const r = await fetch("/api/points" + path, { credentials: "same-origin", cache: "no-store", ...opt, headers: { "Content-Type": "application/json", ...(opt.headers || {}) } });
    let j = {}; try { j = await r.json(); } catch {}
    if (!r.ok) { const e = new Error(j.error || "FAILED"); e.payload = j; throw e; } return j;
  };
  const MSG = { ALREADY_CLAIMED: "Already claimed today.", DAILY_CAP_REACHED: "Daily cap reached. Try again after 00:00 UTC.", TASK_NOT_COMPLETED: "Task not completed yet.",
    INSUFFICIENT_POINTS: "Not enough points.", BOOST_LIMIT_REACHED: "Too many active boosts of this type.", POINTS_DISABLED: "Points are currently disabled." };
  let box;
  function mount() {
    const page = document.getElementById("page-profile"); if (!page || document.getElementById("mbcPoints")) return !!document.getElementById("mbcPoints");
    box = document.createElement("div"); box.className = "card"; box.id = "mbcPoints"; box.style.marginBottom = "15px";
    box.innerHTML = '<div class="card-head"><div><div class="card-title">MBC Points</div><div class="card-sub">Earn daily, redeem for temporary boosts or package discounts</div></div><span class="tag" id="mbcBal">…</span></div><div id="mbcBody" class="card-sub">Loading…</div>';
    const notice = page.querySelector(".notice"); notice ? page.insertBefore(box, notice) : page.appendChild(box);
    box.addEventListener("click", onClick); return true;
  }
  async function load() {
    if (!mount()) return; const body = document.getElementById("mbcBody");
    try {
      const [s, t, r, h] = await Promise.all([api("/"), api("/tasks"), api("/rewards"), api("/history?limit=10")]);
      document.getElementById("mbcBal").textContent = s.balance + " pts";
      const exp = s.expiry.at ? `Expires ${esc(new Date(s.expiry.at).toLocaleDateString())} if inactive${s.expiry.warning ? " ⚠️" : ""}` : "No expiry pending";
      const taskRows = t.tasks.map(x => `<div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0"><span>${esc(x.code.replace(/_/g, " "))} · +${x.points}${x.requirement ? `<br><small>${esc(x.requirement)}</small>` : ""}</span>${x.claimable !== undefined ? (x.done ? '<span class="tag">DONE</span>' : `<button class="btn" data-claim="${esc(x.code)}"${x.claimable ? "" : " disabled"}>Claim</button>`) : (x.done ? '<span class="tag">DONE</span>' : "")}</div>`).join("");
      const boostRows = r.boosts.map(b => `<div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0"><span>${esc(b.title)}<br><small>${b.days} days · ${b.cost} pts</small></span><button class="btn" data-redeem="${esc(b.code)}"${s.available < b.cost ? " disabled" : ""}>Redeem</button></div>`).join("");
      const hist = h.items.map(x => `<div style="display:flex;justify-content:space-between;padding:3px 0"><span>${esc(x.reason.replace(/_/g, " "))} <small>${esc(new Date(x.created_at).toLocaleDateString())}</small></span><b>${x.amount > 0 ? "+" : ""}${x.amount}</b></div>`).join("") || "No activity yet.";
      body.innerHTML = `<div>Available <b>${s.available}</b> · Earned today ${s.daily.earned}/${s.daily.cap} · ${exp}</div>
        <h4 style="margin:12px 0 4px">Earn</h4>${taskRows}<h4 style="margin:12px 0 4px">Redeem boosts</h4>${boostRows}
        <h4 style="margin:12px 0 4px">Package discount</h4><div>Choose points at checkout in Subscription (max ${r.discount.maxPct}% off).</div>
        <h4 style="margin:12px 0 4px">History</h4>${hist}<div class="notice" style="margin-top:10px">${esc(s.terms)}</div><div id="mbcMsg" style="margin-top:6px"></div>`;
    } catch (e) { body.textContent = e.message === "AUTH_REQUIRED" ? "Sign in to see your points." : "Points are unavailable right now."; }
  }
  async function onClick(e) {
    const c = e.target.closest("[data-claim]"), r = e.target.closest("[data-redeem]"); if (!c && !r) return;
    const btn = c || r; btn.disabled = true;
    try {
      const out = c ? await api("/claim", { method: "POST", body: JSON.stringify({ task: c.dataset.claim }) })
        : await api("/redeem", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ reward: r.dataset.redeem }) });
      await load(); const m = document.getElementById("mbcMsg"); if (m) m.textContent = c ? `+${out.awarded} points` : "Boost activated";
    } catch (err) { const m = document.getElementById("mbcMsg"); if (m) m.textContent = MSG[err.message] || "Could not complete that."; btn.disabled = false; }
  }
  document.addEventListener("click", ev => { if (ev.target.closest('[data-page="profile"]')) setTimeout(load, 150); });
  window.addEventListener("bt-auth", () => { if (document.getElementById("page-profile")?.classList.contains("active")) load(); });
  if (document.readyState !== "loading") mount(); else document.addEventListener("DOMContentLoaded", mount);
})();
