import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { body: 'Expected a JSON object.' };
  }

  const errors = {};
  for (const [key, limit] of [['name', 120], ['email', 254], ['inquiry', 2000]]) {
    if (typeof input[key] !== 'string' || !input[key].trim()) {
      errors[key] = 'This field is required.';
    } else if (input[key].trim().length > limit) {
      errors[key] = `Use ${limit} characters or fewer.`;
    }
  }

  if (!errors.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) {
    errors.email = 'Enter a valid email address.';
  }
  return errors;
}

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS leads (
        id INTEGER PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        inquiry TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY,
        lead_id INTEGER NOT NULL UNIQUE REFERENCES leads(id),
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        delivered_at TEXT
      );
      CREATE TABLE IF NOT EXISTS receipts (
        job_id INTEGER PRIMARY KEY REFERENCES jobs(id),
        received_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id INTEGER PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES jobs(id),
        outcome TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  submit(input) {
    const errors = validate(input);
    if (Object.keys(errors).length) return { statusCode: 400, errors };
    const lead = {
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
      inquiry: input.inquiry.trim(),
    };
    const fingerprint = createHash('sha256').update(JSON.stringify(lead)).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT id FROM leads WHERE fingerprint = ?').get(fingerprint);
      if (existing) {
        this.db.exec('COMMIT');
        return { statusCode: 200, duplicate: true, leadId: existing.id };
      }
      const result = this.db.prepare(`
        INSERT INTO leads (fingerprint, name, email, inquiry, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(fingerprint, lead.name, lead.email, lead.inquiry, new Date().toISOString());
      const id = Number(result.lastInsertRowid);
      this.db.prepare('INSERT INTO jobs (lead_id) VALUES (?)').run(id);
      this.db.exec('COMMIT');
      return { statusCode: 201, duplicate: false, leadId: id };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  nextJob() {
    return this.db.prepare(`
      SELECT jobs.*, leads.name, leads.email, leads.inquiry
      FROM jobs JOIN leads ON leads.id = jobs.lead_id
      WHERE status IN ('pending', 'retrying') AND next_attempt <= ?
      ORDER BY jobs.id LIMIT 1
    `).get(Date.now());
  }

  recordAttempt(job, error, maxAttempts, retryMs) {
    const attempts = job.attempts + 1;
    const status = !error ? 'delivered' : attempts >= maxAttempts ? 'failed' : 'retrying';
    this.db.prepare(`
      UPDATE jobs SET attempts = ?, status = ?, last_error = ?, next_attempt = ?, delivered_at = ?
      WHERE id = ?
    `).run(attempts, status, error || null, Date.now() + retryMs * 2 ** (attempts - 1),
      error ? null : new Date().toISOString(), job.id);
    this.db.prepare('INSERT INTO attempts (job_id, outcome, created_at) VALUES (?, ?, ?)')
      .run(job.id, error || 'delivered', new Date().toISOString());
  }

  receipt(id) {
    if (!Number.isSafeInteger(id) || !this.db.prepare('SELECT id FROM jobs WHERE id = ?').get(id)) {
      return false;
    }
    this.db.prepare('INSERT OR IGNORE INTO receipts (job_id, received_at) VALUES (?, ?)')
      .run(id, new Date().toISOString());
    return true;
  }

  retry(id) {
    return this.db.prepare(`
      UPDATE jobs SET status = 'pending', attempts = 0, next_attempt = 0, last_error = NULL
      WHERE id = ? AND status = 'failed'
    `).run(id).changes > 0;
  }

  snapshot() {
    return {
      leads: this.db.prepare(`
        SELECT leads.*, jobs.id AS job_id, jobs.status, jobs.attempts, jobs.last_error
        FROM leads JOIN jobs ON jobs.lead_id = leads.id ORDER BY leads.id DESC
      `).all().map(({ fingerprint, ...lead }) => lead),
      receipts: this.db.prepare('SELECT * FROM receipts ORDER BY job_id DESC').all(),
      attempts: this.db.prepare('SELECT * FROM attempts ORDER BY id DESC LIMIT 30').all(),
    };
  }

  close() { this.db.close(); }
}
