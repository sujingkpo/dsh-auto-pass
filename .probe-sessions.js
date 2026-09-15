const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const home = process.env.USERPROFILE;
const dir = path.join(home, '.dsh', 'dsh-auto-pass', 'records');
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.json')) continue;
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { console.log(f, 'PARSE FAIL', e.message); continue; }
  const list = Array.isArray(data) ? data : (data.records || []);
  const ids = new Map();
  for (const r of list) { const k = String(r.sessionId); ids.set(k, (ids.get(k) || 0) + 1); }
  console.log('==', f, 'records=', list.length, 'sessions=', ids.size);
  for (const [k, n] of ids) console.log('   ', k, 'x' + n);
}
