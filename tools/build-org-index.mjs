// Builds the organization half of the cross-reference index.
//
// Source of truth is SEC's company_tickers.json: the registry of companies with
// a listed ticker, each carrying the CIK that EDGAR files under. Every binding
// here is an identifier SEC itself assigned, so basis is "authority" and no name
// matching happens. Name-resolved bindings (FCC, USAspending) are a separate
// tier and will carry a different basis when they land.
//
//   node tools/build-org-index.mjs [--out data]
//
// SEC rejects requests whose User-Agent carries no contact address. Override the
// default with SEC_USER_AGENT; it should name you and give a reachable address.

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const UPSTREAM = 'https://www.sec.gov/files/company_tickers.json';
const UA = process.env.SEC_USER_AGENT || 'OpenGovDash Research Tool 1.0 contact@opengov.dev';

function argOut() {
  const i = process.argv.indexOf('--out');
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : 'data';
}

// EDGAR keys on the 10-digit zero-padded CIK. The unpadded form 404s.
const padCik = (n) => String(n).padStart(10, '0');

async function main() {
  const out = argOut();
  process.stdout.write(`fetching ${UPSTREAM}\n  as: ${UA}\n`);

  const res = await fetch(UPSTREAM, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (res.status === 403) {
    throw new Error('SEC returned 403. Set SEC_USER_AGENT to a string containing a contact email address.');
  }
  if (!res.ok) throw new Error(`upstream ${res.status} ${res.statusText}`);

  const rows = await res.json();
  const list = Object.values(rows);
  if (!list.length) throw new Error('upstream returned no companies');

  // A CIK carries one company but often several tickers, one per share class.
  // Apple is one ticker; Alphabet is GOOGL, GOOG, GOOGM, GOOGN. The entity is
  // the CIK, so tickers collapse into an array on it.
  const entities = {};
  let tickerRows = 0;
  let nameConflicts = 0;

  for (const r of list) {
    const cik = padCik(r.cik_str);
    const ticker = String(r.ticker || '').trim();
    const name = String(r.title || '').trim();
    if (!cik || cik === '0000000000' || !name) continue;

    if (!entities[cik]) {
      entities[cik] = { n: name, b: { sec: cik, ticker: [] }, basis: 'authority:sec-company-tickers' };
    } else if (entities[cik].n !== name) {
      // SEC occasionally spells the same CIK's name differently across rows.
      // Keep the first and count it rather than silently picking a winner.
      nameConflicts++;
    }
    if (ticker && !entities[cik].b.ticker.includes(ticker)) {
      entities[cik].b.ticker.push(ticker);
      tickerRows++;
    }
  }

  const doc = {
    v: 1,
    kind: 'org',
    generated_at: new Date().toISOString(),
    upstream: UPSTREAM,
    ref_prefix: 'o',
    note: 'Companies with a listed ticker, keyed by zero-padded CIK. Covers SEC registrants only: private companies and non-filers are absent by construction.',
    count: Object.keys(entities).length,
    entities,
  };

  await mkdir(join(out, 'entities'), { recursive: true });
  await writeFile(join(out, 'entities', 'org.json'), JSON.stringify(doc, null, 2) + '\n', 'utf8');

  const multi = Object.values(entities).filter((e) => e.b.ticker.length > 1).length;
  process.stdout.write(
    `\n${doc.count} organizations from ${list.length} ticker rows\n` +
    `  ${tickerRows} tickers bound, ${multi} companies with more than one share class\n` +
    (nameConflicts ? `  ${nameConflicts} rows disagreed on a CIK's name; first spelling kept\n` : '')
  );
}

main().catch((e) => { process.stderr.write(`build failed: ${e.message}\n`); process.exit(1); });
