'use strict';
function encodeCSV(words) {
  const cell = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const safe = (word) => /^[=+\-@\t\r']/.test(word) ? `'${word}` : word;
  return '\ufeffword,frequency,hidden\r\n' + words.map((w) => [safe(w.word), w.frequency, w.hidden ? 1 : 0].map(cell).join(',')).join('\r\n');
}
function decodeCSV(text) {
  if (typeof text !== 'string') throw Object.assign(new Error('CSV 需为文本。'), { status: 422 });
  const rows = []; let row = [], field = '', quoted = false;
  text = text.replace(/^\ufeff/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { if (quoted && text[i + 1] === '"') { field += '"'; i++; } else if (!quoted && field) throw Object.assign(new Error('CSV 引号格式不正确。'), { status: 422 }); else quoted = !quoted; }
    else if (ch === ',' && !quoted) { row.push(field); field = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field); if (row.some(Boolean)) rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (quoted) throw Object.assign(new Error('CSV 引号未闭合。'), { status: 422 });
  row.push(field); if (row.some(Boolean)) rows.push(row);
  const header = rows.shift();
  if (JSON.stringify(header) !== JSON.stringify(['word','frequency','hidden']) || rows.some((r) => r.length !== 3)) throw Object.assign(new Error('CSV 列需为 word,frequency,hidden。'), { status: 422 });
  return { words: rows.map(([word,frequency,hidden]) => ({ word: /^'[=+\-@\t\r']/.test(word) ? word.slice(1) : word, frequency: Number(frequency), hidden })) };
}
module.exports = { encodeCSV, decodeCSV };
