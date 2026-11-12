// Community Crypto Monitor — lifecycle (Phase 1) and routing into address detection / commands (Phase 2, lib/community_track.js).
// Notifications with live data arrive in Phase 3.
// Every function here is fail-soft: an error must never break the existing private-chat bot flows.
import { db } from "./db.js";
import { tg, isChatAdmin } from "./tgapi.js";
import { processCommunityMessage, processCommunityCallback } from "./community_track.js";
export { isChatAdmin };

const COMMUNITY_TYPES = new Set(["group", "supergroup", "channel"]);
export const isCommunityChat = chat => COMMUNITY_TYPES.has(chat?.type);

// Webhook idempotency. Returns true if this update_id is new. Fails OPEN (true) if the table is missing,
// so deploying the code before running db/community.sql cannot break existing bot flows.
export async function claimUpdate(updateId) {
  if (!Number.isSafeInteger(updateId)) return true;
  try {
    const r = await db().query(
      `INSERT INTO telegram_updates (update_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING update_id`, [updateId]);
    return r.rowCount > 0;
  } catch { return true; }
}

export async function purgeOldUpdates() {
  const r = await db().query(`DELETE FROM telegram_updates WHERE received_at < NOW() - INTERVAL '7 days'`);
  const u = await db().query(`DELETE FROM community_usage WHERE hour_bucket < NOW() - INTERVAL '35 days'`).catch(() => ({ rowCount: 0 }));
  return { purged: r.rowCount, usagePurged: u.rowCount };
}

const audit = (communityId, chatId, actor, action, metadata = {}) =>
  db().query(
    `INSERT INTO community_audit_logs (community_id, chat_id, actor_telegram_id, action, metadata) VALUES ($1,$2,$3,$4,$5)`,
    [communityId, chatId, actor ?? null, action, JSON.stringify(metadata)]).catch(() => {});

// Bot membership/permissions in a chat. Groups: administrator status is what guarantees the bot sees every message
// (otherwise Telegram privacy mode applies). Channels: the bot must be an admin with post_messages.
export function botCapabilities(chatType, member) {
  const st = member?.status;
  const present = st === "member" || st === "administrator";
  const admin = st === "administrator";
  if (chatType === "channel")
    return { present: admin, canRead: admin, canPost: admin && member.can_post_messages === true };
  return { present, canRead: admin, canPost: present && member.can_send_messages !== false };
}

