// Community Crypto Monitor — "💾 Save to My Tracker" inline button.
// A member taps the button under a bot notification in a group/channel; the address is added to THEIR personal watchlist
// (same storage as "Add Wallet / Add Contract" in the Mini App, same plan limits). Community records stay separate.
// callback_data = "sv:<notification id>" — the address is read from the stored notification, never from the client.
import { db } from "./db.js";
import { tgCall } from "./tgapi.js";
import { NETWORKS } from "./address.js";
import { SUPPORTED, validAddr } from "./balances.js";
import { limitsFor } from "./plans.js";

const hits = new Map();                                            // tiny per-instance limiter: 10 taps / minute / user
const tooFast = uid => { const now = Date.now(), a = (hits.get(uid) || []).filter(t => now - t < 60000); a.push(now); hits.set(uid, a); if (hits.size > 2000) hits.clear(); return a.length > 10; };
const short = a => a.length > 14 ? a.slice(0, 6) + "…" + a.slice(-4) : a;
const answer = (q, text, alert = false) => tgCall("answerCallbackQuery", { callback_query_id: q.id, text: String(text).slice(0, 190), show_alert: alert });

// Pure: the watchlist entry we store (shape identical to lib/watchlist.js `clean`).
export function buildItem(sub, kind, displayName) {
  const type = kind === "wallet" ? "wallet" : "contract";           // tokens and contracts are both "contract" in the watchlist
  const key = `${type}:${sub.network}:${sub.address.toLowerCase()}`;
  const name = String(displayName || `${NETWORKS[sub.network].name} ${short(sub.address)}`).slice(0, 50);
  return { id: key, type, network: sub.network, address: sub.address, name, category: kind === "token" ? "Token" : "Community", createdAt: new Date().toISOString() };
}

export async function handleSaveCallback(q) {
  const mt = /^sv:(\d{1,18})$/.exec(q.data || ""), chat = q.message?.chat;
  if (!mt || !chat || !q.from?.id) return;
  if (tooFast(q.from.id)) return void await answer(q, "Too many taps. Wait a moment.");
  const n = (await db().query(
    `SELECT n.subject, n.result_kind, n.display_name, c.chat_id FROM community_notifications n JOIN communities c ON c.id=n.community_id WHERE n.id=$1`, [mt[1]]
  ).catch(async () =>                                              // display_name column missing (phase3b not run): retry without it
    db().query(`SELECT n.subject, n.result_kind, NULL AS display_name, c.chat_id FROM community_notifications n JOIN communities c ON c.id=n.community_id WHERE n.id=$1`, [mt[1]]))).rows[0];
  // The button must be pressed in the same chat the notification was posted to.
  if (!n || String(n.chat_id) !== String(chat.id) || n.subject?.type !== "address" || !["wallet", "contract", "token"].includes(n.result_kind))
    return void await answer(q, "This button is no longer available.", true);
  const sub = n.subject;
  if (!SUPPORTED.includes(sub.network) || !validAddr(sub.network, sub.address)) return void await answer(q, "This address can't be saved.", true);

  const u = (await db().query(`SELECT id, is_blocked FROM users WHERE telegram_user_id=$1`, [q.from.id])).rows[0];
  if (!u) return void await answer(q, "Open the Multi Blockchain Tracker Mini App once to create your account, then tap Save again.", true);
  if (u.is_blocked) return void await answer(q, "Your account can't use this feature.", true);

  const item = buildItem(sub, n.result_kind, n.display_name);
  const lim = await limitsFor(u.id);
  const c = await db().connect();
  let outcome;
  try {
    await c.query("BEGIN");
    await c.query(`INSERT INTO user_watchlists (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [u.id]);
    const items = (await c.query(`SELECT items FROM user_watchlists WHERE user_id=$1 FOR UPDATE`, [u.id])).rows[0]?.items || [];
    if (items.some(x => x.type === item.type && x.network === item.network && String(x.address).toLowerCase() === sub.address.toLowerCase())) outcome = "exists";
    else if (items.filter(x => x.type === item.type).length >= (item.type === "wallet" ? lim.wallets : lim.contracts)) outcome = "limit";
    else { await c.query(`UPDATE user_watchlists SET items=$2, updated_at=NOW() WHERE user_id=$1`, [u.id, JSON.stringify([...items, item])]); outcome = "saved"; }
    await c.query("COMMIT");
  } catch { await c.query("ROLLBACK").catch(() => {}); return void await answer(q, "Couldn't save right now. Try again.", true); }
  finally { c.release(); }

  if (outcome === "saved") return void await answer(q, `✅ Saved to My Tracker (${item.type === "wallet" ? "wallet" : "contract"}). Open the Mini App to see it.`);
  if (outcome === "exists") return void await answer(q, "Already in your tracker.");
  return void await answer(q, `Your ${item.type} limit (${item.type === "wallet" ? lim.wallets : lim.contracts}) is reached on the ${lim.plan} plan. Remove one or upgrade.`, true);
}
