import { pathToFileURL } from 'node:url';

function readStdinText() {
  return new Promise((resolve, reject) => {
    let data = '';
    globalThis.process.stdin.setEncoding('utf8');
    globalThis.process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    globalThis.process.stdin.on('end', () => resolve(data));
    globalThis.process.stdin.on('error', reject);
  });
}

async function main() {
  const entryPath = globalThis.process.argv[2];
  if (!entryPath) {
    globalThis.process.stderr.write('Missing entry path\n');
    globalThis.process.exit(2);
    return;
  }

  const raw = await readStdinText();
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    globalThis.process.stderr.write('Invalid JSON input\n');
    globalThis.process.exit(2);
    return;
  }

  try {
    const mod = await import(pathToFileURL(entryPath).href);
    const run = mod?.run;
    if (typeof run !== 'function') {
      globalThis.process.stderr.write('Entry must export async function run(input)\n');
      globalThis.process.exit(2);
      return;
    }
    const result = await run(parsed?.input);
    globalThis.process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    globalThis.process.stdout.write(JSON.stringify({ ok: false, error: message }));
    globalThis.process.exit(1);
  }
}

main();
