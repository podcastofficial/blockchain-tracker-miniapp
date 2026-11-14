// Admin API for editable alert texts (all Telegram alert layouts). Called from lib/admin.js (admin-only, already authenticated).
//   GET  /api/admin/templates          list: default text, current text, placeholders, preview
//   POST /api/admin/template-preview   { key, text }  -> rendered preview with sample data (nothing saved)
//   POST /api/admin/template-save      { key, text }  -> validates (placeholders + Telegram HTML) and saves
//   POST /api/admin/template-reset     { key }        -> back to the built-in default
import { db } from "./db.js";
import { send, methodNotAllowed } from "./http.js";
import { DEFAULT_TEMPLATES, SAMPLES, renderTemplate, validateTemplate, clearTemplateCache } from "./templates.js";

export async function templatesAdmin(req, res, path, s, audit) {
  if (!path.startsWith("/api/admin/template")) return false;
  const body = req.body || {}, bad = (code, status = 400, extra = {}) => send(res, status, { ok: false, error: code, ...extra });
  try {
    if (path === "/api/admin/templates") {
      if (req.method !== "GET") { methodNotAllowed(res, ["GET"]); return true; }
      let rows = [];
      try { rows = (await db().query(`SELECT key, text, updated_at FROM alert_templates`)).rows; }
      catch (e) { if (e && e.code === "42P01") { bad("TEMPLATES_NOT_MIGRATED", 503); return true; } throw e; }
      const by = new Map(rows.map(r => [r.key, r]));
      send(res, 200, { ok: true, templates: Object.entries(DEFAULT_TEMPLATES).map(([key, d]) => {
        const c = by.get(key), text = c ? c.text : d.text;
        return { key, title: d.title, group: d.group, vars: d.vars, defaultText: d.text, text, custom: !!c, updatedAt: c ? c.updated_at : null, preview: renderTemplate(text, SAMPLES[key] || {}) };
      }) });
      return true;
    }
    if (req.method !== "POST") { methodNotAllowed(res, ["POST"]); return true; }
    const key = String(body.key || "");
    if (!DEFAULT_TEMPLATES[key]) { bad("UNKNOWN_TEMPLATE", 404); return true; }
    if (path === "/api/admin/template-preview") {
      const v = validateTemplate(key, body.text);
      if (v.error) { bad(v.error, 422, { detail: v.detail }); return true; }
      send(res, 200, { ok: true, preview: v.preview }); return true;
    }
    if (path === "/api/admin/template-save") {
      const v = validateTemplate(key, body.text);
      if (v.error) { bad(v.error, 422, { detail: v.detail }); return true; }
      if (v.value.trim() === DEFAULT_TEMPLATES[key].text.trim()) await db().query(`DELETE FROM alert_templates WHERE key=$1`, [key]);      // identical to the default: keep no override
      else await db().query(`INSERT INTO alert_templates (key, text, updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET text=EXCLUDED.text, updated_by=EXCLUDED.updated_by, updated_at=NOW()`, [key, v.value, s.telegram_user_id ? Number(s.telegram_user_id) : null]);
      clearTemplateCache();
      await audit(s.id, "admin.template.save", "alert_template", key);
      send(res, 200, { ok: true, preview: v.preview }); return true;
    }
    if (path === "/api/admin/template-reset") {
      await db().query(`DELETE FROM alert_templates WHERE key=$1`, [key]);
      clearTemplateCache();
      await audit(s.id, "admin.template.reset", "alert_template", key);
      send(res, 200, { ok: true, text: DEFAULT_TEMPLATES[key].text, preview: renderTemplate(DEFAULT_TEMPLATES[key].text, SAMPLES[key] || {}) }); return true;
    }
  } catch (e) {
    if (e && e.code === "42P01") bad("TEMPLATES_NOT_MIGRATED", 503); else bad("TEMPLATES_FAILED", 500);
    return true;
  }
  return false;
}
