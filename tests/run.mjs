// Local test: node tests/run.mjs  (uses a temp folder instead of Netlify Blobs, mocks DialNexa)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.HR_LOCAL_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hrtest-'));
Object.assign(process.env, { ADMIN_PASSWORD: 'pw1', DIALNEXA_API_KEY: 'key_x:secret', DIALNEXA_AGENT_ID: 'agent_test', DIALNEXA_WEBHOOK_SECRET: 'whsec' });

const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opt) => {
  if (String(url).startsWith('https://api.dialnexa.com/v1/calls')) {
    sent.push({ url: String(url), auth: opt.headers.Authorization, body: JSON.parse(opt.body) });
    return new Response(JSON.stringify({ id: 'call_' + sent.length, agent_id: 'agent_test' }), { status: 201 });
  }
  if (String(url).startsWith('https://storage.dialnexa.com/')) return new Response(Buffer.from('RIFFfakewav'), { headers: { 'content-type': 'audio/wav' } });
  return realFetch(url, opt);
};

const { default: handler } = await import('../netlify/functions/api.mjs');
const AUTH = { Authorization: 'Basic ' + Buffer.from(':pw1').toString('base64') };
const call = (method, p, body, headers = AUTH, host = 'site.netlify.app') => {
  const isBuf = Buffer.isBuffer(body);
  return handler(new Request(`https://${host}${p}`, { method, headers: { ...(isBuf || typeof body === 'string' ? {} : { 'content-type': 'application/json' }), ...headers }, body: body == null ? undefined : isBuf || typeof body === 'string' ? body : JSON.stringify(body) }));
};
let fails = 0;
const ok = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' ' + extra)); if (!cond) fails++; };
const sign = (raw, sec = 'whsec') => crypto.createHmac('sha256', sec).update(raw).digest('hex');
const hook = (obj, sig) => { const raw = JSON.stringify(obj); return handler(new Request('https://site.netlify.app/webhook/dialnexa', { method: 'POST', headers: { 'content-type': 'application/json', ...(sig === null ? {} : { 'x-dialnexa-signature': sig ?? sign(raw) }) }, body: raw })); };

// auth
ok('no auth -> 401', (await call('GET', '/api/jobs', null, {})).status === 401);
ok('wrong pw -> 401', (await call('GET', '/api/jobs', null, { Authorization: 'Basic ' + Buffer.from(':bad').toString('base64') })).status === 401);

// job + candidates
let r = await call('POST', '/api/jobs', { company: 'Shah & Co', role: 'CA', questions: ['1.Tell me about yourself', '2) Which software?'] });
const job = await r.json(); ok('create job', r.status === 200 && job.questions[0] === 'Tell me about yourself', JSON.stringify(job));
r = await (await call('POST', `/api/jobs/${job.id}/candidates`, { text: 'Rahul, 9876543210\nPriya Patel 98765 43211\nBad, 123\nRahul, 98765-43210' })).json();
ok('add lines', r.added === 2 && r.duplicates === 1 && r.invalid.length === 1, JSON.stringify(r));
const xl = '/tmp/claude-0/t/a.xlsx';
if (fs.existsSync(xl)) { r = await (await call('POST', `/api/jobs/${job.id}/import`, fs.readFileSync(xl), { ...AUTH, 'content-type': 'application/octet-stream' })).json(); ok('import xlsx (1 new, 2 duplicates, 1 invalid)', r.added === 1 && r.duplicates === 2 && r.invalid.length === 1, JSON.stringify(r)); }
let list = await (await call('GET', `/api/jobs/${job.id}/candidates`)).json();
ok('list candidates', list.length >= 2 && list.every((c) => c.status === 'pending'));
const rahul = list.find((c) => c.name === 'Rahul');

// call + DialNexa request shape
r = await call('POST', `/api/candidates/${rahul.id}/call`);
ok('call ok', r.status === 200);
const s = sent[0];
ok('dialnexa request shape', s.url.endsWith('/v1/calls') && s.auth === 'Bearer key_x:secret' && s.body.phone_number === '+919876543210' && s.body.agent_id === 'agent_test' && s.body.metadata.candidate_name === 'Rahul' && s.body.metadata.questions === '1. Tell me about yourself\n2. Which software?' && s.body.notes.candidate_id === rahul.id && s.body.notes.job_id === job.id, JSON.stringify(s));
ok('status calling', (await (await call('GET', `/api/jobs/${job.id}/candidates`)).json()).find((c) => c.id === rahul.id).status === 'calling');
r = await call('POST', `/api/jobs/${job.id}/call`, { force: true });
const ids = (await r.json()).ids; ok('call-all returns pending ids only', ids.length === list.length - 1 && !ids.includes(rahul.id), JSON.stringify(ids));