async function syncAdmins(communityId, chatId) {
  const admins = await tg("getChatAdministrators", { chat_id: chatId });
  if (!Array.isArray(admins)) return 0;
  const rows = admins.filter(a => a.user && !a.user.is_bot);
  const c = await db().connect();
  try {
    await c.query("BEGIN");
    await c.query(`DELETE FROM community_admins WHERE community_id=$1`, [communityId]);
    for (const a of rows)
      await c.query(
        `INSERT INTO community_admins (community_id, telegram_user_id, role) VALUES ($1,$2,$3)
         ON CONFLICT (community_id, telegram_user_id) DO UPDATE SET role=EXCLUDED.role, synced_at=NOW()`,
        [communityId, a.user.id, a.status === "creator" ? "creator" : "administrator"]);
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  return rows.length;
}

const welcome = (type, caps) => {
  if (type === "channel")
    return caps.canPost ? "✅ Blockchain Tracker is connected to this channel. Community monitoring settings will be managed by channel admins in the Mini App."
      : "⚠️ Blockchain Tracker needs the “Post messages” admin permission in this channel to send notifications.";
  return "✅ Blockchain Tracker is connected to this group.\n" +
    (caps.canRead ? "I can read messages to detect wallet, contract and token addresses.\n"
      : "Tip: make me a group admin (or disable bot privacy) so I can see address messages. Until then, commands like /track still work.\n") +
    "Only group admins can change monitoring settings.";
};

// Handles my_chat_member: the bot was added, promoted, demoted, muted, removed or banned.
export async function handleMyChatMember(update) {
  const e = update.my_chat_member;
  if (!e || !isCommunityChat(e.chat)) return;
  const chat = e.chat, actor = e.from?.id ?? null, member = e.new_chat_member;
  const caps = botCapabilities(chat.type, member);
  const prev = await db().query(`SELECT id, status FROM communities WHERE chat_id=$1`, [chat.id]);
  const wasDisconnected = !prev.rowCount || prev.rows[0].status === "disconnected";

  if (!caps.present) {
    // Removed/kicked/left, or (channel) demoted from admin: stop monitoring.
    if (!prev.rowCount) return;
    const r = await db().query(
      `UPDATE communities SET status='disconnected', bot_status=$2, can_read_messages=FALSE, can_post=FALSE,
         disconnected_at=NOW(), updated_at=NOW() WHERE chat_id=$1 RETURNING id`, [chat.id, member?.status || null]);
    await audit(r.rows[0]?.id, chat.id, actor, "community.disconnected", { bot_status: member?.status, type: chat.type });
    return;
  }

  const up = await db().query(
    `INSERT INTO communities (chat_id, chat_type, title, username, status, bot_status, can_read_messages, can_post, added_by_telegram_id)
     VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8)
     ON CONFLICT (chat_id) DO UPDATE SET
       chat_type=EXCLUDED.chat_type, title=EXCLUDED.title, username=EXCLUDED.username, bot_status=EXCLUDED.bot_status,
       can_read_messages=EXCLUDED.can_read_messages, can_post=EXCLUDED.can_post, updated_at=NOW(),
       -- re-adding after removal re-activates; an admin-paused community stays paused
       status=CASE WHEN communities.status='disconnected' THEN 'active' ELSE communities.status END,
       disconnected_at=CASE WHEN communities.status='disconnected' THEN NULL ELSE communities.disconnected_at END,
       added_by_telegram_id=CASE WHEN communities.status='disconnected' THEN EXCLUDED.added_by_telegram_id ELSE communities.added_by_telegram_id END
     RETURNING id`,
    [chat.id, chat.type, chat.title || null, chat.username || null, member.status, caps.canRead, caps.canPost, actor]);
  const id = up.rows[0].id;
  await db().query(`INSERT INTO community_settings (community_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
  await audit(id, chat.id, actor, wasDisconnected ? "community.connected" : "community.permissions_changed",
    { bot_status: member.status, can_read: caps.canRead, can_post: caps.canPost, type: chat.type });
  await syncAdmins(id, chat.id).catch(() => {});
  if (wasDisconnected && caps.canPost) await tg("sendMessage", { chat_id: chat.id, text: welcome(chat.type, caps), disable_web_page_preview: true });
  else if (wasDisconnected && chat.type === "channel" && actor)
    await tg("sendMessage", { chat_id: actor, text: welcome("channel", caps) }); // channel without post rights: tell the person who added us
}

// Keeps cached admin list and title fresh when admins change (chat_member updates are not requested; this covers titles/renames).
export async function handleCommunityMessage(update) {
  const m = update.message || update.channel_post;
  if (!m || !isCommunityChat(m.chat)) return;
  if (m.new_chat_title) await db().query(`UPDATE communities SET title=$2, updated_at=NOW() WHERE chat_id=$1`, [m.chat.id, m.new_chat_title]);
  // Group upgraded to supergroup: Telegram issues a NEW chat id. Move the record so settings/history survive.
  if (m.migrate_to_chat_id)
    await db().query(`UPDATE communities SET chat_id=$2, chat_type='supergroup', updated_at=NOW() WHERE chat_id=$1`, [m.chat.id, m.migrate_to_chat_id]);
  await processCommunityMessage(m);
}

export async function handleCommunityUpdate(update) {
  try {
    if (update.my_chat_member) await handleMyChatMember(update);
    else if (update.message || update.channel_post) await handleCommunityMessage(update);
    else if (update.callback_query) await processCommunityCallback(update.callback_query);
  } catch { /* never let community handling break the webhook ack */ }
}
