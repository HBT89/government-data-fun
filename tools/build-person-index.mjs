// Builds the person half of the cross-reference index.
//
// Source of truth is unitedstates/congress-legislators, a long-curated public
// crosswalk. Every binding it gives us is an identifier some agency or project
// assigned to the same human, so the sameness assertion is theirs, not ours:
// basis is "authority" throughout and no name matching happens here.
//
//   node tools/build-person-index.mjs [--out data]
//
// Writes data/entities/person.json. Run tools/build-xref.mjs afterwards to
// regenerate the reverse-lookup index.

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const UPSTREAM =
  'https://unitedstates.github.io/congress-legislators/legislators-current.json';

// congress-legislators key -> our agency id in sources.mjs.
// Left out on purpose: ballotpedia, votesmart, cspan, maplight, pictorial,
// house_history, thomas, google_entity_id, wikipedia. They are real ids but
// nothing in this project dereferences them yet, and an index that lists
// pointers it cannot follow is worse than one that admits the gap.
const ID_MAP = {
  bioguide: 'congress',
  fec: 'fec',
  govtrack: 'govtrack',
  opensecrets: 'opensecrets',
  wikidata: 'wikidata',
  lis: 'lis',
  icpsr: 'icpsr',
};

const PARTY_SHORT = { Democrat: 'D', Republican: 'R', Independent: 'I' };

function argOut() {
  const i = process.argv.indexOf('--out');
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : 'data';
}

async function main() {
  const out = argOut();
  process.stdout.write(`fetching ${UPSTREAM}\n`);

  const res = await fetch(UPSTREAM);
  if (!res.ok) throw new Error(`upstream ${res.status} ${res.statusText}`);
  const people = await res.json();
  if (!Array.isArray(people) || !people.length) throw new Error('upstream returned no legislators');

  const entities = {};
  const bindingCounts = {};

  for (const p of people) {
    const ids = p.id || {};
    const bioguide = ids.bioguide;
    // bioguide is the canonical key. Without it there is nothing to hang the
    // entity on, so skip rather than invent an id.
    if (!bioguide) continue;

    const term = p.terms?.[p.terms.length - 1] || {};
    const bindings = {};

    for (const [srcKey, agency] of Object.entries(ID_MAP)) {
      const raw = ids[srcKey];
      if (raw === undefined || raw === null || raw === '') continue;
      // fec is an array: a legislator carries every candidate id they have ever
      // filed under, including prior runs for a different office.
      const list = Array.isArray(raw) ? raw : [raw];
      if (!list.length) continue;
      bindings[agency] = Array.isArray(raw) ? list.map(String) : String(raw);
      bindingCounts[agency] = (bindingCounts[agency] || 0) + 1;
    }

    entities[bioguide] = {
      n: p.name?.official_full || [p.name?.first, p.name?.last].filter(Boolean).join(' '),
      t: term.type || null,                       // 'sen' | 'rep'
      st: term.state || null,
      d: term.district ?? null,                   // null for senators
      pt: PARTY_SHORT[term.party] || term.party || null,
      b: bindings,
      basis: 'authority:congress-legislators',
    };
  }

  const doc = {
    v: 1,
    kind: 'person',
    generated_at: new Date().toISOString(),
    upstream: UPSTREAM,
    ref_prefix: 'p',
    note: 'Sitting members of Congress. Bindings are identifiers assigned by each listed source to the same person.',
    count: Object.keys(entities).length,
    entities,
  };

  await mkdir(join(out, 'entities'), { recursive: true });
  await writeFile(join(out, 'entities', 'person.json'), JSON.stringify(doc, null, 2) + '\n', 'utf8');

  const sen = Object.values(entities).filter((e) => e.t === 'sen').length;
  process.stdout.write(
    `\n${doc.count} people (${sen} sen, ${doc.count - sen} rep)\n` +
    Object.entries(bindingCounts).sort((a, b) => b[1] - a[1])
      .map(([a, c]) => `  ${a.padEnd(12)} ${c}`).join('\n') + '\n'
  );
}

main().catch((e) => { process.stderr.write(`build failed: ${e.message}\n`); process.exit(1); });
