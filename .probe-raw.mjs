import fs from 'node:fs';
import path from 'node:path';
const home = process.env.USERPROFILE;
const file = path.join(home, '.dsh', 'sessions', '--D-work-github-dsh-auto--', 'session-0c0fd692-0fa1-4b4e-b357-f68a1fa0720a', 'session.v3.jsonl.zstd');
const buf = fs.readFileSync(file);
console.log('size', buf.length);
console.log('head hex', buf.subarray(0, 64).toString('hex'));
const magic = Buffer.from('28b52ffd', 'hex');
const offsets = [];
let i = 0;
while (true) {
  const idx = buf.indexOf(magic, i);
  if (idx < 0) break;
  offsets.push(idx);
  i = idx + 4;
}
console.log('magic count', offsets.length, 'first 10', offsets.slice(0, 10));
// print bytes right after first frame's end guess
console.log('bytes 195-260', buf.subarray(195, 260).toString('hex'));
