// main.ts — the forge's lifecycle: bind an ephemeral port, register it with the suite,
// long-poll the suite's /done, exit 0 when the suite is over.
//
// When MAKEFUN_ENV_URL is unset (a local run), the server just listens on $PORT (or an
// ephemeral port) and stays up until it is killed.
import { createForgeServer } from './app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;
const portEnv = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : NaN;

async function postJson(url: string, body: unknown, timeoutMs = 5000): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { status: response.status, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url: string, timeoutMs = 5000): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    return { status: response.status, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<number> {
  const server = createForgeServer();
  const port = Number.isFinite(portEnv) && portEnv > 0 ? portEnv : 0;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve());
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('the server did not bind a port');
  const boundPort = address.port;
  process.stdout.write(`git-forge listening on ${boundPort}\n`);

  if (!envUrl) {
    // Local run: stay up until killed.
    await new Promise<void>((resolve) => {
      process.on('SIGTERM', () => resolve());
      process.on('SIGINT', () => resolve());
    });
    server.close();
    return 0;
  }

  const base = envUrl.replace(/\/+$/, '');
  // Register: the first register wins; retry briefly on a transient failure.
  let registered = false;
  for (let attempt = 0; attempt < 10 && !registered; attempt += 1) {
    try {
      const answer = await postJson(`${base}/register`, { port: boundPort });
      if (answer.status >= 200 && answer.status < 300) {
        registered = true;
      } else if (answer.status === 409) {
        registered = true; // already registered (a retry after a successful first one)
      } else {
        process.stderr.write(`register attempt ${attempt + 1}: HTTP ${answer.status}\n`);
        await sleep(500);
      }
    } catch (err) {
      process.stderr.write(`register attempt ${attempt + 1}: ${(err as Error).message}\n`);
      await sleep(500);
    }
  }
  if (!registered) throw new Error('could not register with the suite');

  // Long-poll /done until the suite finishes.
  for (;;) {
    try {
      const answer = await getJson(`${base}/done`, 10000);
      if (answer.status === 200) {
        const parsed = JSON.parse(answer.text) as { done?: boolean };
        if (parsed.done === true) break;
      }
    } catch {
      // The env may be briefly unreachable; keep polling.
    }
    await sleep(500);
  }
  server.close();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
