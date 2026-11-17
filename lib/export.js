// POST /api/export  { type, format: "csv" | "pdf", deliver: "telegram" | "file", ... }
//   types: alerts | portfolio | watchlist | payments | custom            (existing)
//          ranking  Smart Money wallet ranking          trades  indexed swap trades [category, wallet]
//          tax      realized gains report [year]  (paid plan / free trial)
// "telegram" sends the file to the user's bot chat (works inside Telegram, where downloads are unreliable);
// "file" returns it in the response: CSV as text (csv), PDF as base64 (base64 + mime).
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { readSession } from "./session.js";
import { rateLimited } from "./ratelimit.js";
import { toCsv } from "./csv.js";
import { historyRows } from "./history.js";
import { sendDocument } from "./notify.js";
import { buildPdf } from "./pdf.js";
import { buildSmartMoney } from "./smart_money.js";
import { userWallets, cachedTrades } from "./portfolio_pro.js";
import { taxReport } from "./tax_report.js";
import { premiumAccess } from "./entitle.js";
import { trackUsage } from "./usage.js";

const stamp = () => new Date().toISOString().slice(0, 10);
const iso = t => new Date(t).toISOString().replace("T", " ").slice(0, 19);
const usd = v => (v == null ? "" : (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 2 }));
const pct = v => (v == null ? "" : (v * 100).toFixed(1) + "%");
const short = a => (a && a.length > 18 ? a.slice(0, 8) + ".." + a.slice(-6) : a || "");

// Every type returns a table: { name, title, header, rows, widths? (PDF column shares), align? (PDF: indexes of right-aligned columns) }
async function build(uid, b) {
  switch (b.type) {
    case "alerts": {
      const h = await historyRows(uid, { limit: 5000 });
      return { name: "alert-history", title: "Alert history", header: ["time_utc", "type", "network", "summary", "usd", "delivery"],
        rows: h.rows.map(r => [r.at, r.kind, r.network, String(r.summary || "").replace(/\s*\n\s*/g, " | "), r.usd, r.delivery_status]), widths: [0.17, 0.08, 0.1, 0.45, 0.1, 0.1], align: [4] };
    }
    case "portfolio": {
      const r = await db().query(`SELECT taken_at, total_usd::float8 AS v FROM portfolio_snapshots WHERE user_id=$1 ORDER BY taken_at DESC LIMIT 5000`, [uid]);
      return { name: "portfolio-history", title: "Portfolio value history", header: ["time_utc", "total_value_usd"], rows: r.rows.map(x => [x.taken_at, x.v]), widths: [0.5, 0.5], align: [1] };
    }
    case "watchlist": {
      const r = await db().query(`SELECT items, invested_usd::float8 AS inv FROM user_watchlists WHERE user_id=$1`, [uid]);
      const items = Array.isArray(r.rows[0]?.items) ? r.rows[0].items : [];
      return { name: "watchlist", title: "Watchlist", header: ["name", "type", "network", "address", "category", "added"], rows: items.map(i => [i.name, i.type, i.network, i.address, i.category, i.createdAt]), widths: [0.16, 0.08, 0.1, 0.4, 0.12, 0.14] };
    }
    case "payments": {
      const r = await db().query(
        `SELECT created_at, plan_code, chain, expected_amount::float8 AS amount, status, tx_hash, confirmed_at
         FROM subscription_payments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1000`, [uid]);
      return { name: "payments", title: "Payments", header: ["created_at", "plan", "network", "amount_usdt", "status", "tx_hash", "confirmed_at"],
        rows: r.rows.map(x => [x.created_at, x.plan_code, x.chain, x.amount, x.status, x.tx_hash, x.confirmed_at]), widths: [0.15, 0.08, 0.08, 0.1, 0.1, 0.34, 0.15], align: [3] };
    }
    case "custom": { // rows prepared in the page (e.g. the Transaction Explorer table)
      const name = String(b.filename || "export").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40) || "export";
      const header = Array.isArray(b.header) ? b.header.slice(0, 12).map(x => String(x).slice(0, 60)) : null;
      const rows = Array.isArray(b.rows) ? b.rows.slice(0, 2000) : null;
      if (!header || !rows || !header.length) return null;
      return { name, title: name, header, rows: rows.map(r => (Array.isArray(r) ? r : []).slice(0, header.length).map(c => (c == null ? "" : String(c).slice(0, 300)))) };
    }
    case "ranking": {
      const d = await buildSmartMoney(uid, { live: true });
      return { name: "smart-money-ranking", title: "Smart Money wallet ranking (30d)", subtitle: "Research score is not a profitability guarantee. Unrealized PnL: live DEX price where liquid, else last trade price.",
        header: ["rank", "wallet", "network", "address", "score", "realized_usd", "unrealized_usd", "win_rate", "closed_trades", "swaps_30d", "status"],
        rows: d.wallets.map((w, i) => [i + 1, w.name, w.network, w.address, w.score ?? "", w.realizedUsd ?? "", w.unrealizedUsd ?? "", w.winRate == null ? "" : +(w.winRate * 100).toFixed(1), w.closedTrades, w.trades30d, w.status]),
        pdfRows: d.wallets.map((w, i) => [i + 1, w.name, w.network, short(w.address), w.score ?? "-", usd(w.realizedUsd), usd(w.unrealizedUsd), pct(w.winRate), w.closedTrades, w.status]),
        pdfHeader: ["#", "Wallet", "Network", "Address", "Score", "Realized", "Unrealized", "Win rate", "Closed", "Status"], widths: [0.04, 0.14, 0.09, 0.15, 0.06, 0.11, 0.11, 0.08, 0.06, 0.16], align: [4, 5, 6, 7, 8] };
    }
    case "trades": {
      const items = await userWallets(uid, { category: String(b.category || ""), only: String(b.wallet || "") });
      if (!items.length) return null;
      const data = await cachedTrades(uid, items);
      const all = data.flatMap(d => d.trades.map(t => ({ ...t, name: d.item.name, wallet: t.wallet || d.item.address }))).sort((a, c) => c.ts - a.ts).slice(0, 5000);
      return { name: "wallet-trades", title: "Indexed swap trades", subtitle: `${items.length} wallet(s), newest first. Built from indexed swaps only.`,
        header: ["time_utc", "wallet", "network", "address", "side", "token", "amount", "usd_value", "tx_hash"],
        rows: all.map(t => [new Date(t.ts).toISOString(), t.name, t.network, t.wallet, t.side, t.token?.symbol, t.amount, t.usdValue, t.txHash]),
        pdfRows: all.map(t => [iso(t.ts), t.name, t.network, t.side, t.token?.symbol, Number(t.amount).toPrecision(6), usd(t.usdValue), short(t.txHash)]),
        pdfHeader: ["Time (UTC)", "Wallet", "Network", "Side", "Token", "Amount", "USD", "Tx"], widths: [0.15, 0.15, 0.09, 0.06, 0.1, 0.14, 0.11, 0.2], align: [5, 6] };
    }
    case "tax": {
      if (!(await premiumAccess(uid))) return { locked: true };
      const year = Math.min(Math.max(Number(b.year) || new Date().getUTCFullYear(), 2015), new Date().getUTCFullYear());
      const items = await userWallets(uid);
      if (!items.length) return null;
      const data = await cachedTrades(uid, items);
      const rep = taxReport(data.flatMap(d => d.trades.map(t => ({ ...t, wallet: t.wallet || d.item.address }))), year), S = rep.summary;
      return { name: `tax-report-${year}`, title: `Realized gains report ${year} (FIFO, swap history)`,
        subtitle: `Net ${usd(S.netGainUsd)} | Short-term ${usd(S.shortTerm.gainUsd)} | Long-term ${usd(S.longTerm.gainUsd)} | Disposals ${S.disposals}${S.unknownCostDisposals ? " | " + S.unknownCostDisposals + " without known cost (excluded)" : ""} | Bookkeeping aid, not tax advice`,
        header: ["date_acquired", "date_sold", "network", "token", "quantity", "proceeds_usd", "cost_basis_usd", "gain_usd", "term", "tx_hash"],
        rows: rep.rows.map(r => [r.acquiredAt ? new Date(r.acquiredAt).toISOString().slice(0, 10) : "unknown", new Date(r.soldAt).toISOString().slice(0, 10), r.network, r.token, r.qty, +r.proceedsUsd.toFixed(2), r.costUsd == null ? "" : +r.costUsd.toFixed(2), r.gainUsd == null ? "" : +r.gainUsd.toFixed(2), r.term, r.txHash]),
        pdfRows: rep.rows.map(r => [r.acquiredAt ? new Date(r.acquiredAt).toISOString().slice(0, 10) : "unknown", new Date(r.soldAt).toISOString().slice(0, 10), r.token, Number(r.qty).toPrecision(6), usd(r.proceedsUsd), usd(r.costUsd), usd(r.gainUsd), r.term]),
        pdfHeader: ["Acquired", "Sold", "Token", "Quantity", "Proceeds", "Cost basis", "Gain/Loss", "Term"], widths: [0.12, 0.12, 0.12, 0.16, 0.13, 0.13, 0.13, 0.09], align: [3, 4, 5, 6] };
    }
    default: return null;
  }
}

