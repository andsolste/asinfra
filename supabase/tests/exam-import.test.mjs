import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {validatePackage} from '../scripts/prepare-exam-import.mjs'
const sort=v=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v
const seal=p=>{delete p.package_sha256;return {...p,package_sha256:createHash('sha256').update(JSON.stringify(sort(p))).digest('hex')}}
const fixture=()=>seal({exam:{id:'synthetic',version:1,title:'Synthetic',course:'Test',source_name:'Test',source_sha256:'a'.repeat(64),introduction:'Test'},assets:[{id:'guide-2',number:2,purpose:'guide',base64:'iVBORw0KGgo='}],questions:[{number:2,max_points:1,source_pages:[1],grading:'automatic',review_status:'verified',correct:{p1:'a'},guide_assets:['guide-2'],prompt:{blocks:[{type:'field',id:'p1'}],fields:[{id:'p1',label:'Answer',kind:'single',options:[{id:'a',text:'A'},{id:'b',text:'B'}]}]}}]})
test('private import refuses tampering, guidance-as-prompt, unknown/mistyped keys and duplicate fields',()=>{
  assert.equal(validatePackage(fixture()).questions.length,1)
  const tampered=fixture();tampered.exam.title='Modified';assert.throws(()=>validatePackage(tampered),/checksum/)
  const invalid=change=>{const p=fixture();change(p);return()=>validatePackage(seal(p))}
  assert.throws(invalid(p=>p.questions[0].prompt.blocks.push({type:'image',asset:'guide-2'})),/Unsafe prompt/)
  assert.throws(invalid(p=>p.questions[0].correct.p1='missing'),/Unknown key/)
  assert.throws(invalid(p=>p.questions[0].correct.p1=['a']),/Invalid key type/)
  assert.throws(invalid(p=>p.questions[0].prompt.blocks.push({type:'field',id:'p1'})),/exactly once/)
  assert.throws(invalid(p=>p.questions[0].review_status='manual'),/Unverified key/)
  assert.throws(invalid(p=>p.questions[0].source_pages=[]),/metadata/)
})
