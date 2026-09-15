import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
const home = process.env.USERPROFILE;
function events(sid) {
  const file = path.join(home, '.dsh', 'sessions', '--D-work-github-dsh-auto--', sid, 'session.v3.jsonl.zstd');
  const buf = fs.readFileSync(file);
  const magic = Buffer.from('28b52ffd', 'hex');
  const offs = [];
  let i = 0;
  while (true) { const idx = buf.indexOf(magic, i); if (idx < 0) break; offs.push(idx); i = idx + 4; }
  let text = '';
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
    try { text += zlib.zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8'); } catch {}
  }
  return text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
for (const sid of ['session-05045b85-56f5-482b-a498-8fee55b50ba5', 'session-a8914e7a-3943-46f5-a68d-494620fc5c64']) {
  console.log('=====', sid.slice(0, 17));
  for (const ev of events(sid)) {
    if (!String(ev.type).includes('title')) continue;
    console.log(ev.seq, ev.type, JSON.stringify(ev.data ?? null).slice(0, 260));
  }
}
