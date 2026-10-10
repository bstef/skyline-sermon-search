import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
let mf,db;
const token='test-only-publishing-token';
const sample=JSON.parse(await readFile('integrations/n8n/sample-publication.json','utf8'));
const actual={...sample,sample:false,dry_run:false,episode:{...sample.episode,id:'aaaaaaaaaaaaaaaaaaaa'}};
async function post(payload, key=token) {
  return mf.dispatchFetch('https://app.test/api/admin/transcripts',{method:'POST',headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
}
before(async()=>{
  const built=await build({entryPoints:['worker/index.ts'],bundle:true,write:false,format:'esm'});
  mf=new Miniflare({workers:[{config:{name:'publishing-test',compatibilityDate:'2026-10-08',manifest:{mainModule:'index.js',modules:{'index.js':{type:'esm',contents:built.outputFiles[0].text}}},env:{DB:{type:'d1',id:'publishing-test-db'},TRANSCRIPT_PUBLISH_TOKEN:{type:'text',value:token}}}}]});
  db=await mf.getD1Database('DB');
  const schema=await readFile('migrations/0001_schema.sql','utf8');
  await db.batch(schema.match(/CREATE TRIGGER[\s\S]*?END;|CREATE (?:TABLE|INDEX|VIRTUAL TABLE)[\s\S]*?;/g).map(s=>db.prepare(s)));
  for(const s of (await readFile('migrations/0003_speaker_credits.sql','utf8')).split('\n').filter(s=>s.startsWith('ALTER TABLE'))) await db.prepare(s).run();
  await db.prepare(await readFile('migrations/0004_transcript_publications.sql','utf8')).run();
});
after(async()=>{await mf?.dispose();});
test('auth rejects invalid/missing keys and public APIs remain read-only',async()=>{
  for(const key of ['', 'incorrect', 'x'.repeat(600)]) assert.equal((await post(sample,key)).status,401);
  assert.equal((await mf.dispatchFetch('https://app.test/api/admin/transcripts')).status,405);
  assert.equal((await mf.dispatchFetch('https://app.test/api/episodes',{method:'POST'})).status,405);
});
test('sample validation and omitted dry_run never write to public search',async()=>{
  const res=await post(sample); assert.equal(res.status,200); assert.equal((await res.json()).status,'validated');
  const {dry_run,...safeDefault}=actual;
  assert.equal((await (await post(safeDefault)).json()).status,'validated');
  const stats=await (await mf.dispatchFetch('https://app.test/api/stats')).json();
  assert.equal(stats.episodes,0); assert.equal(stats.passages,0);
  assert.equal((await post({...sample,dry_run:false})).status,422);
});
test('bad timestamps, metadata and booleans are rejected',async()=>{
  const bad=[{...sample,dry_run:'false'},{...sample,sample:'false'},
    {...sample,episode:{...sample.episode,date:'2026-02-30'}},
    {...sample,episode:{...sample.episode,audio_url:'javascript:alert(1)'}},
    {...sample,segments:[{start:8,end:10,text:'later'},{start:0,end:2,text:'earlier'}]},
    {...sample,segments:[{start:0,end:-1,text:'bad'}]}, {...sample,segments:[]}];
  for(const payload of bad) assert.equal((await post(payload)).status,422);
});
test('publication creates a new episode, indexed timestamps and stable retries',async()=>{
  const first=await post(actual); assert.equal(first.status,200); assert.equal((await first.json()).status,'published');
  const rows=await db.prepare('SELECT id FROM passages WHERE episode_id=?').bind(actual.episode.id).all();
  assert.equal((await (await post(actual)).json()).status,'already_published');
  assert.deepEqual((await db.prepare('SELECT id FROM passages WHERE episode_id=?').bind(actual.episode.id).all()).results,rows.results);
  const search=await (await mf.dispatchFetch('https://app.test/api/search?q=synthetic&mode=keyword')).json();
  assert.equal(search.results[0].episode_id,actual.episode.id); assert.equal(search.results[0].start,0); assert.equal(search.results[0].end,16);
});
test('replacement refreshes FTS; a failed transaction preserves old transcript',async()=>{
  const revised={...actual,segments:[{start:42,end:50,text:'Replacement fixture with uniqueword.'}]};
  assert.equal((await (await post(revised)).json()).status,'published');
  assert.equal((await (await mf.dispatchFetch('https://app.test/api/search?q=synthetic&mode=keyword')).json()).results.length,0);
  await db.prepare("CREATE TRIGGER reject_fixture BEFORE INSERT ON passages WHEN NEW.text='FAIL_FIXTURE' BEGIN SELECT RAISE(ABORT,'test failure'); END;").run();
  assert.equal((await post({...actual,segments:[{start:0,end:10,text:'FAIL_FIXTURE'}]})).status,503);
  const result=await (await mf.dispatchFetch('https://app.test/api/search?q=uniqueword&mode=keyword')).json();
  assert.equal(result.results[0].start,42);
  assert.equal((await (await post(revised)).json()).status,'already_published');
});
test('concurrent repeated publications do not duplicate rows',async()=>{
  const payload={...actual,episode:{...actual.episode,id:'bbbbbbbbbbbbbbbbbbbb'}};
  const responses=await Promise.all([post(payload),post(payload)]);
  assert.ok(responses.every(r=>r.status===200));
  assert.equal((await db.prepare('SELECT count(*) AS n FROM passages WHERE episode_id=?').bind(payload.episode.id).first()).n,1);
});

// Run the cancelled upload last: Miniflare shares its transport with the D1 proxy.
test('oversized bodies are rejected before database writes',async()=>{
  const response=await post({...sample,padding:'x'.repeat(1024*1024)});
  assert.equal(response.status,422);
  await response.text();
});
