// Exercises every subsection of the eleven agencies ported from the Flask
// backend, through the real build -> fetch -> parse path, against stubbed
// upstream payloads. No network.
//
//     node proxy/test-data-api.mjs
//
// The payload shapes are taken from the Python modules these were ported from,
// which is the only record of what each upstream actually returns. This proves
// the reshaping and the request construction for all 24 subsections; it
// cannot prove the upstream
// still answers that way.

const calls = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  calls.push({ url: u, init: init || {} });
  const body = payloadFor(u);
  if (body === undefined) throw new Error(`no stub for ${u}`);
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

function payloadFor(u) {
  if (u.includes('efts.sec.gov')) return { hits: { hits: [
    { _source: { display_names: ['Apple Inc. (AAPL) (CIK 0000320193)'], entity_name: 'Apple Inc.',
                 file_date: '2026-02-01', form_type: '8-K', entity_id: '0000320193',
                 file_description: 'Current report' } },
  ] } };
  if (u.includes('api.bls.gov')) return { Results: { series: [{ data: [
    { year: '2026', period: 'M01', periodName: 'January', value: '4.1' },
    { year: '2025', period: 'M13', periodName: 'Annual', value: '4.0' },
  ] }] } };
  if (u.includes('justice.gov') || u.includes('ftc.gov')) return { results: [
    { title: 'A press release', body: 'Body text', date: '2026-03-01', url: 'https://example.gov/a' },
  ] };
  if (u.includes('recallsByYear')) return { results: [
    { Manufacturer: 'Acme Motors', Subject: 'Brake failure', Summary: 'Brakes may fail.',
      ReportReceivedDate: '2026-01-15', Component: 'BRAKES', PotentialNumberofUnitsAffected: 1200 },
  ] };
  if (u.includes('nhtsa.gov/complaints')) return { results: [
    { make: 'toyota', model: 'camry', modelYear: '2024', summary: 'Engine stalls.', dateOfIncident: '2026-02-02' },
  ] };
  if (u.includes('WATER_SYSTEM')) return [
    { PWS_NAME: 'Springfield Water', STATE_CODE: 'IL', POPULATION_SERVED_COUNT: '30000', LAST_REPORTED_DATE: '2026-01-01' },
  ];
  if (u.includes('PCS_PERMIT_FACILITY')) return [
    { FACILITY_NAME: 'Acme Plant', NPDES: 'IL0001234', CITY: 'Springfield', STATE_CODE: 'IL' },
  ];
  if (u.includes('TRI_FACILITY')) return [
    { FACILITY_NAME: 'Acme Chem', PRIMARY_SIC: '2812', CITY_NAME: 'Springfield', STATE_ABBR: 'IL', REPORTING_YEAR: '2025' },
  ];
  if (u.includes('i5zz-k6uu')) return [{ applicant_name: 'Telco', service: 'Fixed', state: 'CA', date: '2026-01-05' }];
  if (u.includes('9k46-wbcq')) return [{ licensee_name: 'Radio Co', callsign: 'KX1', frequency_assigned: '101.1', radio_service_desc: 'FM', grant_date: '2026-01-06' }];
  if (u.includes('3xyp-aqkj')) return [{ issue: 'Robocall', method: 'Phone', status: 'Closed', date_of_issue: '2026-01-07' }];
  if (u.includes('loc.gov')) return { results: [
    { title: 'A map', description: ['A described map'], date: '1920', url: 'https://www.loc.gov/item/1' },
  ] };
  if (u.includes('catalog.archives.gov')) return { body: { hits: { hits: [
    { _id: '12345', _source: { title: 'A record', scopeAndContentNote: 'Notes',
                               inclusiveDates: { inclusiveStartDate: { year: 1944 } } } },
  ] } } };
  if (u.includes('api.weather.gov')) return { features: [
    { properties: { headline: 'Flood Warning', description: 'Water rising.', onset: '2026-03-01T00:00:00Z',
                    uri: 'https://alerts.weather.gov/x', severity: 'Severe', event: 'Flood', areaDesc: 'Cook, IL' } },
  ] };
  if (u.includes('api.sam.gov')) return { opportunitiesData: [
    { title: 'Widget procurement', description: 'Buying widgets.', postedDate: '2026-02-10',
      uiLink: 'https://sam.gov/opp/abc', type: 'Solicitation', department: 'GSA', naicsCode: '334111' },
  ] };
  return undefined;
}

const { fetchNormalized, listAgencies, sourceNeedsKey } = await import(new URL('./api.js', import.meta.url));

