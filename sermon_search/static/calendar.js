const $ = id => document.getElementById(id);
const make = (tag, text, cls) => { const e=document.createElement(tag); if(text!==undefined)e.textContent=text; if(cls)e.className=cls; return e; };
// Construct and increment local calendar dates, avoiding UTC date shifts and DST arithmetic.
const dateKey = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const fromKey = key => {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(key || '')) return null;
  const [y,m,d]=key.split('-').map(Number), value=new Date(y,m-1,d,12);
  return y>=1900 && y<=2100 && dateKey(value)===key ? value : null;
};
const addDays = (date,n) => new Date(date.getFullYear(),date.getMonth(),date.getDate()+n,12);
const fullDate = date => date.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
const today = new Date();
let selected = dateKey(today), focus = fromKey(selected), episodes = [], byDate = new Map(), view='month';
const params = new URLSearchParams(location.search);
let savedView;
try { savedView=localStorage.getItem('skyline-calendar-view'); } catch {}
if(['month','week','agenda'].includes(params.get('view') || savedView)) view=params.get('view') || savedView;
if(fromKey(params.get('date'))) { selected=params.get('date'); focus=fromKey(selected); }
function rowsOn(key) { return byDate.get(key) || []; }
function displayTitle(e) { return e.title.replace(/^\d{1,2}\/\d{1,2}\/\d{2,4}\s*[-–:]\s*/, ''); }
function sermonCard(e) {
  const card=make('article',undefined,'calendar-sermon');
  const body=make('div');
  body.append(make('h3',displayTitle(e)),make('p',e.passages ? 'Transcript searchable' : 'Audio available · transcript pending','meta'));
  if(e.speaker) body.append(make('p',`Speaker: ${e.speaker}`,'meta speaker-credit'));
  if(e.description) {
    const details=make('details'); details.append(make('summary','About this message'),make('p',e.description,'sermon-description')); body.append(details);
  }
  const play=make('button','▶ Listen','calendar-listen');
  play.addEventListener('click',()=>window.SkylinePlayer.listen(e));
  card.append(body,play); return card;
}
function renderDetails() {
  $('day-title').textContent=fullDate(fromKey(selected));
  const rows=rowsOn(selected); $('day-count').textContent=`${rows.length} ${rows.length===1?'sermon':'sermons'}`;
  $('day-sermons').replaceChildren(...rows.map(sermonCard));
  if(!rows.length) $('day-sermons').append(make('p','No sermon is listed for this date. Select a marked date to listen.','empty'));
}
function selectDate(key) {
  selected=key; focus=fromKey(key); render();
  document.querySelector(`.calendar-day[data-date="${selected}"]`)?.focus({preventScroll:true});
}
function dateButton(date, outside=false) {
  const key=dateKey(date), rows=rowsOn(key), button=make('button',undefined,'calendar-day');
  button.type='button'; button.dataset.date=key; button.disabled=!fromKey(key);
  button.setAttribute('aria-label',`${fullDate(date)} · ${rows.length} ${rows.length===1?'sermon':'sermons'}`);
  button.setAttribute('aria-pressed',String(key===selected));
  if(key===dateKey(today)) button.setAttribute('aria-current','date');
  if(outside) button.classList.add('outside-month');
  button.append(make('span',date.getDate(),'day-number'));
  if(rows.length) {
    const marker=make('span',`${rows.length} ${rows.length===1?'sermon':'sermons'}`,'day-marker');button.append(marker);
    rows.forEach(e=>button.append(make('span',displayTitle(e)+(e.speaker ? ` · ${e.speaker}` : ''),'day-event')));
  }
  button.addEventListener('click',()=>selectDate(key));return button;
}
function range() {
  if(view==='week') { const start=addDays(focus,-focus.getDay());return [start,addDays(start,7)]; }
  return [new Date(focus.getFullYear(),focus.getMonth(),1,12),new Date(focus.getFullYear(),focus.getMonth()+1,1,12)];
}
function renderMonth(start) {
  const table=make('table',undefined,'month-calendar'); table.setAttribute('aria-label','Sermons by date');
  const head=make('thead'), header=make('tr');
  ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(day=>{const th=make('th',day);th.scope='col';header.append(th);});
  head.append(header); const body=make('tbody');
  const gridStart=addDays(start,-start.getDay());
  const days=Math.ceil((start.getDay()+new Date(start.getFullYear(),start.getMonth()+1,0).getDate())/7)*7;
  for(let n=0;n<days;n+=7) {
    const row=make('tr');
    for(let i=0;i<7;i++) {const date=addDays(gridStart,n+i),cell=make('td');cell.append(dateButton(date,date.getMonth()!==focus.getMonth()));row.append(cell);}
    body.append(row);
  }
  table.append(head,body); $('calendar-content').append(table);
}
function renderWeek(start) {
  const grid=make('div',undefined,'week-calendar');
  for(let i=0;i<7;i++) {
    const date=addDays(start,i),column=make('section',undefined,'week-day');
    column.append(make('h3',date.toLocaleDateString('en-US',{weekday:'short'})),dateButton(date));
    if(!rowsOn(dateKey(date)).length)column.append(make('p','No sermon','meta'));
    grid.append(column);
  }
  $('calendar-content').append(grid);
}
function renderAgenda(start,end) {
  const rows=episodes.filter(e=>e.date>=dateKey(start) && e.date<dateKey(end)).sort((a,b)=>a.date.localeCompare(b.date));
  if(!rows.length) { $('calendar-content').append(make('p','No sermons this month. Use the arrows or jump to another date.','empty'));return; }
  const groups=new Map(); rows.forEach(e=>{if(!groups.has(e.date))groups.set(e.date,[]);groups.get(e.date).push(e);});
  for(const [key,sermons] of groups) {
    const section=make('section',undefined,'agenda-day');section.append(make('h3',fullDate(fromKey(key)),'agenda-date'));
    sermons.forEach(e=>section.append(sermonCard(e)));$('calendar-content').append(section);
  }
}
function render() {
  const [start,end]=range();
  $('period-title').textContent=view==='week' ? `${start.toLocaleDateString('en-US',{month:'short',day:'numeric'})} – ${addDays(end,-1).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}` : focus.toLocaleDateString('en-US',{month:'long',year:'numeric'});
  $('jump-date').value=selected;
  document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===view)));
  const count=episodes.filter(e=>e.date>=dateKey(start) && e.date<dateKey(end)).length;
  $('calendar-count').textContent=`${count} ${count===1?'sermon':'sermons'} this ${view==='week'?'week':'month'}`;
  $('calendar-content').replaceChildren();
  if(view==='month')renderMonth(start);else if(view==='week')renderWeek(start);else renderAgenda(start,end);
  $('day-details').hidden=view==='agenda';if(view!=='agenda')renderDetails();
  $('previous').disabled=start.getFullYear()<=1900 && start.getMonth()===0;
  $('next').disabled=end.getFullYear()>2100;
  const url=new URL(location.href);url.searchParams.set('date',selected);url.searchParams.set('view',view);history.replaceState(null,'',url);
}
function move(n) {
  const target=view==='week' ? addDays(focus,n*7) : new Date(focus.getFullYear(),focus.getMonth()+n,1,12);
  if(target.getFullYear()<1900 || target.getFullYear()>2100)return;
  selected=dateKey(target);focus=target;render();
}
$('previous').addEventListener('click',()=>move(-1));$('next').addEventListener('click',()=>move(1));
$('today').addEventListener('click',()=>selectDate(dateKey(today)));
$('jump-date').addEventListener('change',e=>{if(fromKey(e.target.value))selectDate(e.target.value);});
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{view=b.dataset.view;try{localStorage.setItem('skyline-calendar-view',view);}catch{}render();}));
(async()=>{
  try {
    const response=await fetch('/api/episodes');if(!response.ok)throw new Error();episodes=(await response.json()).map(e=>{
      const titleDate=e.title.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
      const key=titleDate ? `${titleDate[3]}-${titleDate[1].padStart(2,'0')}-${titleDate[2].padStart(2,'0')}` : e.date;
      return {...e,date:fromKey(key) ? key : e.date};
    }).sort((a,b)=>b.date.localeCompare(a.date));
    episodes.forEach(e=>{if(!byDate.has(e.date))byDate.set(e.date,[]);byDate.get(e.date).push(e);});
    // Start on the latest available message unless the link specifies a date.
    if(!params.has('date') && episodes.length) { selected=episodes[0].date;focus=fromKey(selected); }
    $('calendar-status').textContent=`${episodes.length} sermons in the archive · dates use sermon titles, with podcast publication as a fallback.`;
    render();
  } catch { $('calendar-status').textContent='The calendar could not be loaded. Refresh to try again.'; }
})();
