// Fails when the two agency lists drift apart.
//
//     node tools/test-agency-parity.mjs
//
// The project has two independent implementations and it is easy to compare
// the wrong pair. There are three lists, and only two of them are about
// agency coverage:
//
//   webapp/app.py   AGENCY_REGISTRY  Python modules, one per agency
//   proxy/api.js    REGISTRY         normalized data API, one per agency
//   proxy/worker.js UPSTREAMS        CORS host allowlist -- NOT an agency list
//
// UPSTREAMS carries several hosts for one agency and hosts for agencies with
// no implementation at all, so counting it overstates coverage. Coverage is
// AGENCY_REGISTRY against REGISTRY.
//
// EXPECTED records the split that exists today. When you add an agency to one
// side, this fails until you either add it to the other or move it in
// EXPECTED, which is the point: the drift becomes a decision rather than a
// surprise.

import { readFile } from 'node:fs/promises';

const EXPECTED = {
  both: ['census', 'congress', 'fbi', 'fda', 'fdic', 'fec', 'fedreg', 'fema',
         'nasa', 'nih', 'nist', 'treasury', 'usaspending', 'usgs'],
  // Still one-sided: a Python module exists, the data API has no
  // implementation. Closing these is the other half of parity.
  flaskOnly: ['bls', 'doj', 'dot', 'epa', 'fcc', 'ftc', 'loc', 'nara', 'noaa', 'sam', 'sec'],
  apiOnly: [],
};

const sorted = (a) => [...a].sort();
const same = (a, b) => sorted(a).join(',') === sorted(b).join(',');

async function main() {
  const py = await readFile('webapp/app.py', 'utf8');
  const flask = [...py.matchAll(/'([a-z_0-9]+)':\s*'api\.agency_modules/g)].map((m) => m[1]);

  const js = await readFile('proxy/api.js', 'utf8');
  const registry = js.slice(js.indexOf('const REGISTRY'));
  const api = [...registry.matchAll(/^  ([a-z_0-9]+):\s*\{/gm)].map((m) => m[1]);

  if (!flask.length) throw new Error('parsed zero agencies from webapp/app.py');
  if (!api.length) throw new Error('parsed zero agencies from proxy/api.js REGISTRY');

  const f = new Set(flask);
  const a = new Set(api);
  const both = flask.filter((x) => a.has(x));
  const flaskOnly = flask.filter((x) => !a.has(x));
  const apiOnly = api.filter((x) => !f.has(x));

  const rows = [
    ['flask (webapp/app.py)', flask.length],
    ['data api (proxy/api.js)', api.length],
    ['in both', both.length],
    ['flask only', flaskOnly.length],
    ['data api only', apiOnly.length],
  ];
  for (const [k, v] of rows) process.stdout.write(`  ${k.padEnd(26)}${String(v).padStart(4)}\n`);

  const problems = [];
  for (const [name, got] of [['both', both], ['flaskOnly', flaskOnly], ['apiOnly', apiOnly]]) {
    if (!same(got, EXPECTED[name])) {
      const added = sorted(got).filter((x) => !EXPECTED[name].includes(x));
      const gone = EXPECTED[name].filter((x) => !got.includes(x));
      problems.push(`${name} changed:${added.length ? ` now also ${added.join(', ')}` : ''}` +
                    `${gone.length ? ` no longer ${gone.join(', ')}` : ''}`);
    }
  }

  if (problems.length) {
    process.stderr.write('\nagency coverage drifted:\n' + problems.map((p) => `  ${p}`).join('\n') +
      '\n\nEither implement it on both sides, or update EXPECTED in this file to\n' +
      'record the new split deliberately.\n');
    process.exit(1);
  }
  process.stdout.write('\nagency coverage matches EXPECTED\n');
}

main().catch((e) => { process.stderr.write(`parity check failed: ${e.message}\n`); process.exit(1); });