let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ' :: ' + extra}`);
  if (!cond) fail++;
};
const last = () => calls[calls.length - 1];

// Every subsection must build a request, fetch, and parse into normalized rows.
const SUBS = {
  sec: ['filings', 'company_search'],
  bls: ['unemployment', 'cpi', 'employment', 'avg_hourly_earnings'],
  doj: ['press_releases', 'blog_posts', 'speeches', 'news'],
  ftc: ['press_releases', 'cases'],
  dot: ['recalls', 'complaints'],
  epa: ['water_systems', 'facilities', 'toxic_releases'],
  fcc: ['broadband', 'spectrum', 'complaints'],
  loc: ['collections'],
  nara: ['records'],
  noaa: ['alerts'],
  sam: ['opportunities'],
};

let total = 0;
for (const [agency, subs] of Object.entries(SUBS)) {
  for (const sub of subs) {
    total++;
    const rows = await fetchNormalized(agency, sub, { q: agency === 'sec' ? '8-K' : 'test', apiKey: 'k' });
    const r = rows[0] || {};
    const ok = rows.length > 0
      && typeof r.title === 'string' && r.title.length > 0
      && 'description' in r && 'date' in r && 'link' in r;
    check(`${agency}/${sub} returns normalized rows`, ok, JSON.stringify(r).slice(0, 120));
  }
}
check(`all ${total} subsections exercised`, total === 24, String(total));

// --- the details that are easy to get wrong -------------------------------
await fetchNormalized('sec', 'filings', { q: '8-K' });
check('SEC declares a contact address to EDGAR',
  /contact@opengov\.dev/.test(last().init.headers['User-Agent'] || ''), last().init.headers['User-Agent']);

await fetchNormalized('bls', 'unemployment', {});
check('BLS uses POST', last().init.method === 'POST');
check('  with the series in a JSON body', JSON.parse(last().init.body).seriesid[0] === 'LNS14000000', last().init.body);
check('  and a json content-type', (last().init.headers['Content-Type'] || '').includes('application/json'));

const bls = await fetchNormalized('bls', 'unemployment', {});
check('BLS dates a month to its first day', bls[0].date === '2026-01-01', bls[0].date);
check('BLS dates the M13 annual average to year end', bls[1].date === '2025-12-31', bls[1].date);

await fetchNormalized('sam', 'opportunities', { apiKey: 'k', from: '2025-01-01', to: '2025-12-31' });
check('SAM sends MM/DD/YYYY dates',
  /postedFrom=01%2F01%2F2025/.test(last().url) && /postedTo=12%2F31%2F2025/.test(last().url), last().url);
check('SAM is marked as needing a caller key', sourceNeedsKey('sam') === true);
check('  and the keyless agencies are not', !sourceNeedsKey('epa') && !sourceNeedsKey('noaa'));

await fetchNormalized('dot', 'recalls', { q: '2024' });
check('DOT recalls honour a year in q', last().url.includes('year=2024'), last().url);
await fetchNormalized('dot', 'recalls', { q: 'garbage' });
check('  and ignore a non-year', /year=\d{4}/.test(last().url) && !last().url.includes('garbage'), last().url);

const loc = await fetchNormalized('loc', 'collections', { q: 'maps' });
check('LOC flattens an array description', loc[0].description === 'A described map', loc[0].description);

const nara = await fetchNormalized('nara', 'records', { q: 'x' });
check('NARA reads the nested hit shape', nara[0].date === '1944' && nara[0].link.endsWith('/12345'), JSON.stringify(nara[0]));

// --- upstreams that answer with the wrong shape ---------------------------
const realPayload = payloadFor;
globalThis.fetch = async (url) => new Response(JSON.stringify({ error: 'rate limited' }),
  { status: 200, headers: { 'Content-Type': 'application/json' } });
for (const [agency, sub] of [['epa', 'water_systems'], ['fcc', 'broadband'], ['doj', 'news'], ['nara', 'records'], ['noaa', 'alerts'], ['sec', 'filings']]) {
  let threw = null, rows = null;
  try { rows = await fetchNormalized(agency, sub, { q: 'x' }); } catch (e) { threw = e; }
  check(`${agency}/${sub} survives an object where rows were expected`, !threw && Array.isArray(rows) && rows.length === 0,
    threw ? threw.message : JSON.stringify(rows));
}

// --- discovery still describes everything ---------------------------------
const docs = listAgencies();
check('discovery lists 25 agencies', docs.length === 25, String(docs.length));
const newOnes = docs.filter((a) => ['sec', 'bls', 'doj', 'dot', 'epa', 'fcc', 'ftc', 'loc', 'nara', 'noaa', 'sam'].includes(a.id));
check('  including all eleven new ones', newOnes.length === 11, String(newOnes.length));
check('  each with a described subsection', newOnes.every((a) => a.subsections.length > 0 && a.subsections.every((s) => s.description)));
check('  and SEC company_search marked as needing a query',
  docs.find((a) => a.id === 'sec').subsections.find((s) => s.id === 'company_search').requires_query === true);

console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
