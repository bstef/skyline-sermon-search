import { createHash } from 'node:crypto';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { Miniflare } from 'miniflare';
import { search } from '../worker/index.ts';
let mf, db;
before(async () => {
  const source = await readFile('worker/index.ts','utf8');
  const { code } = await transform(source,{loader:'ts',format:'esm'});
  mf = new Miniflare({ workers: [{ config: { name:'test', compatibilityDate:'2026-10-08', manifest:{mainModule:'index.js',modules:{'index.js':{type:'esm',contents:code}}}, env:{DB:{type:'d1',id:'test-db'}} } }] });
  db = await mf.getD1Database('DB');
  const schema = await readFile('migrations/0001_schema.sql','utf8');
  const statements = schema.match(/CREATE TRIGGER[\s\S]*?END;|CREATE (?:TABLE|INDEX|VIRTUAL TABLE)[\s\S]*?;/g);
  await db.batch(statements.map(s=>db.prepare(s)));
  const credits = await readFile('migrations/0003_speaker_credits.sql','utf8');
  for (const statement of credits.split('\n').filter(s => s.startsWith('ALTER TABLE'))) await db.prepare(statement).run();
  await db.prepare('INSERT INTO episodes(id,title,date,audio_url,description,link,speaker,speaker_source) VALUES(?,?,?,?,?,?,?,?)').bind('sermon','Sunday faith','2026-09-20','https://example.com/audio.mp3','Description','','Jane Doe','description').run();
  await db.prepare('INSERT INTO passages VALUES(?,?,?,?,?,?,?)').bind(1,'sermon',120,180,'Faith and hope in difficult seasons',null,null).run();
  await db.prepare('INSERT INTO passages VALUES(?,?,?,?,?,?,?)').bind(2,'sermon',170,220,'Faith and hope continued',null,null).run();
});
after(async()=>{await mf?.dispose();});
test('API lists dates and transcript coverage from D1',async()=>{
  const episodes=await (await mf.dispatchFetch('https://app.test/api/episodes')).json();
  assert.equal(episodes[0].date,'2026-09-20'); assert.equal(episodes[0].passages,2); assert.equal(episodes[0].speaker,'Jane Doe');
  const stats=await (await mf.dispatchFetch('https://app.test/api/stats')).json();
  assert.deepEqual(stats,{episodes:1,indexed:1,passages:2,embedded:0});
});
test('FTS returns timestamped passages and removes overlapping hits',async()=>{
  const res=await mf.dispatchFetch('https://app.test/api/search?q=faith&mode=keyword');
  assert.equal(res.status,200); const data=await res.json();
  assert.equal(data.results.length,1); assert.equal(data.results[0].episode_id,'sermon');
  assert.equal(data.results[0].speaker,'Jane Doe'); assert.equal(data.mode,'keyword'); assert.ok(data.results[0].start>=120);
});
test('smart mode honestly falls back without AI; invalid queries and writes rejected',async()=>{
  const data=await (await mf.dispatchFetch('https://app.test/api/search?q=hope')).json();
  assert.equal(data.mode,'keyword'); assert.match(data.notice,/Meaning search needs/);
  for(const url of ['?q=','?q=faith&mode=bad',`?q=${'x'.repeat(301)}`]) assert.equal((await mf.dispatchFetch('https://app.test/api/search'+url)).status,422);
  assert.equal((await mf.dispatchFetch('https://app.test/api/stats',{method:'POST'})).status,405);
  assert.equal((await mf.dispatchFetch('https://app.test/api/missing')).status,404);
  assert.deepEqual((await (await mf.dispatchFetch('https://app.test/api/search?q=%22%3B%20DROP%20TABLE&mode=keyword')).json()).results,[]);
});
test('FTS updates when transcript text changes',async()=>{
  await db.prepare('UPDATE passages SET text=? WHERE id=2').bind('Grace renews us').run();
  const data=await (await mf.dispatchFetch('https://app.test/api/search?q=grace&mode=keyword')).json();
  assert.equal(data.results[0].id,2); assert.equal(data.results[0].start,170);
});
test('semantic-only hits work and provider failure falls back',async()=>{
  await db.prepare('UPDATE passages SET embedding=?,model=? WHERE id=2').bind('[]','text-embedding-3-small').run();
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async()=>Response.json({data:[{embedding:Array(512).fill(.1)}]});
    const env={OPENAI_API_KEY:'test',VECTOR_INDEX:{query:async()=>({matches:[{id:'2-'+createHash('sha256').update('Grace renews us').digest('hex').slice(0,16),score:.9}]})}};
    const data=await search(db,'forgiveness','smart',env);
    assert.equal(data.mode,'hybrid'); assert.equal(data.results[0].id,2);
    const stale=await search(db,'forgiveness','smart',{...env,VECTOR_INDEX:{query:async()=>({matches:[{id:'2-0000000000000000',score:.9}]})}});
    assert.deepEqual(stale.results,[]);
    globalThis.fetch=async()=>{throw new Error('Provider unavailable');};
    const fallback=await search(db,'faith','smart',env);
    assert.equal(fallback.mode,'keyword'); assert.match(fallback.notice,/temporarily unavailable/);
    assert.equal(fallback.results[0].id,1);
  } finally {globalThis.fetch=original;}
});
