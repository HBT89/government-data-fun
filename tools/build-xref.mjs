// Merges every entity file into the reverse-lookup index.
//
// Run after the entity builders. Reads data/entities/*.json, emits the flat
// "<agency>:<native id>" -> "<prefix>:<key>" map, the dereference table, and a
// manifest describing what was built.
//
//   node tools/build-xref.mjs [--out data]
//
// A collision means one foreign identifier resolved to two different entities.
// That is a data problem, not a cosmetic one: it makes a lookup ambiguous, so
// collisions are reported per namespace and the build exits non-zero.

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SOURCES } from './sources.mjs';

function argOut() {
  const i = process.argv.indexOf('--out');
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : 'data';
}

async function main() {
  const out = argOut();
  const entDir = join(out, 'entities');
  const files = (await readdir(entDir)).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) throw new Error(`no entity files in ${entDir}; run the entity builders first`);

  const xref = {};
  const owner = {};                 // foreign key -> first ref that claimed it
  const collisions = [];
  const byNamespace = {};
  const builds = {};

  for (const f of files) {
    const doc = JSON.parse(await readFile(join(entDir, f), 'utf8'));
    const prefix = doc.ref_prefix;
    if (!prefix) throw new Error(`${f} has no ref_prefix`);

    const bindingCounts = {};
    for (const [key, e] of Object.entries(doc.entities)) {
      const ref = `${prefix}:${key}`;
      for (const [agency, raw] of Object.entries(e.b || {})) {
        const list = Array.isArray(raw) ? raw : [raw];
        if (list.length) bindingCounts[agency] = (bindingCounts[agency] || 0) + 1;
        for (const v of list) {
          const fk = `${agency}:${v}`;
          if (owner[fk] && owner[fk] !== ref) {
            collisions.push({ key: fk, claimed_by: owner[fk], also: ref });
            continue;             // first claim wins; the clash is reported
          }
          owner[fk] = ref;
          xref[fk] = ref;
          byNamespace[agency] = (byNamespace[agency] || 0) + 1;
        }
      }
    }

    builds[doc.kind] = {
      file: `entities/${f}`,
      upstream: doc.upstream,
      ref_prefix: prefix,
      entities: doc.count,
      bindings_by_agency: bindingCounts,
      generated_at: doc.generated_at,
    };
  }

  // Every namespace the index emits must be documented, or a consumer holding
  // one of those keys has no way to resolve it.
  const undocumented = Object.keys(byNamespace).filter((a) => !SOURCES[a]);
  if (undocumented.length) throw new Error(`namespaces missing from sources.mjs: ${undocumented.join(', ')}`);

  const now = new Date().toISOString();
  const w = (p, o) => writeFile(p, JSON.stringify(o, null, 2) + '\n', 'utf8');
  await mkdir(join(out, 'index'), { recursive: true });

  await w(join(out, 'index', 'xref.json'), {
    v: 1, generated_at: now,
    note: 'Flat reverse lookup. Key is "<agency>:<native id>", value is an entity ref. One object access, no search.',
    count: Object.keys(xref).length,
    keys_by_namespace: byNamespace,
    xref,
  });
  await w(join(out, 'index', 'sources.json'), { v: 1, generated_at: now, sources: SOURCES });

  // The manifest is shared. This stage owns the builds and xref blocks; the
  // shard stage owns its own and may have run either side of this one. Carry
  // over what this stage does not own, so the two cannot silently erase each
  // other depending on the order they were run in.
  let carried = {};
  try {
    const prev = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    if (prev.shards) carried = { shards: prev.shards };
  } catch { /* no manifest yet, nothing to carry */ }

  await w(join(out, 'manifest.json'), {
    v: 1, generated_at: now, builds,
    xref: { keys: Object.keys(xref).length, by_namespace: byNamespace, collisions: collisions.length },
    ...carried,
  });

  process.stdout.write(
    `${files.length} entity files -> ${Object.keys(xref).length} xref keys\n` +
    Object.entries(byNamespace).sort((a, b) => b[1] - a[1])
      .map(([a, c]) => `  ${a.padEnd(12)} ${c}`).join('\n') + '\n'
  );

  if (collisions.length) {
    process.stderr.write(`\n${collisions.length} collisions, first 10:\n`);
    for (const c of collisions.slice(0, 10)) {
      process.stderr.write(`  ${c.key} claimed by ${c.claimed_by}, also ${c.also}\n`);
    }
    process.exit(1);
  }
  process.stdout.write('no collisions\n');
}

main().catch((e) => { process.stderr.write(`build failed: ${e.message}\n`); process.exit(1); });
