// Publishes one file per person, so a consumer can dereference a single entity
// without fetching the whole index.
//
// Free tier. This is a reprojection of data/entities/person.json and
// data/entities/filing.json, not new data: same facts, same bases, addressed
// per entity instead of per file.
//
//   node tools/build-shards.mjs [--out data]
//
// Run after the entity builders. A consumer arrives holding any agency's id,
// resolves it through index/xref.json to a "p:" ref, and fetches exactly that
// shard: person/<bioguide>.json. It still never searches.
//
// The whole-file entities stay where they are. This adds an address, it does
// not replace one: a consumer that wants every person at once is better served
// by person.json than by 539 requests.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main() {
  const out = arg('out', 'data');
  const people = await readJson(join(out, 'entities', 'person.json'));
  const filings = await readJson(join(out, 'entities', 'filing.json'));

  // Group filings by filer once. Unmatched filings have no person to belong to
  // and are reachable only through filing.json, which is the correct outcome
  // rather than a gap: they were filed by candidates and departed members.
  const byFiler = new Map();
  let attached = 0;
  for (const [ref, e] of Object.entries(filings.entities)) {
    if (!e.f) continue;
    if (!byFiler.has(e.f)) byFiler.set(e.f, {});
    byFiler.get(e.f)[ref] = e;
    attached++;
  }

  const dir = join(out, 'person');
  await rm(dir, { recursive: true, force: true });   // stale shards must not survive a rebuild
  await mkdir(dir, { recursive: true });

  const generatedAt = new Date().toISOString();
  let bytes = 0;
  let withFilings = 0;
  let largest = { key: null, bytes: 0 };

  for (const [key, person] of Object.entries(people.entities)) {
    const ref = `p:${key}`;
    const mine = byFiler.get(ref) || {};
    const n = Object.keys(mine).length;
    if (n) withFilings++;

    // No generated_at on the shard itself. These are committed artifacts that
    // get regenerated, and a per-shard timestamp rewrites all 539 on every
    // refresh: the diff then says a rebuild happened instead of saying what
    // changed. manifest.json carries the build time for the set; a shard
    // changes only when its own data does.
    const doc = {
      v: 1,
      kind: 'person-shard',
      tier: 'public',
      ref,
      note: 'One person and the disclosure documents they filed. Document metadata only: it records that a filing exists and where the PDF is, never its contents.',
      person,
      counts: {
        filings: n,
        ptr: Object.values(mine).filter((e) => e.k === 'ptr').length,
      },
      filings: mine,
    };
    // The restriction travels with the data rather than living only in a
    // README, and a shard is where a consumer will actually arrive.
    if (n) doc.use_restriction = filings.use_restriction;

    const body = JSON.stringify(doc, null, 2) + '\n';
    bytes += Buffer.byteLength(body);
    if (Buffer.byteLength(body) > largest.bytes) largest = { key, bytes: Buffer.byteLength(body) };
    await writeFile(join(dir, `${key}.json`), body, 'utf8');
  }

  const count = Object.keys(people.entities).length;

  // Fold the shard build into the existing manifest rather than adding a second
  // one. Absent manifest is not an error: the shard stage can run before the
  // xref stage that writes it.
  const manifestPath = join(out, 'manifest.json');
  let manifest = null;
  try {
    manifest = await readJson(manifestPath);
  } catch {
    manifest = null;
  }
  if (manifest) {
    manifest.shards = {
      person: {
        dir: 'person/',
        template: 'person/{id}.json',
        keyed_by: 'congress',
        entities: count,
        with_filings: withFilings,
        filings_attached: attached,
        bytes_total: bytes,
        bytes_max: largest.bytes,
        generated_at: generatedAt,
      },
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }

  const whole = Buffer.byteLength(await readFile(join(out, 'entities', 'person.json')))
    + Buffer.byteLength(await readFile(join(out, 'entities', 'filing.json')));
  const kb = (b) => `${(b / 1024).toFixed(1)}KB`;
  process.stdout.write(
    `${count} person shards in ${dir}\n` +
    `  with filings    ${withFilings}\n` +
    `  filings attached ${attached} of ${filings.count}\n` +
    `  largest shard   ${kb(largest.bytes)} (${largest.key})\n` +
    `  mean shard      ${kb(bytes / count)}\n` +
    `  one person, whole files vs shard: ${kb(whole)} -> ${kb(largest.bytes)} worst case\n` +
    (manifest ? '' : '  manifest.json absent, shard block not written\n')
  );
}

main().catch((e) => { process.stderr.write(`build failed: ${e.message}\n`); process.exit(1); });
