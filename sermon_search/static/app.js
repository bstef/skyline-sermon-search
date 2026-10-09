const $ = id => document.getElementById(id);
let library = [], visible = 12, controller;
const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function node(tag, text, cls) { const e = document.createElement(tag); if(text !== undefined) e.textContent = text; if(cls) e.className = cls; return e; }
async function api(url, signal) { const r = await fetch(url, {signal}); if(!r.ok) throw new Error('The library could not be loaded. Please try again.'); return r.json(); }
const listen = window.SkylinePlayer.listen;
function render(rows, searching=false) {
  $('results').replaceChildren();
  rows.forEach(e => {
    const article = node('article', undefined, 'card');
    const date = new Date(`${e.date}T12:00:00`);
    const tile = node('div', undefined, 'date-tile');
    tile.append(node('span',date.toLocaleDateString('en-US',{month:'short'}).toUpperCase()),node('strong',date.getDate()),node('span',date.getFullYear()));
    const body = node('div'); body.append(node('h3',e.title),node('div',searching ? `Sermon passage · ${clock(e.start)}–${clock(e.end)}` : 'Skyline Church Podcast', 'meta'));
    if(searching) body.append(node('p',e.text,'excerpt'));
    else body.append(node('span',e.passages ? 'Transcript searchable' : 'Audio available · transcript pending','tag'));
    const play = node('button', searching ? `▶ Listen at ${clock(e.start)}` : '▶ Listen');
    play.addEventListener('click',()=>listen(e,searching ? e.start : 0));
    article.append(tile,body,play); $('results').append(article);
  });
  if(!rows.length) $('results').append(node('div',searching ? 'No searchable passages found. Try another phrase. Sermons with pending transcripts cannot appear in search yet.' : 'No sermons imported yet. Run the podcast sync command to load the library.','empty'));
}
function browse() {
  if(controller) controller.abort();
  $('section-title').textContent = 'The sermon library'; $('browse').hidden = true; $('notice').hidden = true; $('status').textContent = '';
  render(library.slice(0,visible)); $('more').hidden = visible >= library.length;
  const url = new URL(location.href); url.search = ''; history.replaceState(null,'',url);
}
async function search() {
  const q = $('query').value.trim(); if(!q) return;
  if(controller) controller.abort(); controller = new AbortController();
  const signal = controller.signal;
  const mode = document.querySelector('input[name=mode]:checked').value;
  $('section-title').textContent = 'Search results'; $('status').textContent = 'Searching the sermon archive…'; $('notice').hidden = true; $('more').hidden = true; $('browse').hidden = false;
  $('results').replaceChildren();
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}&mode=${mode}`,signal);
    $('status').textContent = `${data.results.length} passages · ${data.mode === 'hybrid' ? 'Words & meaning' : 'Keyword search'} · ${data.elapsed_ms} ms`;
    $('notice').textContent = data.notice || ''; $('notice').hidden = !data.notice;
    render(data.results,true);
    const url = new URL(location.href); url.searchParams.set('q',q); url.searchParams.set('mode',mode); history.replaceState(null,'',url);
  } catch(e) { if(e.name!=='AbortError') $('status').textContent = e.message; }
}
$('search-form').addEventListener('submit',e=>{ e.preventDefault(); search(); });
document.querySelectorAll('[data-query]').forEach(e=>e.addEventListener('click',()=>{ $('query').value=e.dataset.query; search(); }));
$('browse').addEventListener('click',browse);
$('more').addEventListener('click',()=>{visible+=12;render(library.slice(0,visible));$('more').hidden=visible>=library.length;});
(async()=>{
  try {
    const [stats, episodes] = await Promise.all([api('/api/stats'),api('/api/episodes')]);
    library = episodes; $('coverage').textContent = `${stats.episodes} sermons · ${stats.indexed} transcribed`;
    const params = new URLSearchParams(location.search);
    if(params.has('q')) { $('query').value=params.get('q'); if(params.get('mode')==='keyword') document.querySelector('[value=keyword]').checked=true; await search(); }
    else browse();
  } catch(e) { $('coverage').textContent='Library unavailable'; $('status').textContent=e.message; }
})();
