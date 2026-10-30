// Node smoke test for whose AI keys the setlist worker's /ai/* routes spend.
//
//   node scripts/check-setlist-ai-keys.mjs
//
// The worker's own ANTHROPIC/OPENAI/GEMINI keys are the owner's (and the
// owner's monthly API credits): they must be spent only for a request that
// carries the owner's WORKER_TOKEN. Everyone else brings their own key per
// request, which must never be mixed with — or backfilled by — the owner's.

import worker, { aiEnvFor, hasUserAiKey } from '../workers/setlist-sync/index.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok  ${name}`); }
  else { console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
}

const OWNER_ENV = {
  WORKER_TOKEN: 'owner-secret',
  ANTHROPIC_API_KEY: 'sk-ant-owner',
  OPENAI_API_KEY: 'sk-owner',
  GEMINI_API_KEY: 'AIza-owner',
};
const req = (headers = {}, path = '/ai/steel-summary') =>
  new Request(`https://w.example${path}`, { headers: { Origin: 'https://voidstar.sh', ...headers } });

console.log('aiEnvFor — whose keys a request spends');
{
  const e = aiEnvFor(req({ 'X-Worker-Token': 'owner-secret' }), OWNER_ENV);
  check('owner token → owner keys', e.AI_KEY_SOURCE === 'owner' && e.ANTHROPIC_API_KEY === 'sk-ant-owner');
}
{
  const e = aiEnvFor(req(), OWNER_ENV);
  check('no token, no key → no keys at all',
    e.AI_KEY_SOURCE === 'none' && !e.ANTHROPIC_API_KEY && !e.OPENAI_API_KEY && !e.GEMINI_API_KEY);
}
{
  const e = aiEnvFor(req({ 'X-Worker-Token': 'wrong' }), OWNER_ENV);
  check('wrong token → no keys', e.AI_KEY_SOURCE === 'none' && !e.ANTHROPIC_API_KEY);
}
{
  const open = { ...OWNER_ENV, WORKER_TOKEN: undefined };
  const e = aiEnvFor(req(), open);
  check('open worker (no WORKER_TOKEN) never spends its own keys', e.AI_KEY_SOURCE === 'none' && !e.ANTHROPIC_API_KEY);
}
{
  const e = aiEnvFor(req({ 'X-Anthropic-Key': ' sk-ant-user ' }), OWNER_ENV);
  check('user key → only the user key',
    e.AI_KEY_SOURCE === 'user' && e.ANTHROPIC_API_KEY === 'sk-ant-user' && !e.OPENAI_API_KEY && !e.GEMINI_API_KEY,
    JSON.stringify({ a: e.ANTHROPIC_API_KEY, o: e.OPENAI_API_KEY, g: e.GEMINI_API_KEY }));
}
{
  const e = aiEnvFor(req({ 'X-Gemini-Key': 'AIza-user', 'X-Worker-Token': 'owner-secret' }), OWNER_ENV);
  check('user key wins over the owner token, no owner backfill',
    e.AI_KEY_SOURCE === 'user' && e.GEMINI_API_KEY === 'AIza-user' && !e.ANTHROPIC_API_KEY);
}
check('oversized header is ignored', !hasUserAiKey(req({ 'X-Anthropic-Key': 'x'.repeat(600) })));

console.log('router — the token gate');
// A missing `title` is a 400 from the handler itself, so these exercise the
// gate without making any provider call.
{
  const r = await worker.fetch(req(), OWNER_ENV);
  check('/ai/* without token or key → 401', r.status === 401, `got ${r.status}`);
}
{
  const r = await worker.fetch(req({ 'X-Anthropic-Key': 'sk-ant-user' }), OWNER_ENV);
  check('/ai/* with own key passes the gate', r.status === 400, `got ${r.status}`);
}
{
  const r = await worker.fetch(req({ 'X-Anthropic-Key': 'sk-ant-user' }, '/meta/song'), OWNER_ENV);
  check('a user AI key does not open non-AI routes', r.status === 401, `got ${r.status}`);
}
{
  const r = await worker.fetch(req({ 'X-Worker-Token': 'owner-secret' }), OWNER_ENV);
  check('/ai/* with owner token passes the gate', r.status === 400, `got ${r.status}`);
}
{
  const r = await worker.fetch(req({}, '/ai/steel-summary?title=x'), { ...OWNER_ENV, WORKER_TOKEN: undefined });
  const body = await r.json();
  check('open worker answers keyless, pointing at Settings → AI keys',
    body.aiConfigured === false && /Settings → AI keys/.test(body.reason), JSON.stringify(body));
}
{
  const r = await worker.fetch(new Request('https://w.example/ai/chart', {
    method: 'OPTIONS', headers: { Origin: 'https://voidstar.sh' },
  }), OWNER_ENV);
  const allowed = r.headers.get('Access-Control-Allow-Headers') || '';
  check('CORS preflight allows the key headers',
    ['X-Anthropic-Key', 'X-OpenAI-Key', 'X-Gemini-Key'].every(h => allowed.includes(h)), allowed);
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall setlist AI key checks passed');
