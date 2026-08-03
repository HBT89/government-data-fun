// OpenGovDash — Cross-Reference "DB" layer (/api/db)
// ---------------------------------------------------------------------------
// A place to define named *tables* of cross-referenced government data. Each
// table fans out across several normalized sources (from api.js's REGISTRY),
// tags every row with its origin, and returns one unified, normalized result
// set. This is where you "craft specific tables of cross-referenced data" —
// add an entry to TABLES and it's instantly queryable + self-documented.
//
// Routes (wired in worker.js):
//   GET /api/db                → list available tables + their params/sources
//   GET /api/db/{table}?q=&limit=&from=&to=&api_key=&format=json|csv
//
// Contract mirrors /api/v1: every row is {title, description, date, link, ...}
// plus a `_source` tag ("agency:kind"). Envelope: { ok, table, count, rows, ... }.
// ---------------------------------------------------------------------------

import { fetchNormalized, sourceNeedsKey } from './api.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const API_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, X-Api-Key',
  'Access-Control-Max-Age': '86400',
};
const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...API_CORS, ...extra } });
const clampLimit = (v) => { const n = parseInt(v, 10); return !Number.isFinite(n) || n <= 0 ? DEFAULT_LIMIT : Math.min(n, MAX_LIMIT); };

// Fetch a source without letting one failure sink the whole table.
async function safe(agency, sub, ctx) {
  try { return await fetchNormalized(agency, sub, ctx); }
  catch (e) { return { _error: `${agency}/${sub}: ${String(e.message || e)}` }; }
}
// Tag rows with their origin; pass through error markers so the table can report them.
function tag(rowsOrErr, source) {
  if (rowsOrErr && rowsOrErr._error) return { _error: rowsOrErr._error };
  return (rowsOrErr || []).map((r) => ({ _source: source, ...r }));
}
function collect(...tagged) {
  const rows = [], errors = [];
  for (const t of tagged) {
    if (t && t._error) errors.push(t._error);
    else rows.push(...t);
  }
  return { rows, errors };
}

// ===========================================================================
// TABLE REGISTRY — add cross-referenced tables here.
//   { description, params, sources[], requiresQuery?, run(ctx) -> {rows, errors} }
// run() receives ctx = {q, limit, from, to, apiKey}.
// ===========================================================================
const TABLES = {

  'drug-safety': {
    description: 'One drug across FDA adverse-event reports, FDA recalls, and NIH clinical trials — a single safety picture keyed on the drug name.',
    params: { q: 'drug name (required, e.g. "metformin")', limit: 'rows per source (default 20)' },
    sources: ['fda/drug_events', 'fda/drug_recalls', 'nih/clinical_trials'],
    requiresQuery: true,
    run: async (ctx) => collect(
      tag(await safe('fda', 'drug_events', ctx), 'fda:adverse_event'),
      tag(await safe('fda', 'drug_recalls', ctx), 'fda:recall'),
      tag(await safe('nih', 'clinical_trials', ctx), 'nih:clinical_trial'),
    ),
  },

  'cyber-landscape': {
    description: 'Cybersecurity cross-section: recent NIST CVEs + federal cyber contract awards (USAspending) + Federal Register cyber rules. Defaults to keyword "cybersecurity"; pass q to focus (e.g. a vendor).',
    params: { q: 'optional keyword/vendor (default "cybersecurity")', limit: 'rows per source' },
    sources: ['nist/cve', 'usaspending/award_search', 'fedreg/documents'],
    run: async (ctx) => {
      const kw = ctx.q || 'cybersecurity';
      return collect(
        tag(await safe('nist', 'cve', { ...ctx, q: ctx.q || '' }), 'nist:cve'),
        tag(await safe('usaspending', 'award_search', { ...ctx, q: kw }), 'usaspending:award'),
        tag(await safe('fedreg', 'documents', { ...ctx, q: kw }), 'fedreg:rule'),
      );
    },
  },

  'disaster-response': {
    description: 'Disaster + money view: FEMA disaster declarations alongside USAspending awards for the same keyword/area. Pass q as a state or incident keyword (e.g. "flood", "California").',
    params: { q: 'state or incident keyword (required)', limit: 'rows per source' },
    sources: ['fema/disasters', 'usaspending/award_search'],
    requiresQuery: true,
    run: async (ctx) => collect(
      tag(await safe('fema', 'disasters', ctx), 'fema:disaster'),
      tag(await safe('usaspending', 'award_search', ctx), 'usaspending:award'),
    ),
  },

  // --- Add new cross-reference tables above. Template:
  // 'my-table': {
  //   description: 'What this joins and why.',
  //   params: { q: '...', limit: '...' },
  //   sources: ['agencyA/subX', 'agencyB/subY'],
  //   requiresQuery: false,
  //   run: async (ctx) => collect(
  //     tag(await safe('agencyA', 'subX', ctx), 'agencyA:thing'),
  //     tag(await safe('agencyB', 'subY', ctx), 'agencyB:thing'),
  //   ),
  // },
};

