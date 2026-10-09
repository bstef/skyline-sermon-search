import { spawnSync } from 'node:child_process';
// Provision/bind D1 first, then apply versioned schema and metadata migrations.
// No transcription, feed sync, or AI requests are part of deployment.
for (const args of [['deploy'], ['d1', 'migrations', 'apply', 'DB', '--remote']]) {
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], {
    stdio: 'inherit', env: { ...process.env, CI: 'true' }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
