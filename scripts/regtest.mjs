import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const checkout = path.join(root, '.cache/arkade-regtest');
const environmentFile = path.resolve(process.env.STRIKER_REGTEST_ENV ?? path.join(root, ".env.regtest"));
const revision = '9ac38fe94585bf99a65581d2e79eda63c7e61b6b';
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const [command = 'start', ...args] = process.argv.slice(2);
if (!existsSync(path.join(checkout, '.git'))) {
  mkdirSync(path.dirname(checkout), { recursive: true });
  run('git', ['clone', '--no-checkout', 'https://github.com/ArkLabsHQ/arkade-regtest.git', checkout]);
  run('git', ['checkout', '--detach', revision], checkout);
}
const actual = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' });
if (actual.stdout?.trim() !== revision) throw new Error(`Regtest checkout must be pinned to ${revision}`);
if (command === 'setup') process.exit(0);
if (command === 'start') {
  const config = parseEnv(readFileSync(environmentFile, 'utf8'));
  if (config.EMULATOR_IMAGE === 'striker-emulator:v0.0.9-rc.2-striker.1') {
    const found = spawnSync('docker', ['image', 'inspect', config.EMULATOR_IMAGE], { stdio: 'ignore' });
    if (found.status !== 0) run('docker', ['build', '-f', 'docker/emulator.Dockerfile', '-t', config.EMULATOR_IMAGE, '.']);
  }
}
run(process.execPath, [path.join(checkout, 'regtest.mjs'), command, '--env', environmentFile, ...args]);

if (command === 'start') {
  // Existing arkd volumes keep their initial settings in the database, ahead of
  // environment defaults. Explicitly apply this project's configured locktimes.
  const config = { ...parseEnv(readFileSync(path.join(checkout, '.env.defaults'), 'utf8')),
    ...parseEnv(readFileSync(environmentFile, 'utf8')), ...process.env };
  const settings = [
    ['--vtxo-tree-expiry', 'ARKD_VTXO_TREE_EXPIRY'],
    ['--unilateral-exit-delay', 'ARKD_UNILATERAL_EXIT_DELAY'],
    ['--public-unilateral-exit-delay', 'ARKD_PUBLIC_UNILATERAL_EXIT_DELAY'],
    ['--boarding-exit-delay', 'ARKD_BOARDING_EXIT_DELAY'],
    ['--checkpoint-exit-delay', 'ARKD_CHECKPOINT_EXIT_DELAY'],
  ].flatMap(([flag, name]) => [flag, config[name]]);
  const upstream = (values) => run(process.execPath,
    [path.join(checkout, 'regtest.mjs'), ...values, '--env', environmentFile]);
  upstream(['arkd', 'settings', 'update', ...settings]);
  // arkd caches its derived checkpoint script until restart. Apply settings
  // before wallets initialize, then refresh the CLI against that same script.
  run('docker', ['restart', `${config.REGTEST_CONTAINER_PREFIX ?? ''}arkd`]);
  const endpoint = `http://127.0.0.1:${config.ARKD_PORT ?? '7070'}/v1/info`;
  const deadline = Date.now() + 30_000;
  while (true) {
    try { if ((await fetch(endpoint)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error('Regtest arkd did not restart');
    await new Promise(resolve => setTimeout(resolve, 250));
  }


  const container = `${config.REGTEST_CONTAINER_PREFIX ?? ''}arkd`;
  function capture(args) {
    const result = spawnSync('docker', ['exec', container, 'ark', ...args], { encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error('Could not refresh the local regtest faucet');
    return result.stdout;
  }
  // The upstream CLI caches server parameters at init. Capture its existing
  // test key in memory to re-init the same faucet; never print key-bearing args.
  const key = JSON.parse(capture(['dump-privkey', '--password', config.ARKD_PASSWORD])).private_key;
  if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) throw new Error('Invalid regtest faucet key');
  capture(['init', '--password', config.ARKD_PASSWORD, '--prvkey', key,
    '--server-url', 'http://localhost:7070', '--explorer', config.ARK_CLIENT_EXPLORER ?? 'http://mempool_web/api']);
  const balance = JSON.parse(capture(['balance']));
  const expiring = balance.offchain_balance?.details?.some(item => Date.parse(item.expiry_time) < Date.now() + 300_000);
  if (expiring) upstream(['ark', 'recover', '--password', config.ARKD_PASSWORD]);
  // Recovery may remove expired outputs without replacing the spendable balance.
  // The upstream start path boards fresh test BTC when that balance is empty.
  if (Number(JSON.parse(capture(['balance'])).offchain_balance?.total ?? 0) === 0) upstream(['start']);
  console.log('Applied project locktimes and refreshed the persistent regtest faucet.');
}
