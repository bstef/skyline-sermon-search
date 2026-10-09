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
    article.dataset.sermonId = String(e.episode_id || e.id);
    article.id = `sermon-${e.episode_id || e.id}${searching ? '-passage-'+e.id : ''}`;
    article.tabIndex = -1;
    const titleDate = e.title.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
    const titleKey = titleDate ? `${titleDate[3]}-${titleDate[1].padStart(2,'0')}-${titleDate[2].padStart(2,'0')}` : '';
    const titleValue = titleKey ? new Date(`${titleKey}T12:00:00`) : null;
    const validTitleDate = titleValue && Number(titleDate[3]) >= 1900 && Number(titleDate[3]) <= 2100 && titleValue.getFullYear() === Number(titleDate[3]) && titleValue.getMonth() + 1 === Number(titleDate[1]) && titleValue.getDate() === Number(titleDate[2]);
    const displayDate = validTitleDate ? titleKey : e.date;
    const date = new Date(`${displayDate}T12:00:00`);
    const tile = node('time', undefined, 'date-tile');
    tile.setAttribute('datetime',displayDate);
    tile.setAttribute('aria-label',date.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'}));
    const month = node('span',undefined,'date-month');
    month.append(node('span',date.toLocaleDateString('en-US',{month:'short'}).toUpperCase()),node('span',date.getFullYear(),'date-year'));
    tile.append(month,node('strong',date.getDate(),'date-day'),node('span',date.toLocaleDateString('en-US',{weekday:'long'}),'date-weekday'));
    const body = node('div'); body.append(node('h3',e.title),node('div',searching ? `Sermon passage · ${clock(e.start)}–${clock(e.end)}` : 'Skyline Church Podcast', 'meta'));
    if(e.speaker) body.append(node('div', `Speaker: ${e.speaker}`, 'meta speaker-credit'));
    if(searching) body.append(node('p',e.text,'excerpt'));
    else body.append(node('span',e.passages ? 'Transcript searchable' : 'Audio available · transcript pending','tag'));
    const play = node('button', searching ? `▶ Listen at ${clock(e.start)}` : '▶ Listen');
    play.addEventListener('click',()=>listen(e,searching ? e.start : 0,article.id));
    article.append(tile,body,play); $('results').append(article);
  });
  window.SkylinePlayer.refresh();
  if(!rows.length) $('results').append(node('div',searching ? 'No searchable passages found. Try another phrase. Sermons with pending transcripts cannot appear in search yet.' : 'No sermons imported yet. Run the podcast sync command to load the library.','empty'));
}
function browse() {
  if(controller) controller.abort();
  $('query').value = ''; $('clear-search').hidden = true;
  $('section-title').textContent = 'The sermon library'; $('browse').hidden = true; $('notice').hidden = true; $('status').textContent = '';
  render(library.slice(0,visible)); $('more').hidden = visible >= library.length;
  const url = new URL(location.href); url.search = ''; history.replaceState(null,'',url);
}
async function search() {
  const q = $('query').value.trim(); if(!q) { browse(); return; }
  $('clear-search').hidden = false;
  if(controller) controller.abort(); controller = new AbortController();
  const signal = controller.signal;
  const mode = document.querySelector('input[name=mode]:checked').value;
  $('section-title').textContent = 'Search results'; $('status').textContent = 'Searching the sermon archive…'; $('notice').hidden = true; $('more').hidden = true; $('browse').hidden = false;
  $('results').replaceChildren();
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}&mode=${mode}`,signal);
    if(signal.aborted) return;
    $('status').textContent = `${data.results.length} passages · ${data.mode === 'hybrid' ? 'Words & meaning' : 'Keyword search'} · ${data.elapsed_ms} ms`;
    $('notice').textContent = data.notice || ''; $('notice').hidden = !data.notice;
    render(data.results,true);
    const url = new URL(location.href); url.searchParams.set('q',q); url.searchParams.set('mode',mode); history.replaceState(null,'',url);
  } catch(e) { if(e.name!=='AbortError') $('status').textContent = e.message; }
}
window.SkylinePlayer.registerReveal((episode, entryId) => {
  if (document.getElementById(entryId)) return;
  const id = episode.episode_id || episode.id;
  if ([...document.querySelectorAll('[data-sermon-id]')].some(row => row.dataset.sermonId === String(id))) return;
  const index = library.findIndex(e => e.id === id);
  if (index >= 0) { visible = Math.max(visible, index + 1); browse(); }
});
$('search-form').addEventListener('submit',e=>{ e.preventDefault(); search(); });
document.querySelectorAll('[data-query]').forEach(e=>e.addEventListener('click',()=>{ $('query').value=e.dataset.query; search(); }));
$('query').addEventListener('input',()=>{
  $('clear-search').hidden = !$('query').value;
  if(!$('query').value.trim()) browse();
});
$('clear-search').addEventListener('click',()=>{ browse(); $('query').focus(); });
$('browse').addEventListener('click',()=>{ browse(); $('query').focus(); });
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
