import { readFileSync } from 'node:fs'
import { createZstdDecompress } from 'node:zlib'
import { Readable } from 'node:stream'
async function inflate(slice) {
  const chunks = []
  await new Promise((resolve, reject) => {
    const dec = createZstdDecompress()
    Readable.from([slice]).pipe(dec)
    dec.on('data', (c) => chunks.push(c)); dec.on('end', resolve); dec.on('error', reject)
  })
  return Buffer.concat(chunks)
}
const raw = readFileSync(process.argv[2])
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const offsets = []
let at = raw.indexOf(magic)
while (at >= 0) { offsets.push(at); at = raw.indexOf(magic, at + 1) }
const parts = []
for (let i = 0; i < offsets.length; i += 1) {
  const end = i + 1 < offsets.length ? offsets[i + 1] : raw.length
  parts.push(await inflate(raw.subarray(offsets[i], end)))
}
const events = Buffer.concat(parts).toString('utf8').split('\n').filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l).event ?? JSON.parse(l))
console.log('events=' + events.length + ' 首事件=' + events[0]?.type + ' label=' + String(events[0]?.label ?? events[0]?.title ?? ''))
const hist = {}
for (const e of events) hist[e.type] = (hist[e.type] ?? 0) + 1
console.log('类型分布: ' + Object.entries(hist).map(([k, v]) => k + '=' + v).join(' '))
const textOf = (content) => (Array.isArray(content) ? content : []).map((p) => p?.text ?? JSON.stringify(p)).join(' ').slice(0, 400)
for (const e of events) {
  if (e.type === 'assistant/message') {
    console.log('--- assistant/message stop=' + String(e.data?.message?.stopReason ?? e.data?.stopReason ?? '') + ' ---')
    console.log(textOf(e.data?.message?.content).slice(0, 700))
  }
  if (e.type === 'turn/end' || e.type === 'agent/end' || e.type === 'llm/retry') console.log('--- ' + e.type + ': ' + JSON.stringify(e.data).slice(0, 300))
}
