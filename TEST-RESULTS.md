# Verification — October 6, 2026 (Pacific)

Local environment: Windows, Node.js 25.6.1, Docker Desktop, n8n 2.42.3.

## Service integration checks

`npm test`: 8 passing tests (one parent test and seven scenario tests), zero failures.

- Invalid/missing fields and oversized inquiry: rejected without saving a lead.
- Eight simultaneous identical requests: one lead/job/receipt.
- Transient notification failure: successful delivery on second attempt.
- Sustained outage: three attempts, retained lead, failed status; manual recovery succeeds.
- Slow service: bounded timeout, failed status, retained lead.
- Mock receiver: duplicate job IDs create one receipt; foreign-origin browser writes rejected.
- Restart: pending persisted job resumes and delivers after service restart.

## Real n8n checks

Workflow imported through n8n's CLI and published in the local Docker instance. Initial CLI import required a stable workflow ID; the provided export includes the correction.

`node test/n8n-smoke.js`: valid request returns 201, exact duplicate 200, invalid email 400. All pass through the real Webhook → HTTP Request → Respond to Webhook nodes. Recorded outputs are in `n8n-smoke-results.json`. The HTTP node reaches the Windows loopback service through `host.docker.internal` on this Docker Desktop installation.

## Browser check

Submitted the form through the configured n8n route. The tracker showed the saved lead, delivered notification and matching receipt count. Also simulated an outage through the form: three HTTP 503 attempts left the lead saved and job failed; switching to Healthy and using Retry delivery recovered it. Desktop visual inspection completed; screenshots in `demo-desktop.png` and `demo-outage.png`. The page has responsive CSS, but a separate mobile device check was not performed.

## Boundaries

Mock notifications only; no real email provider, customer account or paid API was used. This verifies the local architecture and n8n integration, not production authentication, multi-worker concurrency, provider delivery guarantees or cloud deployment.
