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
// default is the Pages site this repository deploys.
const XREF_ORIGIN_DEFAULT = 'https://hbt89.github.io/government-data-fun/data';

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
      return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, upstreams: Object.keys(UPSTREAMS), freeAI: !!(env && env.AI), dataApi: '/api/v1', xref: '/xref' }, 200, allowOrigin);
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
