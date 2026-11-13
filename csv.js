// CSV builder. Cells starting with = + - @ are prefixed with ' so spreadsheets never run them as formulas.
export function toCsv(header, rows) {
  const cell = v => {
    if (v == null) return "";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
    let s = v instanceof Date ? v.toISOString() : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return "\uFEFF" + [header, ...rows].map(r => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
