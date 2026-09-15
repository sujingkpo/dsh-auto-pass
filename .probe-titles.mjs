import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
const home = process.env.USERPROFILE;
const targets = ['session-a8914e7a-3943-46f5-a68d-494620fc5c64','session-6f985849-5fc1-476f-8237-035d6ff614c1','session-05045b85-56f5-482b-a498-8fee55b50ba5','session-0faff011-dfb8-4d78-9771-9d2d2c1352e9','session-d2ff9f56-f21f-4bd4-8876-6745f12cfc4b','session-421e2f2a-3c54-4e95-af96-ad361c93e15c','session-0c0fd692-0fa1-4b4e-b357-f68a1fa0720a','session-114853fa-43be-4f61-80fb-7cf911843fa5'];
const magic = Buffer.from('28b52ffd', 'hex');
function decodeAll(buf) {
  const offs = [];
  let i = 0;
  while (true) { const idx = buf.indexOf(magic, i); if (idx < 0) break; offs.push(idx); i = idx + 4; }
  let out = '';
  for (let k = 0; k < offs.length; k++) {
    const start = offs[k];
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
    try { out += zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8'); } catch (e) { /* frame with trailing garbage */ }
  }
  return out;
}
for (const sid of targets) {
  const file = path.join(home, '.dsh', 'sessions', '--D-work-github-dsh-auto--', sid, 'session.v3.jsonl.zstd');
  if (!fs.existsSync(file)) { console.log('###', sid.slice(0,17), 'MISSING'); continue; }
  const text = decodeAll(fs.readFileSync(file));
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const titles = [];
  let firstUser = null;
  for (const line of lines) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'session/title') titles.push(ev.data);
    if (ev.type === 'user/message' && firstUser === null) firstUser = ev.data;
  }
  console.log('###', sid.slice(0,17), 'events=', lines.length);
  for (const t of titles) console.log('    title=', JSON.stringify(t.title), 'source=', JSON.stringify(t.source));
  if (firstUser) {
    const txt = (firstUser.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').slice(0, 100);
    console.log('    firstUserMsg=', JSON.stringify(txt));
  }
}
