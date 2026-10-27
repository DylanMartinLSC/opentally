// CSV export.

export function csvField(v) {
  if (typeof v === 'number') return String(v);
  let s = String(v ?? '');
  // Stop spreadsheets from evaluating text as a formula.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const row = (fields) => fields.map(csvField).join(',');
const round1 = (v) => Math.round(v * 10) / 10;

export function markersToCSV(session) {
  const lines = [row(['index', 'category', 'x', 'y', 'source'])];
  session.markers.forEach((m, i) => {
    const c = session.category(m.categoryId);
    lines.push(row([i + 1, c ? c.name : '', round1(m.x), round1(m.y), m.source]));
  });
  return lines.join('\n') + '\n';
}

export function summaryToCSV(session) {
  const lines = [row(['category', 'count'])];
  for (const c of session.categories) lines.push(row([c.name, session.count(c.id)]));
  lines.push(row(['Total', session.total()]));
  return lines.join('\n') + '\n';
}
