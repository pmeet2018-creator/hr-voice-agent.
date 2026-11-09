import crypto from 'node:crypto';
import { readTable, rowsToPairs, parseLine } from '../lib/tables.mjs';
import { db } from '../lib/store.mjs';

export const config = { path: ['/api/*', '/webhook/dialnexa'] };

const env = (k) => (process.env[k] || '').trim();
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const istHour = () => new Date(Date.now() + 5.5 * 3600 * 1000).getUTCHours();

const normPhone = (s) => {
  let d = String(s ?? '').trim().replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d.length >= 11 ? d : null;
  d = d.replace(/^0+/, '');
  if (d.length === 10) return '+91' + d;
  if (d.length === 12 && d.startsWith('91')) return '+' + d;
  return null;
};
const cleanQ = (q) => String(q).trim().replace(/^\d+\s*[.)]\s*/, '');

// ---------- auth ----------
function authed(req) {
  const pw = env('ADMIN_PASSWORD');
  if (!pw) { const h = new URL(req.url).hostname; return h === 'localhost' || h === '127.0.0.1'; }
  const h = req.headers.get('authorization') || '';
  const given = Buffer.from(h.split(' ')[1] || '', 'base64').toString('utf8').split(':').slice(1).join(':');
  const a = Buffer.from(given), b = Buffer.from(pw);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const recTok = (id) => crypto.createHmac('sha256', (env('ADMIN_PASSWORD') || 'local') + '|rec').update(id).digest('hex').slice(0, 32);

// ---------- storage helpers ----------
const candsOf = async (jobId) => (await Promise.all((await db.list(`cand/${jobId}/`)).map((k) => db.getJSON(k)))).filter(Boolean);
async function findCand(id) {
  const k = (await db.list('cand/')).find((x) => x.endsWith('/' + id));
  return k ? [k, await db.getJSON(k)] : [null, null];
}
const pub = (c) => ({ ...c, recordingPath: c.recordingStored ? `/api/rec/${c.id}?t=${recTok(c.id)}` : '' });

async function addCandidates(jobId, pairs) {
  const existing = new Set((await candsOf(jobId)).map((c) => c.phone));
  let added = 0, duplicates = 0; const invalid = [];
  for (const [name, phone] of pairs) {
    const p = normPhone(phone);
    if (!name || !p) { invalid.push(`${name || '(no name)'}, ${phone || '(no phone)'}`); continue; }
    if (existing.has(p)) { duplicates++; continue; }
    existing.add(p);
    const c = { id: crypto.randomUUID(), jobId, name, phone: p, status: 'pending', decision: '' };
    await db.setJSON(`cand/${jobId}/${c.id}`, c);
    added++;
  }
  return { added, duplicates, invalid };
}

// ---------- DialNexa ----------
async function dial(c, job) {
  const key = env('DIALNEXA_API_KEY'), agent = env('DIALNEXA_AGENT_ID');
  if (!key || !agent) throw new Error('DIALNEXA_API_KEY and DIALNEXA_AGENT_ID must be set in Netlify environment variables.');
  const body = {
    phone_number: c.phone,
    agent_id: agent,
    metadata: { company: job.company, role: job.role, candidate_name: c.name, questions: job.questions.map((q, i) => `${i + 1}. ${cleanQ(q)}`).join('\n') },
    notes: { candidate_id: c.id, job_id: job.id },
  };
  if (env('DIALNEXA_PHONE_NUMBER_ID')) body.phone_number_id = env('DIALNEXA_PHONE_NUMBER_ID');
  let r;
  try {
    r = await fetch('https://api.dialnexa.com/v1/calls', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    throw new Error('No response from DialNexa. The call may still have been placed (it is billable): check the DialNexa call log before retrying.');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || j.error || `DialNexa error ${r.status}`);
  return j.id;
}

// ---------- webhook ----------
function verifySig(raw, req) {
  if (process.env.ALLOW_UNSIGNED_WEBHOOK === '1') return true;
  const secrets = env('DIALNEXA_WEBHOOK_SECRET').split(',').map((s) => s.trim()).filter(Boolean);
  const sigs = ['x-dialnexa-signature', 'x-dialnexa-signature-new'].map((h) => req.headers.get(h)).filter(Boolean);
  return secrets.some((sec) => {
    const exp = crypto.createHmac('sha256', sec).update(raw).digest('hex');
    return sigs.some((s) => s.length === exp.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(exp)));
  });
}
const txt = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(txt).join('\n');
  if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k}: ${txt(x)}`).join('\n');
  return String(v);
};
const normKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
function pick(analysis, ...names) {
  const m = {}; for (const [k, v] of Object.entries(analysis || {})) m[normKey(k)] = v;
  for (const n of names) if (m[n] != null && m[n] !== '') return m[n];
  return '';
}
function fmtTranscript(t) {
  if (!t) return '';
  try {
    const arr = JSON.parse(t);
    if (Array.isArray(arr)) return arr.map((m) => `${m.role === 'assistant' ? 'Agent' : m.role === 'user' ? 'Candidate' : m.role}: ${m.content}`).join('\n');
  } catch { /* plain text */ }
  return String(t);
}
const NO_ANSWER = /user_did_not_pick_up|user_busy|voicemail_detected|user_unreachable/;

async function webhook(req) {
  const raw = Buffer.from(await req.arrayBuffer());
  if (!verifySig(raw, req)) return new Response('invalid signature', { status: 401 });
  let b; try { b = JSON.parse(raw.toString('utf8')); } catch { return new Response('bad json', { status: 400 }); }
  const call = b.payload?.call;
  const n = call?.notes;
  if (!call || !n?.candidate_id || !n?.job_id) return new Response(null, { status: 204 });   // verification / unrelated call
  const key = `cand/${n.job_id}/${n.candidate_id}`;
  const c = await db.getJSON(key);
  if (!c) return new Response(null, { status: 204 });
  c.callId = call.id;

  if (b.event_type === 'call_initiated') {
    if (c.status !== 'interviewed') c.status = 'calling';
  } else if (b.event_type === 'call_ended') {
    if (call.status === 'completed') {
      const a = call.post_call_analysis || {};
      c.status = 'interviewed';
      c.summary = txt(call.summary || pick(a, 'summary'));
      c.answers = txt(pick(a, 'answers', 'answer', 'qa', 'interview_answers'));
      c.noticePeriod = txt(pick(a, 'notice_period'));
      c.expectedCtc = txt(pick(a, 'expected_ctc', 'expected_salary'));
      c.score = Number(pick(a, 'score_1_to_10', 'score', 'rating', 'overall_score')) || null;
      c.recommendation = txt(pick(a, 'recommendation'));
      c.analysis = a;
      c.durationSec = call.duration_in_seconds ?? null;
      c.transcript = fmtTranscript(call.transcript);
      c.recordingUrl = call.recording_url || '';
      if (call.recording_url) {          // DialNexa links expire after 7 days, so keep our own copy
        try {
          const r = await fetch(call.recording_url, { signal: AbortSignal.timeout(6000) });
          if (r.ok) {
            await db.setBin(`rec/${c.id}`, Buffer.from(await r.arrayBuffer()));
            c.recordingStored = true; c.recordingType = r.headers.get('content-type') || 'audio/wav';
          }
        } catch { /* keep the temporary URL */ }
      }
    } else {
      const reason = call.hangup_reason || call.disconnection_reason || 'unknown';
      c.status = NO_ANSWER.test(reason) ? 'no_answer' : 'failed';
      c.failReason = reason;
    }
  }
  await db.setJSON(key, c);
  return new Response(null, { status: 204 });
}

// ---------- routes ----------
async function route(req) {
  const u = new URL(req.url), m = req.method;
  if (u.pathname === '/webhook/dialnexa') return m === 'POST' ? webhook(req) : new Response('POST only', { status: 405 });

  let x = u.pathname.match(/^\/api\/rec\/([\w-]+)$/);
  if (x && m === 'GET') {
    const t = u.searchParams.get('t') || '', exp = recTok(x[1]);
    if (t.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(exp))) return new Response('forbidden', { status: 403 });
    const [, c] = await findCand(x[1]); const buf = c && await db.getBin(`rec/${x[1]}`);
    if (!buf) return new Response('not found', { status: 404 });
    return new Response(buf, { headers: { 'content-type': c.recordingType || 'audio/wav', 'cache-control': 'private, max-age=3600' } });
  }

  if (!authed(req)) return env('ADMIN_PASSWORD') ? J({ error: 'Unauthorized' }, 401) : J({ error: 'Local-only: set ADMIN_PASSWORD in Netlify environment variables.' }, 403);
  const p = u.pathname.replace(/^\/api/, '');

  if (p === '/jobs' && m === 'GET') {
    const jobs = (await Promise.all((await db.list('job/')).map((k) => db.getJSON(k)))).filter(Boolean).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return J(await Promise.all(jobs.map(async (j) => { const cs = await candsOf(j.id); return { ...j, total: cs.length, interviewed: cs.filter((c) => c.status === 'interviewed').length }; })));
  }
  if (p === '/jobs' && m === 'POST') {
    const { company, role, questions } = await req.json().catch(() => ({}));
    const qs = (questions || []).map(cleanQ).filter(Boolean);
    if (!company || !role || !qs.length) return J({ error: 'company, role and questions required' }, 400);
    const job = { id: crypto.randomUUID(), company, role, questions: qs, createdAt: new Date().toISOString() };
    await db.setJSON(`job/${job.id}`, job); return J(job);
  }

  if ((x = p.match(/^\/jobs\/([\w-]+)\/(candidates|import|call|export\.csv)$/))) {
    const [, jid, act] = x;
    const job = await db.getJSON(`job/${jid}`);
    if (!job) return J({ error: 'job not found' }, 404);
    if (act === 'candidates' && m === 'GET') return J((await candsOf(jid)).map(pub));
    if (act === 'candidates' && m === 'POST') {
      const body = await req.json().catch(() => ({}));
      const pairs = String(body.text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map(parseLine);
      return J(await addCandidates(jid, pairs));
    }
    if (act === 'import' && m === 'POST') {
      try {
        const buf = Buffer.from(await req.arrayBuffer());
        if (!buf.length) throw new Error('Empty file.');
        const pairs = rowsToPairs(readTable(buf));
        if (!pairs.length) throw new Error('No rows found. Put Name in column A and Phone in column B.');
        return J(await addCandidates(jid, pairs));
      } catch (e) { return J({ error: e.message }, 400); }
    }
    if (act === 'call' && m === 'POST') {      // returns who to call; the browser dials them one by one
      const body = await req.json().catch(() => ({}));
      const h = istHour();
      if ((h < 9 || h >= 19) && !body.force) return J({ error: 'Outside 9:00-19:00 IST. Send force:true to override.' }, 400);
      return J({ ids: (await candsOf(jid)).filter((c) => c.status === 'pending' || c.status === 'no_answer' || c.status === 'failed').map((c) => c.id) });
    }
    if (act === 'export.csv' && m === 'GET') {
      const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const head = ['Name', 'Phone', 'Status', 'Score', 'AI recommendation', 'HR decision', 'Notice period', 'Expected CTC', 'Summary', 'Answers'];
      const rows = (await candsOf(jid)).map((c) => [c.name, c.phone, c.status, c.score, c.recommendation, c.decision, c.noticePeriod, c.expectedCtc, c.summary, c.answers].map(q).join(','));
      return new Response('﻿' + [head.map(q).join(',')].concat(rows).join('\n'), { headers: { 'content-type': 'text/csv; charset=utf-8' } });
    }
  }

  if ((x = p.match(/^\/candidates\/([\w-]+)(\/call)?$/))) {
    const [key, c] = await findCand(x[1]);
    if (!c) return J({ error: 'not found' }, 404);
    if (x[2] && m === 'POST') {
      const job = await db.getJSON(`job/${c.jobId}`);
      try { c.callId = await dial(c, job); c.status = 'calling'; c.failReason = ''; await db.setJSON(key, c); return J({ ok: true }); }
      catch (e) { return J({ error: e.message }, 502); }
    }
    if (!x[2] && m === 'PATCH') {
      const body = await req.json().catch(() => ({}));
      if (['', 'shortlisted', 'rejected'].includes(body.decision)) c.decision = body.decision;
      await db.setJSON(key, c); return J(pub(c));
    }
  }
  return J({ error: 'not found' }, 404);
}

export default async (req) => {
  try { return await route(req); }
  catch (e) { console.error(e); return J({ error: e.message || 'Server error' }, 500); }
};
