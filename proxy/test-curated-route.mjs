// Tests the /curated route against a stubbed Workers runtime: no wrangler, no
// network, no deploy.
//
//     node proxy/test-curated-route.mjs
//
// This route guards the curated tier, so most of what is asserted here is
// about refusal: that an unauthenticated request never reaches the private
// repository, that an unset secret fails closed rather than open, and that a
// response carrying filing contents can never be read cross-origin by a site
// that merely has a victim's browser.

const store = new Map();
globalThis.caches = {
  default: {
    async match(req) { const r = store.get(req.url); return r ? r.clone() : undefined; },
    async put(req, res) { store.set(req.url, res.clone()); },
  },
};

let upstreamCalls = [];
globalThis.fetch = async (input, init) => {
  const u = typeof input === 'string' ? input : input.url;
  upstreamCalls.push({ url: u, headers: (init && init.headers) || {} });
  if (u.includes('/contents/missing.json')) return new Response('nope', { status: 404 });
  if (u.includes('/contents/broken.json')) return new Response('boom', { status: 500 });
  return new Response(JSON.stringify({ kind: 'transaction', tier: 'curated' }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};

const worker = (await import(new URL('./worker.js', import.meta.url))).default;

const TOKEN = 'verity-token-abcdefghijklmnop';
const ENV = {
  CURATED_TOKEN: TOKEN,
  GITHUB_TOKEN: 'ghp_secret_pat_value',
  CURATED_REPO: 'HBT89/govdata-curated',
  CURATED_ALLOWED_ORIGINS: 'https://verity.example, http://localhost:5173',
};

let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ' :: ' + extra}`);
  if (!cond) fail++;
};

const call = (path, { token, origin, method = 'GET', env = ENV } = {}) => {
  upstreamCalls = [];
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (origin) headers['Origin'] = origin;
  return worker.fetch(new Request(`https://proxy.example${path}`, { method, headers }), env);
};

// --- authentication ---------------------------------------------------------
let r = await call('/curated/transactions.json');
check('no token is refused', r.status === 401, `got ${r.status}`);
check('  and never reaches the private repo', upstreamCalls.length === 0, JSON.stringify(upstreamCalls));

r = await call('/curated/transactions.json', { token: 'wrong-token-aaaaaaaaaaaaa' });
check('wrong token is refused', r.status === 401);
check('  and never reaches the private repo', upstreamCalls.length === 0);

r = await call('/curated/transactions.json', { token: TOKEN.slice(0, -1) });
check('truncated token is refused', r.status === 401);

r = await call('/curated/transactions.json', { token: TOKEN + 'x' });
check('token with extra bytes is refused', r.status === 401);

// --- fails closed -----------------------------------------------------------
r = await call('/curated/transactions.json', { token: TOKEN, env: { ...ENV, CURATED_TOKEN: undefined } });
check('unset CURATED_TOKEN fails closed, not open', r.status === 503, `got ${r.status}`);
check('  and never reaches the private repo', upstreamCalls.length === 0);

r = await call('/curated/transactions.json', { token: '', env: { ...ENV, CURATED_TOKEN: '' } });
check('empty CURATED_TOKEN fails closed', r.status === 503, `got ${r.status}`);

r = await call('/curated/transactions.json', { token: TOKEN, env: { ...ENV, GITHUB_TOKEN: undefined } });
check('unset GITHUB_TOKEN is a 503, not a leak', r.status === 503);

// --- authorised path --------------------------------------------------------
r = await call('/curated/transactions.json', { token: TOKEN, origin: 'https://verity.example' });
check('valid token is served', r.status === 200, `got ${r.status}`);
check('  reads the configured private repo', upstreamCalls[0].url === 'https://api.github.com/repos/HBT89/govdata-curated/contents/transactions.json', upstreamCalls[0]?.url);
check('  bare /curated defaults to transactions.json',
  (await call('/curated', { token: TOKEN })) && upstreamCalls[0].url.endsWith('/contents/transactions.json'));

