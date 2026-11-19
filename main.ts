// main.ts — the forge's process entrypoint.
//
// A single Node process, standard library only. It starts the HTTP server
// built by app.ts, binds a port the kernel chooses, tells the trial
// environment where to reach it, and stays up until the environment reports
// that the suite has finished.
//
// Trial lifecycle (kit RULES.txt, env/src/wire.ts):
//   1. listen on port 0 — an ephemeral port, never 8080;
//   2. POST {"port": <port>} to $MAKEFUN_ENV_URL/register;
//   3. keep GETting $MAKEFUN_ENV_URL/done until it answers {"done": true};
//   4. exit 0.
//
// With no MAKEFUN_ENV_URL set (local practice runs) the process simply
// serves on its ephemeral port and prints the address, so the kit's
// sdk/run.ts can be pointed at it by hand.

import { createApp } from './app.ts';

const REGISTER_PATH = '/register';
const DONE_PATH = '/done';

/** First pause between /done polls; it doubles up to MAX_POLL_WAIT_MS. */
const FIRST_POLL_WAIT_MS = 250;
const MAX_POLL_WAIT_MS = 2000;
/** How long one register or /done request may take before it is retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** How many times to retry a failing register before giving up. */
const REGISTER_ATTEMPTS = 20;
/** Pause between register retries. */
const REGISTER_RETRY_WAIT_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envBase(): string {
  return (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
}

async function registerWithEnv(env: string, port: number): Promise<void> {
  const url = `${env}${REGISTER_PATH}`;
  for (let attempt = 1; attempt <= REGISTER_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return;
      console.error(`register attempt ${attempt} was answered ${res.status}`);
    } catch (err) {
      console.error(`register attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (attempt < REGISTER_ATTEMPTS) await sleep(REGISTER_RETRY_WAIT_MS);
  }
  throw new Error(`could not register port ${port} with ${env}`);
}

async function waitUntilDone(env: string): Promise<void> {
  const url = `${env}${DONE_PATH}`;
  let waitMs = FIRST_POLL_WAIT_MS;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const body: unknown = await res.json();
      if (typeof body === 'object' && body !== null && (body as { done?: unknown }).done === true) {
        return;
      }
    } catch {
      // A timed-out or dropped poll is routine: the environment holds the
      // request open while the suite runs, so just poll again.
    }
    await sleep(waitMs);
    waitMs = Math.min(waitMs * 2, MAX_POLL_WAIT_MS);
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind a TCP port');
  }
  const port = bound.port;

  const env = envBase();
  if (env === '') {
    console.log(`forge listening on http://127.0.0.1:${port}`);
    // No trial environment to report to: serve until the server is closed
    // (a signal or a close call ends the process). Returning here would
    // resolve main() and exit while the suite still needs the forge.
    await new Promise<void>((resolve) => server.once('close', resolve));
    return;
  }
  console.log(`forge listening on port ${port}; registering with ${env}`);
  await registerWithEnv(env, port);
  await waitUntilDone(env);
  console.log('suite finished; shutting down');
  server.close();
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
