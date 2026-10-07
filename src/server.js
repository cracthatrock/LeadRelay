import http from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Store } from './store.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function createApp(options = {}) {
  mkdirSync(resolve(root, 'data'), { recursive: true });
  const store = new Store(options.dbPath || resolve(root, 'data/leads.sqlite'));
  const retryMs = options.retryMs ?? 1000;
  const maxAttempts = options.maxAttempts ?? 3;
  let mockMode = 'healthy';
  let transientFailures = 0;
  let busy = false;
  let closing = false;
  let address;

  function respond(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  async function body(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16_384) throw Object.assign(new Error('Request too large.'), { status: 413 });
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString()); }
    catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      // Demo controls are local only. Reject cross-site browser writes.
      if (req.method === 'POST' && req.headers.origin &&
          ![`http://127.0.0.1:${server.address().port}`, `http://localhost:${server.address().port}`].includes(req.headers.origin)) {
        return respond(res, 403, { error: 'Cross-origin writes are disabled.' });
      }
      if (req.method === 'GET' && path === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'" });
        return res.end(readFileSync(resolve(root, 'public/index.html')));
      }
      if (req.method === 'GET' && ['/app.js', '/style.css'].includes(path)) {
        res.writeHead(200, { 'Content-Type': path.endsWith('.js') ? 'text/javascript' : 'text/css' });
        return res.end(readFileSync(resolve(root, 'public', path.slice(1))));
      }
      if (req.method === 'GET' && path === '/api/state') {
        return respond(res, 200, { ...store.snapshot(), mockMode,
          route: process.env.N8N_WEBHOOK_URL ? 'n8n' : 'local' });
      }
      if (req.method === 'POST' && ['/api/inquiries', '/api/intake'].includes(path)) {
        const input = await body(req);
        if (path === '/api/inquiries' && process.env.N8N_WEBHOOK_URL) {
          const response = await fetch(process.env.N8N_WEBHOOK_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input), signal: AbortSignal.timeout(5000),
          });
          return respond(res, response.status, await response.json());
        }
        const result = store.submit(input);
        return respond(res, result.statusCode, result);
      }
      if (req.method === 'POST' && path === '/api/mock-mode') {
        const { mode } = await body(req);
        if (!['healthy', 'transient', 'outage', 'timeout'].includes(mode)) {
          return respond(res, 400, { error: 'Unknown mode.' });
        }
        mockMode = mode;
        transientFailures = mode === 'transient' ? 1 : 0;
        return respond(res, 200, { mockMode });
      }
      if (req.method === 'POST' && path === '/mock/notify') {
        const { jobId } = await body(req);
        if (mockMode === 'timeout') {
          return setTimeout(() => { if (!res.destroyed) respond(res, 503, { error: 'Mock delay.' }); }, 1200);
        }
        if (mockMode === 'outage' || transientFailures-- > 0) {
          return respond(res, 503, { error: 'Simulated notification outage.' });
        }
        return respond(res, store.receipt(jobId) ? 200 : 400, { received: true });
      }
      if (req.method === 'POST' && path === '/api/retry') {
        const { jobId } = await body(req);
        return respond(res, store.retry(jobId) ? 200 : 409, { jobId });
      }
      respond(res, 404, { error: 'Not found.' });
    } catch (error) {
      respond(res, error.status || 502, { error: error.status ? error.message : 'Request failed. Your inquiry may already be saved; retrying the same details is safe.' });
    }
  });

  await new Promise(resolve => server.listen(options.port ?? Number(process.env.PORT || 4196),
    options.host || process.env.HOST || '127.0.0.1', resolve));
  address = `http://127.0.0.1:${server.address().port}`;

  async function tick() {
    if (busy || closing) return;
    const job = store.nextJob();
    if (!job) return;
    busy = true;
    let failure;
    try {
      const response = await fetch(`${address}/mock/notify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id, leadId: job.lead_id }),
        signal: AbortSignal.timeout(500),
      });
      if (!response.ok) failure = `Notification HTTP ${response.status}`;
    } catch { failure = 'Notification timed out or connection failed'; }
    store.recordAttempt(job, failure, maxAttempts, retryMs);
    busy = false;
  }

  const interval = setInterval(tick, 50);
  return { address, store, async close() {
    closing = true;
    clearInterval(interval);
    while (busy) await new Promise(resolve => setTimeout(resolve, 20));
    await new Promise(resolve => server.close(resolve));
    store.close();
  } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  console.log(`LeadRelay demo: ${app.address}`);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => { await app.close(); process.exit(0); });
  }
}
