const form = document.querySelector('#inquiry');
const result = document.querySelector('#result');
const mode = document.querySelector('#mode');
let sample = 0;

async function post(path, data) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || Object.values(body.errors || {}).join(' ') || 'Request failed.');
  return body;
}

document.querySelector('#sample').onclick = () => {
  sample++;
  form.elements.name.value = `Jamie Sample ${sample}`;
  form.elements.email.value = `jamie${sample}@example.com`;
  form.elements.inquiry.value = 'I would like a simple booking form for my business.';
};

form.onsubmit = async event => {
  event.preventDefault();
  document.querySelector('#submit').disabled = true;
  try {
    const response = await post('/api/inquiries', Object.fromEntries(new FormData(form)));
    result.textContent = response.duplicate ? `Already saved as lead #${response.leadId}. No duplicate notification queued.` : `Lead #${response.leadId} saved. Notification queued.`;
    await refresh();
  } catch (error) { result.textContent = error.message; }
  finally { document.querySelector('#submit').disabled = false; }
};

mode.onchange = async () => {
  try { await post('/api/mock-mode', { mode: mode.value }); await refresh(); }
  catch (error) { result.textContent = error.message; }
};

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function refresh() {
  try {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error('Unavailable');
    const data = await response.json();
    mode.value = data.mockMode;
    document.querySelector('#lead-count').textContent = data.leads.length;
    document.querySelector('#receipt-count').textContent = data.receipts.length;
    document.querySelector('#connection').textContent = 'LIVE · LOCAL';
    document.querySelector('#route').textContent = `Intake route: ${data.route === 'n8n' ? 'n8n webhook → durable lead service' : 'local service (n8n routing optional)'}`;
    const leads = document.querySelector('#leads');
    leads.replaceChildren();
    if (!data.leads.length) leads.append(element('p', 'No inquiries yet. Start with a sample above.', 'muted'));
    for (const lead of data.leads) {
      const row = element('div', '', 'lead');
      const details = element('div', '');
      details.append(element('strong', `#${lead.id} · ${lead.name}`), element('p', lead.email), element('p', lead.inquiry));
      if (lead.last_error) details.append(element('p', lead.last_error));
      const delivery = element('div', '');
      delivery.append(element('span', `${lead.status} · ${lead.attempts} ${lead.attempts === 1 ? 'attempt' : 'attempts'}`, `status ${lead.status}`));
      if (lead.status === 'failed') {
        const retry = element('button', 'Retry delivery', 'retry');
        retry.onclick = async () => { try { await post('/api/retry', { jobId: lead.job_id }); await refresh(); } catch (error) { result.textContent = error.message; } };
        delivery.append(retry);
      }
      row.append(details, delivery);
      leads.append(row);
    }
    const attempts = document.querySelector('#attempts');
    attempts.replaceChildren(...data.attempts.map(a => element('div', `${new Date(a.created_at).toLocaleTimeString()} · job #${a.job_id} · ${a.outcome}`)));
    if (!data.attempts.length) attempts.append(element('div', 'Delivery attempts will appear here.'));
  } catch { document.querySelector('#connection').textContent = 'DISCONNECTED'; }
}
refresh();
setInterval(refresh, 1000);