// webhook security + verification
ok('webhook bad signature -> 401', (await hook({ event_type: 'verification', payload: {} }, 'deadbeef')).status === 401);
ok('webhook no signature -> 401', (await hook({ event_type: 'verification', payload: {} }, null)).status === 401);
ok('verification -> 204', (await hook({ event_type: 'verification', payload: { message: 'x', timestamp: 't' } })).status === 204);

// events
const base = { id: 'call_1', direction: 'outbound', agent_id: 'agent_test', notes: { candidate_id: rahul.id, job_id: job.id } };
await hook({ event_type: 'call_initiated', payload: { call: { ...base, status: 'initiated' } } });
const priya = list.find((c) => c.name === 'Priya Patel');
await hook({ event_type: 'call_ended', payload: { call: { ...base, notes: { candidate_id: priya.id, job_id: job.id }, status: 'hangup', hangup_reason: 'user_did_not_pick_up' } } });
await hook({ event_type: 'call_ended', payload: { event: 'call_ended', call: { ...base, status: 'completed', duration_in_seconds: 142, hangup_reason: 'user_disconnected',
  transcript: JSON.stringify([{ role: 'assistant', content: 'Hello Rahul' }, { role: 'user', content: 'Hi' }]),
  summary: 'Strong GST experience.', recording_url: 'https://storage.dialnexa.com/recordings/call_1.wav?sig=x',
  post_call_analysis: { Score_1_to_10: '8', Recommendation: 'Shortlist', notice_period: '30 days', expected_ctc: '6 LPA', answers: ['Q1: 5 years', 'Q2: Tally'], sentiment: 'positive' } } } });
list = await (await call('GET', `/api/jobs/${job.id}/candidates`)).json();
const R = list.find((c) => c.id === rahul.id), P = list.find((c) => c.id === priya.id);
ok('interviewed + fields', R.status === 'interviewed' && R.score === 8 && R.recommendation === 'Shortlist' && R.noticePeriod === '30 days' && R.expectedCtc === '6 LPA' && R.summary === 'Strong GST experience.' && R.answers === 'Q1: 5 years\nQ2: Tally' && R.durationSec === 142, JSON.stringify(R));
ok('transcript formatted', R.transcript === 'Agent: Hello Rahul\nCandidate: Hi', R.transcript);
ok('extra analysis kept', R.analysis.sentiment === 'positive');
ok('no answer mapped', P.status === 'no_answer' && P.failReason === 'user_did_not_pick_up', JSON.stringify(P));
ok('recording stored', R.recordingStored === true && R.recordingPath.startsWith('/api/rec/'), JSON.stringify(R));
r = await call('GET', R.recordingPath, null, {});
ok('recording served via token (no auth header)', r.status === 200 && Buffer.from(await r.arrayBuffer()).toString() === 'RIFFfakewav' && r.headers.get('content-type') === 'audio/wav');
ok('recording bad token -> 403', (await call('GET', `/api/rec/${R.id}?t=bad`, null, {})).status === 403);
r = await (await call('GET', '/api/jobs')).json(); ok('job counts', r[0].total === list.length && r[0].interviewed === 1, JSON.stringify(r));

// decisions + export
r = await call('PATCH', `/api/candidates/${R.id}`, { decision: 'shortlisted' }); ok('shortlist', (await r.json()).decision === 'shortlisted');
const csv = await (await call('GET', `/api/jobs/${job.id}/export.csv`)).text(); ok('csv export', csv.includes('Rahul') && csv.includes('Strong GST experience.'));

// local-only mode (no password)
delete process.env.ADMIN_PASSWORD;
ok('no password + public host -> 403', (await call('GET', '/api/jobs', null, {})).status === 403);
ok('no password + localhost -> 200', (await call('GET', '/api/jobs', null, {}, 'localhost:8888')).status === 200);

// DialNexa error passthrough
process.env.ADMIN_PASSWORD = 'pw1';
globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Insufficient balance.' }), { status: 402 });
r = await call('POST', `/api/candidates/${P.id}/call`); ok('dialnexa 402 message shown', r.status === 502 && (await r.json()).error === 'Insufficient balance.');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
