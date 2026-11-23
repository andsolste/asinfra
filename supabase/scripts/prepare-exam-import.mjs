import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const canonical = value => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(v => JSON.parse(canonical(v)))
    : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical(value[k]))])) : value)
const fail = message => { throw new Error(message) }
export function validatePackage(data) {
  const { package_sha256, ...content } = data
  if (createHash('sha256').update(canonical(content)).digest('hex') !== package_sha256) fail('Package checksum mismatch')
  const e = data.exam
  if (!e || !/^[a-z0-9-]+$/.test(e.id) || !Number.isInteger(e.version) || e.version < 1 || !/^[a-f0-9]{64}$/.test(e.source_sha256)) fail('Invalid exam identity')
  for (const key of ['title','course','source_name','introduction']) if (typeof e[key] !== 'string') fail('Missing exam metadata')
  if (!Array.isArray(data.questions) || !data.questions.length || !Array.isArray(data.assets)) fail('Missing content')
  const numbers = new Set(), assets = new Map()
  for (const a of data.assets) {
    if (assets.has(a.id) || !['prompt','guide'].includes(a.purpose) || !/^[a-zA-Z0-9-]+$/.test(a.id)) fail('Invalid asset identity')
    const png = Buffer.from(a.base64, 'base64')
    if (png.subarray(0,8).toString('hex') !== '89504e470d0a1a0a' || a.base64.length > 4000000) fail('Invalid PNG')
    assets.set(a.id, a)
  }
  for (const q of data.questions) {
    if (numbers.has(q.number) || !Number.isInteger(q.number) || q.number < 1 || !Number.isFinite(q.max_points) || q.max_points < 0 || !q.source_pages?.length || !q.source_pages.every(p => Number.isInteger(p) && p > 0)) fail('Invalid question metadata')
    numbers.add(q.number)
    if (!['verified','manual'].includes(q.review_status) || !['automatic','self','unverified'].includes(q.grading)) fail('Invalid review state')
    const fields = new Map()
    for (const f of q.prompt.fields) {
      if (fields.has(f.id) || !['single','multiple','text','select'].includes(f.kind) || typeof f.label !== 'string') fail('Invalid field')
      fields.set(f.id, f)
      if (f.kind !== 'text' && (!f.options?.length || new Set(f.options.map(o => o.id)).size !== f.options.length)) fail('Invalid options')
      const key = q.correct?.[f.id]
      if (q.grading === 'automatic' && q.review_status === 'verified' && key === undefined) fail('Missing verified key')
      if (key !== undefined && (f.kind === 'multiple' ? !Array.isArray(key) || !key.length || new Set(key).size !== key.length : typeof key !== 'string' || !key)) fail('Invalid key type')
      if (key !== undefined && (f.kind === 'text' || (Array.isArray(key) ? key : [key]).some(id => !f.options.some(o => o.id === id)))) fail('Unknown key')
    }
    for (const b of q.prompt.blocks) {
      if (b.type === 'field' && !fields.has(b.id)) fail('Unknown field reference')
      else if (b.type === 'image' && (assets.get(b.asset)?.purpose !== 'prompt' || assets.get(b.asset)?.number !== q.number)) fail('Unsafe prompt image')
      else if (!['text','field','image'].includes(b.type)) fail('Unknown block')
    }
    const references = q.prompt.blocks.filter(b => b.type === 'field').map(b => b.id)
    if (!fields.size || references.length !== fields.size || new Set(references).size !== fields.size) fail('Fields must appear exactly once')
    for (const id of q.guide_assets) if (assets.get(id)?.purpose !== 'guide' || assets.get(id)?.number !== q.number) fail('Unsafe guidance image')
    if (q.review_status === 'manual' && Object.keys(q.correct).length) fail('Unverified key must be empty')
  }
  for (const a of assets.values()) if (!numbers.has(a.number)) fail('Orphan asset')
  return data
}
export async function prepare(input, output, grantee) {
  if (grantee && !/^[a-f0-9-]{36}$/i.test(grantee)) fail('Invalid user UUID')
  const data = validatePackage(JSON.parse(await readFile(input, 'utf8')))
  const encoded = Buffer.from(JSON.stringify(data)).toString('base64')
  const sql = `-- Private content; do not commit or publish. Run only after explicit approval.\nbegin;\nselect exam_private.import_package(convert_from(decode('${encoded}','base64'),'UTF8')::jsonb,${grantee ? `'${grantee}'::uuid` : 'null'});\ncommit;\n`
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, sql)
  return { questions: data.questions.length, scored: data.questions.filter(q => q.max_points > 0).length }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output, grantee] = process.argv.slice(2)
  if (!input || !output) throw new Error('Usage: node supabase/scripts/prepare-exam-import.mjs PRIVATE.json PRIVATE.sql [user-uuid]')
  console.log(await prepare(input, output, grantee))
}
