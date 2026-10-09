(() => {
  const player = document.getElementById('player');
  const panel = document.getElementById('player-panel');
  const entryLink = document.getElementById('player-entry');
  let current = null, revealEntry = null;
  const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const episodeId = e => String(e.episode_id || e.id);
  function entries() {
    return [...document.querySelectorAll('[data-sermon-id]')].filter(row => current && row.dataset.sermonId === current.id);
  }
  function refresh() {
    document.querySelectorAll('[data-sermon-id]').forEach(row => {
      const active = current && row.dataset.sermonId === current.id;
      row.classList.toggle('is-current', Boolean(active));
      row.classList.toggle('is-playing', Boolean(active && !player.paused && !player.ended));
      row.querySelector('.playback-badge')?.remove();
      if (active) {
        const badge = document.createElement('span'); badge.className = 'playback-badge';
        badge.textContent = !player.paused && !player.ended ? 'Playing' : player.ended ? 'Finished' : 'Selected in player';
        row.querySelector('h3')?.after(badge);
      }
    });
    if (current) {
      const row = entries().find(row => row.id === current.entryId) || entries()[0];
      entryLink.href = `#${row?.id || current.entryId}`;
    }
  }
  function listen(e, start=0, entryId) {
    player.pause();
    const selection = { id: episodeId(e), episode: e, entryId: entryId || `sermon-${episodeId(e)}` };
    current = selection;
    panel.hidden = false;
    document.getElementById('player-title').textContent = e.title;
    document.getElementById('player-status').textContent = start ? `Starting at ${clock(start)}` : '';
    player.src = `${e.audio_url}#t=${start}`;
    player.onloadedmetadata = async () => {
      if (current !== selection) return;
      try { player.currentTime = start; await player.play(); }
      catch { if (current === selection) document.getElementById('player-status').textContent = 'Press play to listen. Seeking depends on the podcast host.'; }
    };
    player.onerror = () => {
      if (current === selection) document.getElementById('player-status').textContent = 'Audio could not be loaded from the podcast host.';
    };
    player.load(); refresh();
  }
  entryLink.addEventListener('click', event => {
    event.preventDefault();
    if (!current) return;
    revealEntry?.(current.episode, current.entryId);
    refresh();
    const row = entries().find(row => row.id === current.entryId) || entries()[0];
    if (!row) return;
    row.focus({ preventScroll: true });
    row.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
  });
  ['play','pause','ended','emptied'].forEach(event => player.addEventListener(event, refresh));
  document.getElementById('close-player').addEventListener('click', () => {
    current = null; player.onloadedmetadata = null; player.onerror = null;
    player.pause(); player.removeAttribute('src'); player.load(); panel.hidden = true; refresh();
  });
  window.SkylinePlayer = { listen, refresh, registerReveal: callback => { revealEntry = callback; } };
})();
