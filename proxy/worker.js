// OpenGovDash CORS proxy — Cloudflare Worker.
// Forwards browser requests to government APIs that don't send CORS headers.
// Strips client auth/cookie headers; pins Access-Control-Allow-Origin to our known hosts.

import { handleDataApi } from './api.js';
import { handleDbApi } from './db.js';

const UPSTREAMS = {
  sec:         'https://efts.sec.gov',         // EDGAR full-text search (used today)
  sec_data:    'https://data.sec.gov',         // documented APIs: submissions, XBRL facts, frames
  sec_www:     'https://www.sec.gov',          // ticker→CIK static file at /files/company_tickers.json
  bls:         'https://api.bls.gov',
  nih_pubmed:  'https://eutils.ncbi.nlm.nih.gov',
  loc:         'https://www.loc.gov',
  usaspending: 'https://api.usaspending.gov',
  doj:         'https://www.justice.gov',
  dot:         'https://api.nhtsa.gov',
  epa:         'https://data.epa.gov',
  sam:         'https://api.sam.gov',
  ftc:         'https://www.ftc.gov',
  nara:        'https://catalog.archives.gov',
  fcc_ecfs:    'https://publicapi.fcc.gov',
  congress:    'https://api.congress.gov',          // legislative branch — needs data.gov key
  fedreg:      'https://www.federalregister.gov',   // daily federal journal, no key
  regulations: 'https://api.regulations.gov',       // public comments — needs data.gov key
  fema:        'https://www.fema.gov',              // OpenFEMA datasets, no key
  ecfr:        'https://www.ecfr.gov',              // electronic CFR, no key
  fbi:         'https://api.usa.gov',                // FBI Crime Data Explorer — needs data.gov key

  // Hosts the Flask backend fetches but the Worker had no route to, so the
  // browser could not reach them through the proxy at all. This table is the
  // CORS host list, not the agency list: adding a host makes it reachable, it
  // does not give the normalized data API an implementation for it. That list
  // is REGISTRY in api.js, and tools/test-agency-parity.mjs is what tracks it.
  census:      'https://api.census.gov',             // ACS — no key for modest pulls
  fda:         'https://api.fda.gov',                // openFDA — recalls, adverse events
  fdic:        'https://banks.data.fdic.gov',         // BankFind
  fec:         'https://api.open.fec.gov',            // campaign finance — needs data.gov key
  nasa:        'https://api.nasa.gov',                // APOD and friends — DEMO_KEY works
  nist:        'https://services.nvd.nist.gov',       // National Vulnerability Database
  noaa:        'https://api.weather.gov',             // weather.gov — requires a UA
  treasury:    'https://api.fiscaldata.treasury.gov', // Fiscal Data
  usgs:        'https://earthquake.usgs.gov',         // earthquake catalog
  usgs_water:  'https://waterservices.usgs.gov',      // water services, separate host
};

// Browser-like User-Agent. Several upstreams (LOC, EPA) are behind Cloudflare or
// WAFs that block generic "OpenGovDash/1.0" style UAs. This UA matches a real
// Chrome and still identifies the app via the Referer header (set to our site).
const PROXY_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 OpenGovDash/1.0';

const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/selvidge\.tech$/,
  /^https:\/\/[a-z0-9-]+\.github\.io$/,
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

const DEFAULT_ORIGIN = 'https://selvidge.tech';

function pickAllowOrigin(origin) {
  if (origin && ALLOWED_ORIGIN_PATTERNS.some(re => re.test(origin))) return origin;
  return DEFAULT_ORIGIN;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, X-Requested-With',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// ---- Cross-reference index -------------------------------------------------
// Served in front of the Pages origin, which stays canonical: Pages holds the
// committed artifact, this route only fronts it for caching and to put the
// index on the same origin as the rest of the API.
//
// Set XREF_ORIGIN in wrangler.toml to point at a different publisher. The
// default is the Pages site this repository deploys, which serves on the
// project's custom domain rather than the github.io address -- that is the URL
// the Pages deployment itself reports, and the one the app is already served
// from.
const XREF_ORIGIN_DEFAULT = 'https://selvidge.tech/government-data-fun/data';

// The index is a regenerated artifact, not a live feed. A long edge cache with
// revalidation is right for it: a consumer dereferencing 500 shards should hit
// the edge, and a refresh lands within the hour.
const XREF_CACHE_SECONDS = 3600;

// The index is public, addressable data, so it answers any origin rather than
// the pinned list the proxy routes use. That is the point of publishing it.
const XREF_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Access-Control-Max-Age': '86400',
};

