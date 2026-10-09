function playSermon(e, start=0) {
  const player = document.getElementById('player'); player.pause();
  document.getElementById('player-panel').hidden = false; document.getElementById('player-title').textContent = e.title;
  document.getElementById('player-status').textContent = start ? `Starting at ${clock(start)}` : '';
  player.src = `${e.audio_url}#t=${start}`;
  player.onloadedmetadata = async () => { try { player.currentTime = start; await player.play(); } catch { document.getElementById('player-status').textContent = 'Press play to listen. Seeking depends on the podcast host.'; } };
  player.onerror = () => { document.getElementById('player-status').textContent = 'Audio could not be loaded from the podcast host.'; };
  player.load();
}
window.SkylinePlayer = { listen: playSermon };
document.getElementById('close-player').addEventListener('click',()=>{const player=document.getElementById('player');player.pause();player.removeAttribute('src');player.load();document.getElementById('player-panel').hidden=true;});