function tableDoc(id) {
  const t = TABLES[id];
  return {
    id, description: t.description, params: t.params || {},
    sources: t.sources,
    requires_query: !!t.requiresQuery,
    // A table needs a caller key if any of its sources do.
    api_key_required: t.sources.some((s) => sourceNeedsKey(s.split('/')[0])),
    path: `/api/db/${id}`,
  };
}

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Array.from(rows.reduce((s, r) => { Object.keys(r).forEach((k) => s.add(k)); return s; }, new Set()));
  const esc = (v) => { if (v == null) return ''; const s = typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

// ===========================================================================
export async function handleDbApi(request, url) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: API_CORS });
  if (request.method !== 'GET') return json({ ok: false, error: { type: 'method_not_allowed', message: 'Use GET.' } }, 405);

  const parts = url.pathname.split('/').filter(Boolean); // ['api','db', ...]
  const tableId = parts[2];

  if (!tableId) {
    return json({
      ok: true, service: 'OpenGovDash Cross-Reference API', version: 'v1',
      note: 'Named tables that join normalized data across agencies. Query with /api/db/{table}. Tables requiring a caller key take your own api.data.gov key (?api_key= or X-Api-Key).',
      count: Object.keys(TABLES).length,
      tables: Object.keys(TABLES).map(tableDoc),
    });
  }

  const table = TABLES[tableId];
  if (!table) return json({ ok: false, error: { type: 'unknown_table', message: `No table '${tableId}'. See /api/db.`, available: Object.keys(TABLES) } }, 404);

  const q = url.searchParams.get('q') || '';
  const limit = clampLimit(url.searchParams.get('limit'));
  const from = url.searchParams.get('from') || '';
  const to = url.searchParams.get('to') || '';
  const format = (url.searchParams.get('format') || 'json').toLowerCase();
  const apiKey = url.searchParams.get('api_key') || request.headers.get('X-Api-Key') || '';

  if (table.requiresQuery && !q) return json({ ok: false, error: { type: 'query_required', message: `Table '${tableId}' requires a ?q= value.`, params: table.params } }, 400);
  const doc = tableDoc(tableId);
  if (doc.api_key_required && !apiKey) return json({ ok: false, error: { type: 'api_key_required', message: `Table '${tableId}' includes key-gated sources; pass your own api.data.gov key (?api_key= or X-Api-Key). Free at https://api.data.gov/signup/.` } }, 401);

  let result;
  try { result = await table.run({ q, limit, from, to, apiKey }); }
  catch (e) { return json({ ok: false, error: { type: 'table_error', message: String(e.message || e) }, table: tableId }, 502); }

  const rows = result.rows || [];
  if (format === 'csv') {
    return new Response(toCsv(rows), { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${tableId}.csv"`, ...API_CORS } });
  }
  return json({
    ok: true, table: tableId,
    query: { q: q || null, limit, from: from || null, to: to || null },
    sources: table.sources,
    count: rows.length,
    partial_errors: result.errors && result.errors.length ? result.errors : undefined,
    rows,
    generated_at: new Date().toISOString(),
  });
}