async function handleXref(request, url, env) {
  const origin = (env && env.XREF_ORIGIN) || XREF_ORIGIN_DEFAULT;

  // Everything after /xref/ is a path within the published index. Reject
  // anything that is not a plain relative path: this route forwards to a fixed
  // origin, so a traversal segment must never be able to walk out of it.
  // A backslash is normalised to a forward slash by the URL parser, so
  // "/xref/\evil" arrives as "/xref//evil" and would forward a double-slash
  // path. It cannot leave the origin, but the index is addressed by exact
  // path and there is one spelling of each: anything else is refused rather
  // than quietly rewritten.
  const rel = url.pathname.replace(/^\/xref\/?/, '');
  if (rel && (rel.startsWith('/') || rel.includes('//') || rel.endsWith('/'))) {
    return new Response(JSON.stringify({ error: 'bad path' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...XREF_CORS },
    });
  }
  if (rel && !/^[A-Za-z0-9._\/-]+$/.test(rel)) {
    return new Response(JSON.stringify({ error: 'bad path' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...XREF_CORS },
    });
  }
  if (rel.split('/').some((seg) => seg === '..')) {
    return new Response(JSON.stringify({ error: 'bad path' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...XREF_CORS },
    });
  }

  // Bare /xref is the manifest: what was built, from what, when.
  const target = `${origin}/${rel || 'manifest.json'}`;

  const cache = caches.default;
  const cacheKey = new Request(target, { method: 'GET' });
  let res = await cache.match(cacheKey);
  let hit = true;

  if (!res) {
    hit = false;
    const upstream = await fetch(target, { headers: { 'Accept': 'application/json' } });
    if (!upstream.ok) {
      return new Response(JSON.stringify({ error: 'not in the index', path: rel, status: upstream.status }), {
        status: upstream.status === 404 ? 404 : 502,
        headers: { 'Content-Type': 'application/json', ...XREF_CORS },
      });
    }
    res = new Response(upstream.body, upstream);
    res.headers.set('Cache-Control', `public, max-age=${XREF_CACHE_SECONDS}`);
    res.headers.set('Content-Type', 'application/json; charset=utf-8');
    await cache.put(cacheKey, res.clone());
  }

  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(XREF_CORS)) out.headers.set(k, v);
  out.headers.set('X-Xref-Cache', hit ? 'hit' : 'miss');
  out.headers.set('X-Xref-Origin', origin);
  return out;
}

// ---- Curated tier ----------------------------------------------------------
// Parsed filing contents, served to named consumers only. Unlike /xref, this
// is NOT public: the curated tier is the contents of financial disclosure
// reports, and 5 U.S.C. app. 105(c) binds each person who obtains or uses one.
// The public/curated split is the whole point of the architecture, so this
// route authenticates and the other does not.
//
// Reads from the private curated repository through the GitHub contents API.
// No Cloudflare KV or R2 binding is needed, and the curated data never has to
// be copied into a public artifact to be served.
//
// Secrets, set with `wrangler secret put`, never in wrangler.toml:
//   CURATED_TOKEN   the bearer token a consumer presents
//   GITHUB_TOKEN    a read-only PAT for the private curated repository
// Vars, in wrangler.toml:
//   CURATED_REPO            owner/name of the curated repository
//   CURATED_ALLOWED_ORIGINS comma-separated origins allowed to send the token
const CURATED_REPO_DEFAULT = 'HBT89/govdata-curated';

// Compares in time independent of how much of the token matched. A plain ===
// returns on the first differing byte, which leaks the prefix to anyone who
// can measure it.
function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  // Length is not secret, but bail without comparing to avoid indexing past
  // the end of the shorter array.
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

