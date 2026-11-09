// Zero-dependency reader for .xlsx / .csv candidate lists + line parser.
import zlib from 'node:zlib';

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file. Save the sheet as .xlsx or .csv and try again.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    files[buf.toString('utf8', p + 46, p + 46 + nlen)] = { method, csize, off };
    p += 46 + nlen + elen + clen;
  }
  return (name) => {
    const f = files[name];
    if (!f) return null;
    const start = f.off + 30 + buf.readUInt16LE(f.off + 26) + buf.readUInt16LE(f.off + 28);
    const data = buf.subarray(start, start + f.csize);
    return (f.method === 0 ? data : zlib.inflateRawSync(data)).toString('utf8');
  };
}

const dec = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()];
});
const texts = (xml) => dec([...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)].map((x) => x[1] || '').join(''));
const colIdx = (ref) => { let n = 0; for (const ch of ref.match(/^[A-Z]+/)[0]) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

export function readXlsx(buf) {
  const get = unzip(buf);
  const ss = [];
  const sst = get('xl/sharedStrings.xml');
  if (sst) for (const m of sst.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) ss.push(texts(m[1] || ''));

  let path = 'xl/worksheets/sheet1.xml';
  const wb = get('xl/workbook.xml'), rels = get('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const rid = wb.match(/<sheet\b[^>]*?\br:id="([^"]+)"/)?.[1];
    const tag = rid && [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((t) => t.includes(`Id="${rid}"`));
    const target = tag?.match(/Target="([^"]+)"/)?.[1];
    if (target) path = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
  }
  const xml = get(path);
  if (!xml) throw new Error('Could not read the first sheet of this Excel file.');

  const rows = [];
  for (const rm of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row = [];
    for (const cm of (rm[1] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], body = cm[2] || '';
      const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
      const t = attrs.match(/\bt="(\w+)"/)?.[1];
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let val = '';
      if (t === 's') val = ss[Number(v)] ?? '';
      else if (t === 'inlineStr') val = texts(body);
      else if (v !== undefined) val = dec(v);
      row[ref ? colIdx(ref) : row.length] = val;
    }
    rows.push(Array.from(row, (x) => x ?? ''));
  }
  return rows;
}

export function readCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0] || '';
  const delim = [',', '\t', ';'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

export function readTable(buf) {
  if (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50) return readXlsx(buf);
  if (buf.length > 8 && buf.readUInt32BE(0) === 0xd0cf11e0) throw new Error('Old .xls format is not supported. In Excel use Save As and choose .xlsx or .csv.');
  return readCsv(buf.toString('utf8'));
}

const cleanCell = (v) => {
  let s = String(v ?? '').trim();
  if (/^\d+(\.\d+)?e\+?\d+$/i.test(s)) s = Number(s).toFixed(0);
  else if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
  return s;
};

// rows -> [[name, phone], ...]; detects a header row, else uses column 1 = name, column 2 = phone
export function rowsToPairs(rows) {
  rows = rows.filter((r) => r.some((c) => String(c ?? '').trim()));
  if (!rows.length) return [];
  const hasPhone = rows[0].some((c) => cleanCell(c).replace(/\D/g, '').length >= 10);
  let ni = 0, pi = 1;
  if (!hasPhone) {
    const head = rows[0].map((c) => String(c ?? '').toLowerCase());
    const n = head.findIndex((h) => /name/.test(h));
    const p = head.findIndex((h) => /phone|mobile|contact|number|whatsapp|cell/.test(h) && !/name/.test(h));
    if (n >= 0) ni = n;
    if (p >= 0) pi = p; else if (pi === ni) pi = ni + 1;
    rows = rows.slice(1);
  }
  return rows.map((r) => [String(r[ni] ?? '').trim(), cleanCell(r[pi])]);
}

// one pasted line -> [name, phone]; accepts comma, tab, semicolon, pipe, or "Name 98765 43210"
export function parseLine(line) {
  const parts = line.split(/[,\t;|]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return [parts.slice(0, -1).join(' '), parts[parts.length - 1]];
  const m = line.trim().match(/^(.*?)\s+([+\d][\d\s\-()]{8,})$/);
  return m ? [m[1].trim(), m[2].trim()] : [line.trim(), ''];
}
