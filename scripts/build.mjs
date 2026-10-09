import { cp, mkdir, rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist/static', { recursive: true });
await cp('sermon_search/static', 'dist/static', { recursive: true });
await cp('sermon_search/static/index.html', 'dist/index.html');
await cp('sermon_search/static/calendar.html', 'dist/calendar.html');
console.log('Built search, calendar, logos, fonts, and themes. No transcription runs during builds.');