export async function exportApi(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const s = readSession(req);
  if (!s) return send(res, 401, { ok: false, error: "AUTH_REQUIRED" });
  if (rateLimited(req, res, "export", s.id, 6)) return;
  try {
    const b = req.body || {}, pdf = String(b.format || "csv").toLowerCase() === "pdf";
    const out = await build(s.id, b);
    if (out?.locked) return send(res, 402, { ok: false, error: "PLAN_REQUIRED", feature: "tax_report", hint: "The tax-style report needs a paid plan or the free trial." });
    if (!out) return send(res, 400, { ok: false, error: "INVALID_EXPORT" });
    trackUsage(s.id, `export_${b.type}_${pdf ? "pdf" : "csv"}`);
    const ext = pdf ? "pdf" : "csv", filename = `${out.name}-${stamp()}.${ext}`;
    const content = pdf
      ? buildPdf({ title: out.title || out.name, subtitle: out.subtitle || "", footer: "Blockchain Tracker - " + stamp(),
          columns: (out.pdfHeader || out.header).map((label, i) => ({ label, width: out.widths?.[i] || 1 / (out.pdfHeader || out.header).length, align: out.align?.includes(i) ? "right" : "left" })),
          rows: (out.pdfRows || out.rows).slice(0, 1500) })
      : toCsv(out.header, out.rows);
    const mime = pdf ? "application/pdf" : "text/csv";
    if (b.deliver === "file") return send(res, 200, pdf ? { ok: true, filename, mime, base64: content.toString("base64") } : { ok: true, filename, mime, csv: content });
    const ok = await sendDocument(s.telegram_user_id, filename, content, "Blockchain Tracker export", mime);
    if (!ok) return send(res, 502, { ok: false, error: "TELEGRAM_DELIVERY_FAILED" });
    return send(res, 200, { ok: true, delivered: true, filename });
  } catch (e) { console.error("[export]", e.message); return send(res, 500, { ok: false, error: "EXPORT_FAILED" }); }
}
