// Tests the /xref route against a stubbed Workers runtime: no wrangler, no
// network, no deploy. Run with bare node.
//
//     node proxy/test-xref-route.mjs
//
// The route fronts a fixed origin, so the invariant that matters is that a
// request can never cause a fetch outside it, whatever the path looks like.
const store = new Map();
globalThis.caches = {
  default: {
    async match(req) { const r = store.get(req.url); return r ? r.clone() : undefined; },
    async put(req, res) { store.set(req.url, res.clone()); },
  },
};
const fetched = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = typeof input === 'string' ? input : input.url;
  fetched.push(u);
  if (u.endsWith('/nope.json')) return new Response('not found', { status: 404 });
  if (u.endsWith('/boom.json')) return new Response('err', { status: 500 });
  return new Response(JSON.stringify({ served: u }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};

const worker = (await import(new URL('./worker.js', import.meta.url))).default;
const get = (path, method = 'GET') =>
  worker.fetch(new Request(`https://proxy.example${path}`, { method }), {});

let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ' :: ' + extra}`);
  if (!cond) fail++;
};

// bare /xref -> manifest
let r = await get('/xref');
check('/xref serves the manifest', fetched.at(-1).endsWith('/data/manifest.json'), fetched.at(-1));
check('  CORS is open', r.headers.get('access-control-allow-origin') === '*');
check('  reports a cache miss', r.headers.get('x-xref-cache') === 'miss');

// a shard
r = await get('/xref/person/A000379.json');
check('shard path forwards verbatim', fetched.at(-1).endsWith('/data/person/A000379.json'), fetched.at(-1));
check('  json content-type', (r.headers.get('content-type') || '').includes('application/json'));

// cache hit on repeat
const before = fetched.length;
r = await get('/xref/person/A000379.json');
check('second request is served from cache', fetched.length === before && r.headers.get('x-xref-cache') === 'hit');

// Traversal must never reach the upstream origin. URL normalisation collapses
// "/xref/../x" to "/x" before the route matches, so those 404 as an unknown
// path rather than reaching the handler at all; what matters either way is
// that nothing outside the index origin is ever fetched.
const ORIGIN = 'https://hbt89.github.io/government-data-fun/data/';
for (const bad of ['/xref/../secrets', '/xref/a/../../etc/passwd', '/xref/foo%2e%2e/bar', '/xref/a b', '/xref/\\evil']) {
  const n = fetched.length;
  const rr = await get(bad);
  const escaped = fetched.slice(n).filter((u) => !u.startsWith(ORIGIN));
  check(`${bad} is refused`, rr.status >= 400, `got ${rr.status}`);
  check(`  and fetches nothing outside the index`, escaped.length === 0, escaped.join(','));
}

// upstream failures map sensibly
check('404 upstream -> 404', (await get('/xref/nope.json')).status === 404);
check('500 upstream -> 502', (await get('/xref/boom.json')).status === 502);

// method guard
check('POST is refused', (await get('/xref', 'POST')).status === 405);

// health advertises it
const h = await worker.fetch(new Request('https://proxy.example/health'), {});
check('/health advertises /xref', (await h.json()).xref === '/xref');

globalThis.fetch = realFetch;
console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
