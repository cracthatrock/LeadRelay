import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

const url = 'http://127.0.0.1:5686/webhook/lead-relay';
const sample = { name: 'n8n Sample', email: 'n8n@example.com', inquiry: `n8n integration check ${Date.now()}` };
const results = [];
for (const [name, body, expected] of [
  ['valid intake', sample, 201],
  ['duplicate intake', sample, 200],
  ['invalid email', { ...sample, email: 'not-an-email' }, 400],
]) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const output = await response.json();
  assert.equal(response.status, expected, JSON.stringify(output));
  assert.equal(output.statusCode, expected);
  results.push({ test: name, status: response.status, output });
}
writeFileSync('n8n-smoke-results.json', JSON.stringify({ checkedAt: new Date().toISOString(), engine: 'n8n 2.42.3', results }, null, 2));
console.log('PASS: real n8n webhook, HTTP persistence, and response nodes — valid, duplicate, invalid.');