r = await call('/curated/transactions.json', { token: TOKEN, origin: 'https://verity.example' });
const body = await r.clone().json();
check('  returns the curated document', body.tier === 'curated');
check('  carries the use restriction', (r.headers.get('x-use-restriction') || '').includes('105(c)'));

// --- the GitHub credential must not escape ---------------------------------
const raw = await r.clone().text();
check('the PAT is not in the response body', !raw.includes('ghp_secret_pat_value'));
let hv = [...r.headers].map(([k, v]) => `${k}:${v}`).join('|');
check('the PAT is not in any response header', !hv.includes('ghp_secret_pat_value'), hv);
check('the token is not echoed back', !hv.includes(TOKEN) && !raw.includes(TOKEN));

// --- CORS: authenticated responses must not be readable by any site --------
r = await call('/curated/transactions.json', { token: TOKEN, origin: 'https://verity.example' });
check('allowed origin is echoed', r.headers.get('access-control-allow-origin') === 'https://verity.example');
check('  with credentials', r.headers.get('access-control-allow-credentials') === 'true');
check('  and varies on Origin', (r.headers.get('vary') || '').includes('Origin'));

r = await call('/curated/transactions.json', { token: TOKEN, origin: 'https://evil.example' });
check('unlisted origin gets no ACAO header', r.headers.get('access-control-allow-origin') === null,
  String(r.headers.get('access-control-allow-origin')));
check('  never answers with a wildcard', r.headers.get('access-control-allow-origin') !== '*');

r = await call('/curated/transactions.json', { token: TOKEN, origin: 'http://localhost:5173' });
check('a second configured origin also works', r.headers.get('access-control-allow-origin') === 'http://localhost:5173');

// --- preflight --------------------------------------------------------------
r = await call('/curated/transactions.json', { method: 'OPTIONS', origin: 'https://verity.example' });
check('preflight uses curated CORS, not the proxy default', r.headers.get('access-control-allow-origin') === 'https://verity.example');
check('  and allows the Authorization header', (r.headers.get('access-control-allow-headers') || '').includes('Authorization'));
r = await call('/curated/transactions.json', { method: 'OPTIONS', origin: 'https://evil.example' });
check('preflight refuses an unlisted origin', r.headers.get('access-control-allow-origin') === null);

// --- caching ----------------------------------------------------------------
r = await call('/curated/transactions.json', { token: TOKEN });
check('never stored in a shared cache', (r.headers.get('cache-control') || '').includes('no-store'), r.headers.get('cache-control'));
check('  marked private', (r.headers.get('cache-control') || '').includes('private'));
check('  and nothing was put in caches.default', store.size === 0, `${store.size} entries`);

// --- paths ------------------------------------------------------------------
for (const bad of ['/curated/../etc/passwd', '/curated/a//b.json', '/curated/x y.json', '/curated/sub/']) {
  const rr = await call(bad, { token: TOKEN });
  const escaped = upstreamCalls.filter((c) => !c.url.startsWith('https://api.github.com/repos/HBT89/govdata-curated/contents/'));
  check(`${bad} is refused`, rr.status >= 400, `got ${rr.status}`);
  check(`  and fetches nothing outside the curated repo`, escaped.length === 0);
}
r = await call('/curated/person/A000379.json', { token: TOKEN });
check('a nested curated path is allowed', r.status === 200 && upstreamCalls[0].url.endsWith('/contents/person/A000379.json'));

// --- upstream failures ------------------------------------------------------
r = await call('/curated/missing.json', { token: TOKEN });
check('missing file is a 404', r.status === 404);
r = await call('/curated/broken.json', { token: TOKEN });
const brokenBody = await r.text();
check('upstream 500 becomes a 502', r.status === 502);
check('  without passing the GitHub status or body through', !brokenBody.includes('boom') && !brokenBody.includes('500'), brokenBody);

// --- method guard -----------------------------------------------------------
r = await call('/curated/transactions.json', { token: TOKEN, method: 'POST' });
check('POST is refused', r.status === 405);

// --- the public route is unaffected ----------------------------------------
r = await worker.fetch(new Request('https://proxy.example/xref'), ENV);
check('/xref stays public and open', r.headers.get('access-control-allow-origin') === '*');

console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
