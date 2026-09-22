// Builds the filing half of the cross-reference index: every House financial
// disclosure, addressable, with its filer resolved to a person entity.
//
// Free tier. This file carries document metadata only, never the contents of a
// filing. It tells you that a member filed a PTR on a date and where the PDF
// is. Parsing that PDF is a separate, curated build.
//
//   node tools/build-filing-index.mjs [--out data] [--years 2026,2025]
//
// Requires data/entities/person.json, since the filer match resolves against it.
// Run tools/build-xref.mjs afterwards.

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ZIP = (y) => `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${y}FD.zip`;
const UA = process.env.HOUSE_USER_AGENT || 'OpenGovDash XrefIndex/1.0 (contact@opengov.dev)';

// FilingType codes as they appear in the Clerk's XML index.
const KIND = {
  P: 'ptr',           // periodic transaction report: the trades
  O: 'annual',
  A: 'amendment',
  C: 'candidate',
  T: 'termination',
  W: 'withdrawal',
  X: 'extension',
  D: 'blind_trust',
  H: 'other',
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// Verified 2026-09-22 across the 2026 index: 8-digit DocIDs beginning 2003 are
// e-filed and carry a text layer; 7-digit ones are scans of paper filings.
// Recorded so a consumer knows which documents are machine-readable without
// fetching all of them.
const hasTextLayer = (docId) => {
  const d = String(docId || '');
  if (d.length === 8 && (d.startsWith('2003') || d.startsWith('1007'))) return true;
  if (d.length === 7) return false;
  return null;                       // unknown shape, do not guess
};

// PTRs live under a different path than annual filings.
const docUrl = (year, docId, kind) =>
  kind === 'ptr'
    ? `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${docId}.pdf`
    : `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}/${docId}.pdf`;

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');

function parseXmlMembers(xml) {
  // The Clerk's index is flat and regular: one <Member> per filing, no nesting,
  // no attributes. A dependency-free extraction is enough and keeps this
  // runnable with bare node.
  const out = [];
  const field = (block, tag) => {
    const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return m ? m[1].trim() : '';
  };
  for (const m of xml.matchAll(/<Member>([\s\S]*?)<\/Member>/g)) {
    const b = m[1];
    out.push({
      prefix: field(b, 'Prefix'), last: field(b, 'Last'), first: field(b, 'First'),
      suffix: field(b, 'Suffix'), filingType: field(b, 'FilingType'),
      stateDst: field(b, 'StateDst'), year: field(b, 'Year'),
      filingDate: field(b, 'FilingDate'), docId: field(b, 'DocID'),
    });
  }
  return out;
}

// StateDst is a two-letter state plus a zero-padded district, e.g. MO04. At-large
// seats appear as 00; person.json records those as district 0 too.
function splitStateDst(sd) {
  const m = String(sd || '').match(/^([A-Z]{2})(\d{2})$/);
  return m ? { state: m[1], district: parseInt(m[2], 10) } : { state: null, district: null };
}

function buildMatcher(people) {
  const byDistrict = new Map();     // "MO|4" -> [{key, last, full}]
  const byState = new Map();        // "MO"   -> [{key, last, full}]
  for (const [key, p] of Object.entries(people.entities)) {
    if (p.t !== 'rep' || !p.st) continue;
    const entry = { key, last: norm(String(p.n).split(/\s+/).slice(-1)[0]), full: norm(p.n) };
    const dk = `${p.st}|${p.d ?? 0}`;
    if (!byDistrict.has(dk)) byDistrict.set(dk, []);
    byDistrict.get(dk).push(entry);
    if (!byState.has(p.st)) byState.set(p.st, []);
    byState.get(p.st).push(entry);
  }

  const pick = (cands, last) =>
    cands.find((c) => c.last === last)
    || (last.length >= 4 ? cands.find((c) => c.full.includes(last)) : undefined);

  // Returns {key, basis} or null. Two tiers, labelled differently, because they
  // are not equally strong evidence.
  return (rec) => {
    const { state, district } = splitStateDst(rec.stateDst);
    if (!state) return null;
    const last = norm(rec.last);

    // Seat plus surname. Either the sitting member of that district shares the
    // filer's surname or this tier declines.
    const exact = pick(byDistrict.get(`${state}|${district}`) || [], last);
    if (exact) return { key: exact.key, basis: 'match:name+statedst' };

    // The index records the district as of filing; person.json records it now.
    // A member who changed seats fails the tier above through no error of
    // either source, so fall back to state plus surname, but only when exactly
    // one member in the state matches. Ambiguity declines rather than guesses.
    const inState = (byState.get(state) || []).filter((c) => c.last === last);
    if (inState.length === 1) return { key: inState[0].key, basis: 'match:name+state' };

    return null;
  };
}

async function fetchIndex(year) {
  const res = await fetch(ZIP(year), { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${year}: upstream ${res.status} ${res.statusText}`);
  const buf = new Uint8Array(await res.arrayBuffer());

  // Minimal zip reader: the archive holds one XML and one TXT, both deflated or
  // stored. Pulling in a zip dependency for two files is not worth it.
  const dec = new TextDecoder('utf-8');
  const files = {};
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf[i] !== 0x50 || buf[i + 1] !== 0x4b || buf[i + 2] !== 0x03 || buf[i + 3] !== 0x04) continue;
    const dv = new DataView(buf.buffer, buf.byteOffset + i);
    const method = dv.getUint16(8, true);
    const compSize = dv.getUint32(18, true);
    const nameLen = dv.getUint16(26, true);
    const extraLen = dv.getUint16(28, true);
    const nameStart = i + 30;
    const name = dec.decode(buf.subarray(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;
    if (!compSize) continue;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    if (!name.toLowerCase().endsWith('.xml')) continue;
    if (method === 0) { files[name] = dec.decode(raw); }
    else if (method === 8) {
      const ds = new DecompressionStream('deflate-raw');
      const out = await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer();
      files[name] = dec.decode(new Uint8Array(out));
    }
  }
  const xmlName = Object.keys(files)[0];
  if (!xmlName) throw new Error(`${year}: no XML found in archive`);
  return files[xmlName];
}

async function main() {
  const out = arg('out', 'data');
  const years = arg('years', String(new Date().getFullYear())).split(',').map((s) => s.trim());

  const people = JSON.parse(await readFile(join(out, 'entities', 'person.json'), 'utf8'));
  const match = buildMatcher(people);

  const entities = {};
  const stats = { byYear: {}, byKind: {}, matched: 0, unmatched: 0, byBasis: {}, textTrue: 0, textFalse: 0, textUnknown: 0 };
  const unmatchedSample = [];

  for (const year of years) {
    process.stdout.write(`fetching ${ZIP(year)}\n`);
    const xml = await fetchIndex(year);
    const recs = parseXmlMembers(xml);
    if (!recs.length) throw new Error(`${year}: index parsed to zero filings`);
    stats.byYear[year] = recs.length;

    for (const r of recs) {
      if (!r.docId) continue;
      const kind = KIND[r.filingType] || 'other';
      const hit = match(r);
      const text = hasTextLayer(r.docId);
      const { state, district } = splitStateDst(r.stateDst);

      if (hit) { stats.matched++; stats.byBasis[hit.basis] = (stats.byBasis[hit.basis] || 0) + 1; }
      else { stats.unmatched++; if (unmatchedSample.length < 8 && r.prefix === 'Hon.') unmatchedSample.push(`${r.last}, ${r.first} ${r.stateDst} ${kind}`); }
      stats.byKind[kind] = (stats.byKind[kind] || 0) + 1;
      if (text === true) stats.textTrue++; else if (text === false) stats.textFalse++; else stats.textUnknown++;

      entities[`h:${r.docId}`] = {
        k: kind,
        ch: 'house',
        b: { house_doc: String(r.docId) },
        f: hit ? `p:${hit.key}` : null,
        fn: [r.last, r.first].filter(Boolean).join(', '),
        inc: r.prefix === 'Hon.',          // filed as a sitting member
        st: state, d: district,
        y: Number(r.year) || null,
        dt: r.filingDate || null,
        url: docUrl(r.year, r.docId, kind),
        text,
        basis: hit ? hit.basis : 'unmatched',
      };
    }
  }

  const doc = {
    v: 1,
    kind: 'filing',
    generated_at: new Date().toISOString(),
    upstream: years.map(ZIP),
    ref_prefix: 'f',
    tier: 'public',
    note: 'Document metadata only. Records that a filing exists, who filed it and where the PDF is. It does not contain the contents of any filing.',
    use_restriction: 'Sourced from financial disclosure reports. Title 1 of the Ethics in Government Act of 1978, 5 U.S.C. app. 105(c), makes it unlawful to obtain or use such a report for an unlawful purpose, for a commercial purpose other than by news and communications media for dissemination to the general public, to establish any individual credit rating, or in the solicitation of money. Each person who obtains or uses these records is bound by that provision independently.',
    count: Object.keys(entities).length,
    entities,
  };

  await mkdir(join(out, 'entities'), { recursive: true });
  await writeFile(join(out, 'entities', 'filing.json'), JSON.stringify(doc, null, 2) + '\n', 'utf8');

  const ptr = Object.values(entities).filter((e) => e.k === 'ptr').length;
  const pct = (n) => `${((100 * n) / doc.count).toFixed(1)}%`;
  process.stdout.write(
    `\n${doc.count} filings across ${years.join(', ')}\n` +
    `  ptr ${ptr}\n` +
    Object.entries(stats.byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => `    ${k.padEnd(12)} ${v}`).join('\n') +
    `\n  filer matched   ${stats.matched} (${pct(stats.matched)})\n` +
    `  unmatched       ${stats.unmatched} (${pct(stats.unmatched)})\n` +
    `  text layer      true ${stats.textTrue} / false ${stats.textFalse} / unknown ${stats.textUnknown}\n`
  );
  if (unmatchedSample.length) {
    process.stdout.write(`\n  unmatched despite filing as a sitting member:\n` +
      unmatchedSample.map((s) => `    ${s}`).join('\n') + '\n');
  }
}

main().catch((e) => { process.stderr.write(`build failed: ${e.message}\n`); process.exit(1); });