// An authenticated endpoint cannot answer "*": a browser refuses a credentialed
// request against a wildcard, and echoing an arbitrary Origin would let any
// site read the response using a victim's token. Only configured origins.
function curatedCors(env, origin) {
  const allowed = String((env && env.CURATED_ALLOWED_ORIGINS) || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const h = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (origin && allowed.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Credentials'] = 'true';
  }
  return h;
}

function curatedError(env, origin, status, error, extra = {}) {
  return new Response(JSON.stringify({ error, ...extra }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Never let an authenticated answer, or the refusal of one, sit in a
      // shared cache keyed only by URL.
      'Cache-Control': 'private, no-store',
      ...curatedCors(env, origin),
    },
  });
}

async function handleCurated(request, url, env, origin) {
  const expected = env && env.CURATED_TOKEN;
  if (!expected) {
    // Fail closed. An unset secret must not mean an open endpoint.
    return curatedError(env, origin, 503, 'curated access is not configured');
  }

  const auth = request.headers.get('Authorization') || '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!tokensMatch(presented, expected)) {
    return curatedError(env, origin, 401, 'unauthorized', {
      hint: 'send Authorization: Bearer <token>',
    });
  }

  const rel = url.pathname.replace(/^\/curated\/?/, '');
  if (rel && (rel.startsWith('/') || rel.includes('//') || rel.endsWith('/')
              || !/^[A-Za-z0-9._\/-]+$/.test(rel) || rel.split('/').includes('..'))) {
    return curatedError(env, origin, 400, 'bad path');
  }
  const path = rel || 'transactions.json';

  const repo = (env && env.CURATED_REPO) || CURATED_REPO_DEFAULT;
  const ghToken = env && env.GITHUB_TOKEN;
  if (!ghToken) return curatedError(env, origin, 503, 'curated source is not configured');

  const upstream = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}`,
    {
      headers: {
        'Authorization': `Bearer ${ghToken}`,
        'Accept': 'application/vnd.github.raw',
        'User-Agent': 'OpenGovDash-XrefIndex',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );

  if (upstream.status === 404) {
    return curatedError(env, origin, 404, 'not in the curated tier', { path });
  }
  if (!upstream.ok) {
    // Do not pass a GitHub status or body through: it describes the private
    // repository and the Worker's own credential, not the caller's request.
    return curatedError(env, origin, 502, 'curated source unavailable');
  }

  const out = new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
      // Travels with the data, as it does on every other artifact of this tier.
      'X-Use-Restriction': '5 USC app 105(c); see the curated repository README',
      ...curatedCors(env, origin),
    },
  });
  return out;
}

// Free-mode LLM via Cloudflare Workers AI. No user key; this is the reliable
// replacement for HuggingFace serverless. Llama 3.3 70B supports tool calling.
const FREE_AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

async function handleFreeAI(request, env, allowOrigin) {
  if (!env || !env.AI) {
    return json({ error: { type: 'no_binding',
      message: 'Free AI is not configured on this deployment. Add a Groq key (free) for AI chat.' } }, 200, allowOrigin);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: { message: 'bad request body' } }, 400, allowOrigin); }
  const input = { messages: body.messages || [], max_tokens: Math.min(body.max_tokens || 2000, 4000) };
  if (Array.isArray(body.tools) && body.tools.length) input.tools = body.tools;
  try {
    const out = await env.AI.run(FREE_AI_MODEL, input);
    // Normalize to an OpenAI-ish shape the frontend already understands.
    const toolCalls = (out.tool_calls || []).map((tc, i) => ({
      id: tc.id || `cf_${Date.now()}_${i}`,
      type: 'function',
      function: { name: tc.name || tc.function?.name, arguments: JSON.stringify(tc.arguments ?? tc.function?.arguments ?? {}) },
    }));
    return json({
      choices: [{ message: { role: 'assistant', content: out.response || '', tool_calls: toolCalls.length ? toolCalls : undefined } }],
    }, 200, allowOrigin);
  } catch (e) {
    const msg = String(e && e.message || e);
    const rateLimited = /rate|limit|quota|capacity|exceeded|neuron/i.test(msg);
    return json({ error: {
      type: rateLimited ? 'rate_limited' : 'upstream_error',
      message: rateLimited
        ? 'Free AI has hit its shared daily limit. It resets at 00:00 UTC. For unlimited fast access, add a free Groq key (30-second signup).'
        : `Free AI error: ${msg}. You can add a free Groq key for reliable access.`,
    } }, 200, allowOrigin);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowOrigin = pickAllowOrigin(origin);

    if (request.method === 'OPTIONS') {
      // The curated route has its own origin rules, so its preflight cannot be
      // answered with the proxy's permissive ones.
      if (url.pathname === '/curated' || url.pathname.startsWith('/curated/')) {
        return new Response(null, { status: 204, headers: curatedCors(env, origin) });
      }
      return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, upstreams: Object.keys(UPSTREAMS), freeAI: !!(env && env.AI), dataApi: '/api/v1', xref: '/xref', curated: '/curated (authenticated)' }, 200, allowOrigin);
    }

    // Normalized data API (v1) — public, machine-readable, edge-cached.
    // Own CORS (Access-Control-Allow-Origin: *) since it serves public gov data.
    if (url.pathname === '/api/v1' || url.pathname.startsWith('/api/v1/')) {
      return handleDataApi(request, url, env);
    }

    // Cross-reference "DB" layer — named tables joining multiple agencies.
    if (url.pathname === '/api/db' || url.pathname.startsWith('/api/db/')) {
      return handleDbApi(request, url, env);
    }

    // Cross-reference index, fronted from the Pages origin. Public data, so it
    // carries its own CORS rather than the pinned proxy list.
    if (url.pathname === '/xref' || url.pathname.startsWith('/xref/')) {
      if (request.method !== 'GET') {
        return json({ error: 'method not allowed' }, 405, allowOrigin);
      }
      return handleXref(request, url, env);
    }

    // Curated tier. Authenticated, never cached in a shared cache, and its
    // CORS is limited to configured origins rather than answering anyone.
    if (url.pathname === '/curated' || url.pathname.startsWith('/curated/')) {
      if (request.method !== 'GET') {
        return curatedError(env, origin, 405, 'method not allowed');
      }
      return handleCurated(request, url, env, origin);
    }

    if (url.pathname === '/ai/chat' && request.method === 'POST') {
      return handleFreeAI(request, env, allowOrigin);
    }

    const match = url.pathname.match(/^\/p\/([a-z_]+)(\/.*)?$/);
    if (!match || !UPSTREAMS[match[1]]) {
      return json({ error: 'unknown upstream', path: url.pathname }, 404, allowOrigin);
    }

    const upstreamBase = UPSTREAMS[match[1]];
    const upstreamPath = match[2] || '/';
    const upstreamUrl = upstreamBase + upstreamPath + url.search;

    const outHeaders = new Headers();
    for (const [k, v] of request.headers) {
      const lower = k.toLowerCase();
      if (lower === 'authorization' || lower === 'cookie' || lower === 'host'
          || lower === 'x-forwarded-for' || lower === 'x-real-ip'
          || lower.startsWith('cf-')) continue;
      outHeaders.set(k, v);
    }
    outHeaders.set('User-Agent', PROXY_UA);
    outHeaders.set('Referer', 'https://selvidge.tech/government-data-fun/');

    let upstreamResp;
    try {
      upstreamResp = await fetch(upstreamUrl, {
        method: request.method,
        headers: outHeaders,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
        redirect: 'follow',
      });
    } catch (err) {
      return json({ error: 'upstream fetch failed', message: err.message, upstream: upstreamUrl }, 502, allowOrigin);
    }

    const respHeaders = new Headers(upstreamResp.headers);
    respHeaders.delete('set-cookie');
    respHeaders.delete('set-cookie2');
    for (const [k, v] of Object.entries(corsHeaders(allowOrigin))) respHeaders.set(k, v);

    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: respHeaders,
    });
  },
};
