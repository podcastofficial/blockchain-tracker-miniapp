// Tiny dependency-free PDF writer (A4, Helvetica, text + simple tables). Enough for ranking / trade / tax reports.
// Non-Latin characters are replaced with "?" because the built-in PDF fonts only cover WinAnsi.
const W = 595, H = 842, M = 36;
const safe = v => String(v ?? "").replace(/[\r\n\t]+/g, " ").replace(/[^\x20-\x7e\u00a0-\u00ff]/g, "?");
const esc = s => safe(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const widthOf = (s, size) => safe(s).length * size * 0.52;   // Helvetica average glyph width (close enough for fitting columns)
const fit = (s, size, max) => { s = safe(s); if (widthOf(s, size) <= max) return s; while (s.length > 2 && widthOf(s + "..", size) > max) s = s.slice(0, -1); return s + ".."; };

// opts: { title, subtitle, columns:[{label,width(0-1 share),align?}], rows:[[...]], footer }
export function buildPdf({ title, subtitle = "", columns, rows, footer = "" }) {
  const usable = W - 2 * M, widths = columns.map(c => (c.width || 1 / columns.length) * usable);
  const pages = [];
  let cur = null, y = 0;
  const newPage = () => { cur = []; pages.push(cur); y = H - M; text(title, M, y - 14, 15, true); y -= 24; if (subtitle) { text(subtitle, M, y - 8, 8.5, false, 0.4); y -= 16; } header(); };
  const text = (s, x, yy, size, bold = false, gray = 0) => cur.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${gray} g ${x.toFixed(1)} ${yy.toFixed(1)} Td (${esc(s)}) Tj ET`);
  const header = () => {
    cur.push(`0.93 g ${M} ${y - 14} ${usable} 16 re f`);
    let x = M; columns.forEach((c, i) => { text(fit(c.label, 8, widths[i] - 6), c.align === "right" ? x + widths[i] - 3 - widthOf(fit(c.label, 8, widths[i] - 6), 8) : x + 3, y - 10, 8, true); x += widths[i]; });
    y -= 18;
  };
  newPage();
  rows.forEach((r, idx) => {
    if (y < M + 28) newPage();
    if (idx % 2) cur.push(`0.97 g ${M} ${y - 11} ${usable} 13 re f`);
    let x = M; columns.forEach((c, i) => { const t = fit(r[i] ?? "", 7.5, widths[i] - 6); text(t, c.align === "right" ? x + widths[i] - 3 - widthOf(t, 7.5) : x + 3, y - 8, 7.5); x += widths[i]; });
    y -= 13;
  });
  if (!rows.length) { text("No data for this report.", M, y - 10, 9, false, 0.4); }
  pages.forEach((p, i) => p.push(`BT /F1 7 Tf 0.5 g ${M} 20 Td (${esc((footer ? footer + "  -  " : "") + "Page " + (i + 1) + " / " + pages.length)}) Tj ET`));

  const objs = [];
  const add = body => { objs.push(body); return objs.length; };
  const catalog = add(""), pagesObj = add(""), f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"), f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const kids = pages.map(p => {
    const content = Buffer.from(p.join("\n"), "latin1");
    const c = add(`<< /Length ${content.length} >>\nstream\n${content.toString("latin1")}\nendstream`);
    return add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`);
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map(k => k + " 0 R").join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n", offs = [];
  objs.forEach((b, i) => { offs.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${b}\nendobj\n`; });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("") + `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}
