import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sample = { name: 'Jamie Sample', email: 'jamie@example.com', inquiry: 'Build a booking form.' };
async function waitFor(check, timeout = 5000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('Expected state did not arrive');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}

test('validation, retry safety, timeouts, recovery, and durable restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lead-relay-'));
  const dbPath = join(dir, 'test.sqlite');
  const app = await createApp({ dbPath, port: 0, retryMs: 30 });
  const post = async (path, body) => {
    const response = await fetch(app.address + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    await t.test('invalid fields create no saved lead', async () => {
      assert.equal((await post('/api/inquiries', {})).status, 400);
      assert.equal((await post('/api/inquiries', { ...sample, email: 'bad' })).status, 400);
      assert.equal((await post('/api/inquiries', { ...sample, inquiry: 'x'.repeat(2001) })).status, 400);
      assert.equal(app.store.snapshot().leads.length, 0);
    });
    await t.test('valid inquiry delivers and concurrent duplicates create one job', async () => {
      const responses = await Promise.all(Array.from({ length: 8 }, () => post('/api/inquiries', sample)));
      assert.equal(responses.filter(r => r.status === 201).length, 1);
      await waitFor(() => app.store.snapshot().leads[0].status === 'delivered');
      assert.equal(app.store.snapshot().leads.length, 1);
      assert.equal(app.store.snapshot().receipts.length, 1);
    });
    await t.test('transient failure retries successfully', async () => {
      await post('/api/mock-mode', { mode: 'transient' });
      await post('/api/inquiries', { ...sample, inquiry: 'Temporary outage case' });
      await waitFor(() => app.store.snapshot().leads[0].status === 'delivered');
      assert.equal(app.store.snapshot().leads[0].attempts, 2);
    });
    await t.test('outage reaches failed state and manual recovery delivers once', async () => {
      await post('/api/mock-mode', { mode: 'outage' });
      await post('/api/inquiries', { ...sample, inquiry: 'Full outage case' });
      await waitFor(() => app.store.snapshot().leads[0].status === 'failed');
      const lead = app.store.snapshot().leads[0];
      assert.equal(lead.attempts, 3);
      await post('/api/mock-mode', { mode: 'healthy' });
      assert.equal((await post('/api/retry', { jobId: lead.job_id })).status, 200);
      await waitFor(() => app.store.snapshot().leads[0].status === 'delivered');
      assert.equal((await post('/api/retry', { jobId: lead.job_id })).status, 409);
      assert.equal(app.store.snapshot().receipts.filter(r => r.job_id === lead.job_id).length, 1);
    });
    await t.test('slow notification times out without losing the lead', async () => {
      await post('/api/mock-mode', { mode: 'timeout' });
      await post('/api/inquiries', { ...sample, inquiry: 'Slow service case' });
      await waitFor(() => app.store.snapshot().leads[0].status === 'failed');
      assert.match(app.store.snapshot().leads[0].last_error, /timed out/);
    });
    await t.test('mock receiver is idempotent and cross-origin writes are blocked', async () => {
      await post('/api/mock-mode', { mode: 'healthy' });
      const jobId = app.store.snapshot().leads[0].job_id;
      await post('/mock/notify', { jobId });
      await post('/mock/notify', { jobId });
      assert.equal(app.store.snapshot().receipts.filter(r => r.job_id === jobId).length, 1);
      const response = await fetch(app.address + '/api/inquiries', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify(sample) });
      assert.equal(response.status, 403);
    });
    await t.test('saved pending jobs survive a service restart', async () => {
      app.store.submit({ ...sample, inquiry: 'Restart case' });
      await app.close();
      const restarted = await createApp({ dbPath, port: 0, retryMs: 30 });
      try {
        await waitFor(() => restarted.store.snapshot().leads[0].status === 'delivered');
        assert.equal(restarted.store.snapshot().leads.length, 5);
      } finally { await restarted.close(); }
    });
  } finally {
    // The restart test closes the original instance; avoid closing twice.
    rmSync(dir, { recursive: true, force: true });
  }
});
