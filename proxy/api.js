// OpenGovDash — Normalized Data API (v1)
// ---------------------------------------------------------------------------
// A public, machine-readable API that lets *other* apps pull the same
// normalized government data the OpenGovDash UI shows. It runs inside the
// existing Cloudflare Worker and reuses the same upstreams the browser uses,
// but does the fetch + normalization server-side and returns a stable JSON
// (or CSV) envelope.
//
// Design goals:
//   * Stable, documented shape:  { ok, agency, subsection, count, results, ... }
//   * Every record carries the OpenGovDash normal form: {title, description,
//     date, link, ...rich fields}. Same contract as the UI's DIRECT_API.
//   * No baked-in secrets. Agencies that need an api.data.gov key expect the
//     *caller* to supply their own (?api_key= or X-Api-Key). The site's key is
//     never spent on behalf of anonymous callers.
//   * Edge-cached (Cloudflare Cache API) so repeated pulls are cheap/fast.
//   * Self-describing: GET /api/v1/agencies and /api/v1/openapi.json.
//
// Wire-up: worker.js routes any /api/v1* path here (see handleDataApi).
// ---------------------------------------------------------------------------

const API_VERSION = 'v1';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const CACHE_TTL_SECONDS = 300; // edge cache per normalized request

// ---- CORS (public read API: any origin may read public gov data) ----------
const API_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, X-Api-Key',
  'Access-Control-Max-Age': '86400',
};

function apiJson(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...API_CORS, ...extra },
  });
}

// ---- small helpers ---------------------------------------------------------
const num = (v) => (typeof v === 'number' ? v.toLocaleString() : v);
const clampLimit = (v) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
};
const cut = (s, n = 300) => String(s == null ? '' : s).slice(0, n);
const jget = async (url, init) => {
  const r = await fetch(url, init);
  if (!r.ok) { const e = new Error(`upstream ${r.status}`); e.status = r.status; e.upstreamBody = await r.text().catch(() => ''); throw e; }
  return r.json();
};

// FBI Crime Data Explorer helpers: month-scoped ranges (MM-YYYY) + time-series flattening.
const CDE = 'https://api.usa.gov/crime/fbi/cde';
const cdeMonthRange = (from, to) => {
  const y = new Date().getFullYear();
  const fy = from ? from.slice(0, 4) : String(y - 6);
  const ty = to ? to.slice(0, 4) : String(y - 1);
  return [`01-${fy}`, `12-${ty}`];
};
const flattenCde = (seriesObj, label, link, limit) => {
  const s = (seriesObj && (seriesObj[label] || seriesObj[Object.keys(seriesObj || {})[0]])) || {};
  return Object.entries(s).filter(([, v]) => v != null).map(([period, value]) => {
    const mm = /^\d{2}-\d{4}$/.test(period);
    const iso = mm ? `${period.slice(3)}-${period.slice(0, 2)}-01` : `${period}-12-31`;
    return { title: `${label}: ${typeof value === 'number' ? value.toLocaleString() : value}`, description: `Period ${period}`, date: iso, link, period, value };
  }).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, limit);
};

// Browser-ish UA + Referer, same reasoning as the /p relay (some upstreams
// block generic/datacenter UAs).
const UPSTREAM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 OpenGovDash/1.0',
  'Referer': 'https://selvidge.tech/government-data-fun/',
  'Accept': 'application/json',
};

// EDGAR refuses any request whose User-Agent carries no contact address, so it
// cannot use UPSTREAM_HEADERS. Same address the index builders declare; see
// docs/XREF_INDEX.md.
const EDGAR_HEADERS = {
  'User-Agent': 'OpenGovDash XrefIndex/1.0 (contact@opengov.dev)',
  'Accept': 'application/json',
};

// ===========================================================================
// REGISTRY  — one entry per agency; each subsection has build() + parse().
//   build(ctx) -> { url, method?, body?, headers? }   ctx = {q, limit, from, to, apiKey}
//   parse(json, ctx) -> array of normalized records
// keyRequired: 'datagov' means the caller must pass ?api_key= (their own).
// ===========================================================================
const REGISTRY = {

  // ----- USGS earthquakes (no key) -----
  usgs: {
    label: 'U.S. Geological Survey',
    attribution: 'U.S. Geological Survey (public domain)',
    subsections: {
      earthquakes: {
        desc: 'Recent earthquakes, M2.5+, newest first',
        build: ({ limit, from, to }) => {
          let u = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&limit=${limit}&minmagnitude=2.5&orderby=time`;
          if (from) u += `&starttime=${from}`;
          if (to) u += `&endtime=${to}`;
          return { url: u };
        },
        parse: (d) => (d.features || []).map((f) => {
          const p = f.properties || {};
          return {
            title: `M${p.mag ?? '?'} — ${p.place || 'Unknown location'}`,
            description: `${p.type || 'earthquake'} · ${p.status || ''}${p.tsunami ? ' · TSUNAMI' : ''}`.trim(),
            date: p.time ? new Date(p.time).toISOString() : '',
            link: p.url || '',
            magnitude: p.mag, place: p.place,
            felt: p.felt, tsunami: p.tsunami,
            coordinates: f.geometry?.coordinates || null,
          };
        }),
      },
    },
  },

  // ----- FDA openFDA (no key required; caller key optional for higher limits) -----
  fda: {
    label: 'U.S. Food & Drug Administration (openFDA)',
    attribution: 'U.S. Food & Drug Administration, openFDA',
    subsections: {
      drug_events: {
        desc: 'Adverse drug event reports (FAERS)',
        build: ({ q, limit, apiKey }) => {
          let u = `https://api.fda.gov/drug/event.json?limit=${limit}&sort=receivedate:desc`;
          if (q) u += `&search=patient.drug.medicinalproduct:"${encodeURIComponent(q)}"`;
          if (apiKey) u += `&api_key=${encodeURIComponent(apiKey)}`;
          return { url: u };
        },
        parse: (d) => (d.results || []).map((x) => {
          const drugs = x.patient?.drug || [{}];
          const reactions = x.patient?.reaction || [{}];
          return {
            title: drugs[0]?.medicinalproduct || 'Unknown',
            description: reactions.map((r) => r.reactionmeddrapt).filter(Boolean).slice(0, 3).join(', '),
            date: x.receivedate || '',
            link: `https://api.fda.gov/drug/event.json?search=safetyreportid:${x.safetyreportid || ''}`,
            serious: x.serious || '',
          };
        }),
      },
      drug_recalls: recallSub('drug/enforcement.json'),
      device_recalls: recallSub('device/enforcement.json'),
      food_recalls: recallSub('food/enforcement.json'),
      device_510k: {
        desc: '510(k) medical-device clearances',
        build: ({ q, limit, apiKey }) => {
          let u = `https://api.fda.gov/device/510k.json?limit=${limit}&sort=decision_date:desc`;
          if (q) u += `&search=device_name:"${encodeURIComponent(q)}"`;
          if (apiKey) u += `&api_key=${encodeURIComponent(apiKey)}`;
          return { url: u };
        },
        parse: (d) => (d.results || []).map((x) => ({
          title: x.device_name || '',
          description: `Applicant: ${x.applicant || ''} · Product code: ${x.product_code || ''}`,
          date: x.decision_date || '',
          link: `https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfpmn/pmn.cfm?ID=${x.k_number || ''}`,
          k_number: x.k_number || '', decision: x.decision_description || '',
        })),
      },
    },
  },

  // ----- Treasury Fiscal Data (no key) — daily_statements path FIXED -----
  treasury: {
    label: 'U.S. Department of the Treasury (Fiscal Data)',
    attribution: 'U.S. Treasury, Fiscal Data (public domain)',
    subsections: {
      national_debt: treasurySub('v2/accounting/od/debt_to_penny', (x) => ({
        title: 'Total public debt outstanding',
        description: `$${num(Number(x.tot_pub_debt_out_amt || 0))}`,
        value: x.tot_pub_debt_out_amt,
      })),
      // FIXED: dts_table_1 now 404s; the live DTS dataset is operating_cash_balance.
      daily_statements: treasurySub('v1/accounting/dts/operating_cash_balance', (x) => ({
        title: x.account_type || 'Treasury operating cash balance',
        description: `Close balance: $${num(Number(x.close_today_bal || 0))} (millions)`,
        account_type: x.account_type, close_today_bal: x.close_today_bal,
      })),
      interest_rates: treasurySub('v2/accounting/od/avg_interest_rates', (x) => ({
        title: x.security_desc || 'Average interest rate',
        description: `${x.security_type_desc || ''} · ${x.avg_interest_rate_amt || ''}%`,
        rate: x.avg_interest_rate_amt,
      })),
      exchange_rates: treasurySub('v1/accounting/od/rates_of_exchange', (x) => ({
        title: x.country_currency_desc || 'Exchange rate',
        description: `Rate: ${x.exchange_rate || ''}`,
        exchange_rate: x.exchange_rate,
      })),
    },
  },

  // ----- NIST NVD CVEs (no key; caller key optional) -----
  nist: {
    label: 'NIST National Vulnerability Database',
    attribution: 'NIST National Vulnerability Database',
    subsections: {
      cve: {
        desc: 'Recently published CVEs (last 60 days if no query/date)',
        build: ({ q, limit, from, to }) => {
          let u = `https://services.nvd.nist.gov/rest/json/cves/2.0?resultsPerPage=${limit}`;
          if (from) u += `&pubStartDate=${from}T00:00:00.000`;
          else if (!q) { const s = new Date(Date.now() - 60 * 864e5).toISOString().split('T')[0]; u += `&pubStartDate=${s}T00:00:00.000`; }
          if (to) u += `&pubEndDate=${to}T23:59:59.999`;
          else if (!q && !from) u += `&pubEndDate=${new Date().toISOString().split('T')[0]}T23:59:59.999`;
          if (q) u += `&keywordSearch=${encodeURIComponent(q)}`;
          return { url: u };
        },
        parse: (d) => (d.vulnerabilities || []).map((v) => {
          const c = v.cve || {};
          const desc = (c.descriptions || []).find((x) => x.lang === 'en')?.value || '';
          const m = c.metrics || {};
          const cvss = m.cvssMetricV31?.[0]?.cvssData || m.cvssMetricV30?.[0]?.cvssData || m.cvssMetricV2?.[0]?.cvssData || {};
          return {
            title: c.id || '',
            description: cut(desc),
            date: c.published || '',
            link: `https://nvd.nist.gov/vuln/detail/${c.id || ''}`,
            cvss_score: cvss.baseScore ?? '', severity: cvss.baseSeverity || '',
            status: c.vulnStatus || '',
          };
        }).sort((a, b) => String(b.date).localeCompare(String(a.date))),
      },
    },
  },

  // ----- Federal Register (no key) -----
  fedreg: {
    label: 'Federal Register',
    attribution: 'Office of the Federal Register / GPO (public domain)',
    subsections: {
      documents: fedregSub(false),
      executive_orders: fedregSub(true),
    },
  },

  // ----- USAspending (no key) — award_search FIXED (award_type_codes required) -----
  usaspending: {
    label: 'USAspending.gov',
    attribution: 'USAspending.gov (public domain)',
    subsections: {
      top_agencies: {
        desc: 'Top-tier agencies by budget authority',
        build: () => ({ url: 'https://api.usaspending.gov/api/v2/references/toptier_agencies/' }),
        parse: (d, { q, limit }) => {
          let rows = (d.results || []).map((x) => ({
            title: x.agency_name || '',
            description: `Budget: $${num(x.budget_authority_amount || 0)} · Obligated: $${num(x.obligated_amount || 0)}`,
            date: x.active_fy ? `FY${x.active_fy}` : '',
            link: `https://www.usaspending.gov/agency/${x.agency_slug || ''}`,
            budget_authority: x.budget_authority_amount, obligated: x.obligated_amount,
            abbreviation: x.abbreviation || '',
          }));
          if (q) { const s = q.toLowerCase(); rows = rows.filter((x) => (x.title + x.abbreviation).toLowerCase().includes(s)); }
          return rows.slice(0, limit);
        },
      },
      award_search: {
        desc: 'Contract/grant award search (requires a keyword)',
        build: ({ q, limit, from, to }) => ({
          url: 'https://api.usaspending.gov/api/v2/search/spending_by_award/',
          method: 'POST',
          body: {
            filters: {
              keywords: [q || ''],
              time_period: [{ start_date: from || '2024-01-01', end_date: to || '2026-12-31' }],
              // FIXED: this endpoint 422s without award_type_codes. A/B/C/D = contracts.
              award_type_codes: ['A', 'B', 'C', 'D'],
            },
            fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Description', 'Start Date', 'Awarding Agency'],
            limit, page: 1, sort: 'Award Amount', order: 'desc',
          },
        }),
        parse: (d) => (d.results || []).map((x) => ({
          title: x['Recipient Name'] || 'Unknown',
          description: `Award ${x['Award ID'] || ''} · ${cut(x.Description, 150)}`,
          date: x['Start Date'] || '',
          link: `https://www.usaspending.gov/award/${x.internal_id || ''}`,
          amount: x['Award Amount'], awarding_agency: x['Awarding Agency'] || '',
        })),
        requiresQuery: true,
      },
    },
  },

  // ----- FDIC BankFind (no key) -----
  fdic: {
    label: 'FDIC BankFind',
    attribution: 'Federal Deposit Insurance Corporation',
    subsections: {
      institutions: {
        desc: 'Largest active insured institutions by assets',
        build: ({ limit }) => ({ url: `https://banks.data.fdic.gov/api/institutions?limit=${limit}&sort_by=ASSET&sort_order=DESC&filters=ACTIVE%3A1` }),
        parse: (d) => (d.data || []).map(({ data: f = {} }) => ({
          title: f.NAME || f.INSTNAME || 'Unknown institution',
          description: `${f.CITY || ''}, ${f.STALP || f.STNAME || ''} · Assets: $${num(f.ASSET || 0)}K`,
          date: f.REPDTE || '',
          link: f.CERT ? `https://banks.data.fdic.gov/bankfind-suite/bankfind/details/${f.CERT}` : 'https://banks.data.fdic.gov/',
          cert: f.CERT, assets_thousands: f.ASSET,
        })),
      },
      failures: {
        desc: 'Bank failures, newest first',
        build: ({ limit }) => ({ url: `https://banks.data.fdic.gov/api/failures?limit=${limit}&sort_by=FAILDATE&sort_order=DESC` }),
        parse: (d) => (d.data || []).map(({ data: f = {} }) => ({
          title: f.NAME || 'Unknown bank',
          description: `${f.CITYST || ''} · Deposits: $${num(f.QBFDEP || 0)}K${f.BIDNAME ? ` · Acquired by ${f.BIDNAME}` : ''}`,
          date: f.FAILDATE || '',
          link: f.CERT ? `https://banks.data.fdic.gov/bankfind-suite/bankfind/details/${f.CERT}` : 'https://banks.data.fdic.gov/',
          cert: f.CERT, cost_to_fdic_thousands: f.COST, acquirer: f.BIDNAME || '',
        })),
      },
    },
  },

  // ----- FEMA OpenFEMA (no key) -----
  fema: {
    label: 'FEMA OpenFEMA',
    attribution: 'Federal Emergency Management Agency (public domain)',
    subsections: {
      disasters: {
        desc: 'Disaster declarations, newest first',
        build: ({ q, limit }) => {
          const p = new URLSearchParams({ $top: String(limit), $orderby: 'declarationDate desc' });
          if (q) p.set('$filter', `contains(declarationTitle, '${q.replace(/'/g, "''")}') or contains(state, '${q.replace(/'/g, "''")}')`);
          return { url: `https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?${p}` };
        },
        parse: (d) => (d.DisasterDeclarationsSummaries || []).map((x) => ({
          title: x.declarationTitle || `DR-${x.disasterNumber}`,
          description: [x.state && `State: ${x.state}`, x.incidentType && `Type: ${x.incidentType}`, x.designatedArea && `Area: ${x.designatedArea}`].filter(Boolean).join(' · '),
          date: x.declarationDate || '',
          link: x.disasterNumber ? `https://www.fema.gov/disaster/${x.disasterNumber}` : 'https://www.fema.gov/openfema',
          disaster_number: x.disasterNumber, state: x.state, incident_type: x.incidentType,
        })),
      },
    },
  },

  // ----- Census ACS 1-year (no key for modest pulls) -----
  census: {
    label: 'U.S. Census Bureau (ACS)',
    attribution: 'U.S. Census Bureau, American Community Survey',
    subsections: {
      population: {
        desc: 'Population by state (ACS 1-year 2023)',
        build: ({ limit }) => ({ url: `https://api.census.gov/data/2023/acs/acs1?get=NAME,B01003_001E&for=state:*` }),
        parse: (rows, { q, limit }) => {
          if (!Array.isArray(rows) || rows.length < 2) return [];
          let out = rows.slice(1).map((r) => ({
            title: r[0],
            description: `Population (ACS 2023): ${num(parseInt(r[1], 10))}`,
            date: '2023-12-31',
            link: `https://data.census.gov/profile?g=040XX00US${r[2]}`,
            population: parseInt(r[1], 10), state_fips: r[2],
          })).sort((a, b) => b.population - a.population);
          if (q) { const s = q.toLowerCase(); out = out.filter((x) => x.title.toLowerCase().includes(s)); }
          return out.slice(0, limit);
        },
      },
    },
  },

  // ----- NIH: PubMed (two-step) + ClinicalTrials (no key) -----
  nih: {
    label: 'National Institutes of Health',
    attribution: 'NIH / NLM (PubMed, ClinicalTrials.gov)',
    subsections: {
      pubmed: {
        desc: 'PubMed literature search, newest first',
        twoStep: true, // handled specially in runQuery
        parse: () => [],
      },
      clinical_trials: {
        desc: 'ClinicalTrials.gov studies',
        build: ({ q, limit }) => {
          let u = `https://clinicaltrials.gov/api/v2/studies?pageSize=${limit}&sort=LastUpdatePostDate:desc`;
          if (q) u += `&query.term=${encodeURIComponent(q)}`;
          return { url: u };
        },
        parse: (d) => (d.studies || []).map((s) => {
          const id = s.protocolSection?.identificationModule || {};
          return {
            title: id.briefTitle || '',
            description: cut(s.protocolSection?.descriptionModule?.briefSummary),
            date: s.protocolSection?.statusModule?.lastUpdateSubmitDate || '',
            link: `https://clinicaltrials.gov/study/${id.nctId || ''}`,
            status: s.protocolSection?.statusModule?.overallStatus || '', nct_id: id.nctId || '',
          };
        }),
      },
    },
  },

  // ===== Caller-key agencies (api.data.gov key required from the CALLER) =====

  nasa: {
    label: 'NASA',
    attribution: 'NASA',
    keyRequired: 'datagov',
    subsections: {
      apod: {
        desc: 'Astronomy Picture of the Day (most recent N)',
        build: ({ limit, apiKey }) => ({ url: `https://api.nasa.gov/planetary/apod?api_key=${encodeURIComponent(apiKey)}&count=${Math.min(limit, 50)}&thumbs=true` }),
        parse: (d) => (Array.isArray(d) ? d : [d]).map((x) => ({
          title: x.title || '',
          description: cut(x.explanation),
          date: x.date || '',
          link: x.media_type === 'video' ? (x.url || '') : (x.hdurl || x.url || ''),
          media_type: x.media_type || 'image',
        })),
      },
    },
  },

  congress: {
    label: 'Congress.gov',
    attribution: 'Library of Congress / Congress.gov',
    keyRequired: 'datagov',
    subsections: {
      bills: {
        desc: 'Recent bills in the current Congress',
        build: ({ q, limit, apiKey }) => {
          const congress = 119 + Math.max(0, Math.floor((new Date().getFullYear() - 2025) / 2));
          const p = new URLSearchParams({ api_key: apiKey, limit: String(limit), format: 'json', sort: 'updateDate+desc' });
          if (q) p.set('q', q);
          return { url: `https://api.congress.gov/v3/bill/${congress}?${p}` };
        },
        parse: (d) => (d.bills || []).map((x) => {
          const type = String(x.type || '').toLowerCase();
          return {
            title: x.title || `${x.type} ${x.number}`,
            description: cut(x.latestAction?.text || ''),
            date: x.latestAction?.actionDate || x.updateDate || '',
            link: `https://www.congress.gov/bill/${x.congress}th-congress/${type}-bill/${x.number}`,
            bill_number: x.number, bill_type: x.type, congress: x.congress,
          };
        }),
      },
    },
  },

  fec: {
    label: 'Federal Election Commission (openFEC)',
    attribution: 'Federal Election Commission',
    keyRequired: 'datagov',
    subsections: {
      candidates: {
        desc: 'Candidates for the 2024 cycle',
        // FIXED: the UI's sort=-total_receipts 422s; that field is not sortable on this endpoint.
        build: ({ limit, apiKey }) => ({ url: `https://api.open.fec.gov/v1/candidates/?api_key=${encodeURIComponent(apiKey)}&per_page=${limit}&election_year=2024&sort=-first_file_date` }),
        parse: (d) => (d.results || []).map((x) => ({
          title: x.name || '',
          description: `${x.party_full || ''} · ${x.office_full || ''} · ${x.state || ''}`,
          date: (x.election_years || [])[0] ? `Cycle ${(x.election_years || [])[0]}` : '',
          link: `https://www.fec.gov/data/candidate/${x.candidate_id || ''}/`,
          candidate_id: x.candidate_id, party: x.party_full || '',
        })),
      },
      filings: {
        desc: 'Recent committee filings',
        build: ({ limit, apiKey }) => ({ url: `https://api.open.fec.gov/v1/filings/?api_key=${encodeURIComponent(apiKey)}&per_page=${limit}&sort=-receipt_date` }),
        parse: (d) => (d.results || []).map((x) => ({
          title: x.committee_name || '',
          description: `Form ${x.form_type || ''} · Receipts: $${num(x.total_receipts || 0)}`,
          date: x.receipt_date || '',
          link: `https://www.fec.gov/data/committee/${x.committee_id || ''}/`,
        })),
      },
    },
  },

  // ----- FBI Crime Data Explorer (caller api.data.gov key) -----
  fbi: {
    label: 'FBI Crime Data Explorer',
    attribution: 'FBI Uniform Crime Reporting (UCR) program',
    keyRequired: 'datagov',
    subsections: {
      crime: {
        desc: 'National crime rate trends by offense (e.g. violent-crime, aggravated-assault)',
        build: ({ q, apiKey, from, to }) => {
          const [f, t] = cdeMonthRange(from, to);
          const offense = (q || '').trim() || 'violent-crime';
          return { url: `${CDE}/summarized/state/national/${encodeURIComponent(offense)}?from=${f}&to=${t}&API_KEY=${encodeURIComponent(apiKey)}` };
        },
        parse: (d, { limit }) => flattenCde(d.offenses && d.offenses.rates, 'United States Offenses', 'https://cde.ucr.cjis.gov/LATEST/webapp/#/pages/explorer/crime/crime-trend', limit),
      },
      arrests: {
        desc: 'National arrest rates by offense (default "all")',
        build: ({ q, apiKey, from, to }) => {
          const [f, t] = cdeMonthRange(from, to);
          const offense = (q || '').trim() || 'all';
          return { url: `${CDE}/arrest/national/${encodeURIComponent(offense)}?type=counts&from=${f}&to=${t}&API_KEY=${encodeURIComponent(apiKey)}` };
        },
        parse: (d, { limit }) => flattenCde(d.rates, 'United States Arrests', 'https://cde.ucr.cjis.gov/LATEST/webapp/#/pages/explorer/crime/arrest', limit),
      },
      agencies: {
        desc: 'Law-enforcement agencies in a state (q = 2-letter state abbr, e.g. CA)',
        requiresQuery: true,
        build: ({ q, apiKey }) => ({ url: `${CDE}/agency/byStateAbbr/${encodeURIComponent((q || '').trim().toUpperCase())}?API_KEY=${encodeURIComponent(apiKey)}` }),
        parse: (d, { limit }) => {
          let out = [];
          for (const list of Object.values(d || {})) if (Array.isArray(list)) out = out.concat(list);
          return out.slice(0, limit).map((a) => ({
            title: a.agency_name || a.ori || 'Unnamed agency',
            description: [a.agency_type_name, a.counties, a.state_name].filter(Boolean).join(' · '),
            date: a.nibrs_start_date || '',
            link: a.ori ? `https://cde.ucr.cjis.gov/LATEST/webapp/#/pages/agency-details?id=${a.ori}` : 'https://cde.ucr.cjis.gov/',
            ori: a.ori || '', agency_type: a.agency_type_name || '', state: a.state_name || '',
          }));
        },
      },
    },
  },

  // =========================================================================
  // Ported from the Flask backend (webapp/api/agency_modules/*.py), which
  // implemented these eleven while the data API did not. Same upstreams, same
  // endpoints; the output is reshaped into this file's normal form.
  // tools/test-agency-parity.mjs fails if the two lists drift apart again.
  // =========================================================================

  // ----- SEC EDGAR full-text search (no key, but a contact UA is required) ---
  sec: {
    label: 'Securities and Exchange Commission (EDGAR)',
    attribution: 'U.S. Securities and Exchange Commission (public domain)',
    subsections: {
      filings: {
        desc: 'Recent filings by form type; q is the form, e.g. 8-K, 10-K, 13F-HR',
        build: ({ q, limit }) => {
          const form = (q || '').trim() || '8-K';
          const p = new URLSearchParams({ q: `"${form}"`, forms: form, from: '0', size: String(limit) });
          return { url: `https://efts.sec.gov/LATEST/search-index?${p}`, headers: EDGAR_HEADERS };
        },
        parse: (d, { q }) => edgarHits(d, (q || '').trim() || '8-K'),
      },
      company_search: {
        desc: 'Filings mentioning a company name or CIK',
        requiresQuery: true,
        build: ({ q, limit }) => {
          const p = new URLSearchParams({ q: `"${q}"`, from: '0', size: String(limit) });
          return { url: `https://efts.sec.gov/LATEST/search-index?${p}`, headers: EDGAR_HEADERS };
        },
        parse: (d) => edgarHits(d, ''),
      },
    },
  },

  // ----- Bureau of Labor Statistics (no key for v2 at low volume) -----------
  // The only POST upstream here: the series list travels in a JSON body.
  bls: {
    label: 'Bureau of Labor Statistics',
    attribution: 'U.S. Bureau of Labor Statistics (public domain)',
    subsections: {
      unemployment: blsSub('LNS14000000', 'Unemployment Rate'),
      cpi: blsSub('CUUR0000SA0', 'Consumer Price Index (All Urban)'),
      employment: blsSub('CES0000000001', 'Total Nonfarm Employment'),
      avg_hourly_earnings: blsSub('CES0500000003', 'Average Hourly Earnings'),
    },
  },

  // ----- Department of Justice (no key) ------------------------------------
  doj: {
    label: 'Department of Justice',
    attribution: 'U.S. Department of Justice (public domain)',
    subsections: {
      press_releases: drupalSub('https://www.justice.gov/api/v1', 'press_releases', 'DOJ press releases'),
      blog_posts: drupalSub('https://www.justice.gov/api/v1', 'blog_posts', 'DOJ blog posts'),
      speeches: drupalSub('https://www.justice.gov/api/v1', 'speeches', 'DOJ speeches'),
      news: drupalSub('https://www.justice.gov/api/v1', 'news', 'DOJ news'),
    },
  },

  // ----- Federal Trade Commission (no key) ---------------------------------
  ftc: {
    label: 'Federal Trade Commission',
    attribution: 'U.S. Federal Trade Commission (public domain)',
    subsections: {
      press_releases: drupalSub('https://www.ftc.gov/api/v1', 'press_releases', 'FTC press releases'),
      cases: drupalSub('https://www.ftc.gov/api/v1', 'cases', 'FTC enforcement cases'),
    },
  },

  // ----- NHTSA, standing in for DOT (no key) -------------------------------
  dot: {
    label: 'Department of Transportation (NHTSA)',
    attribution: 'National Highway Traffic Safety Administration (public domain)',
    subsections: {
      recalls: {
        desc: 'Vehicle safety recalls for a year; q is the year, default last year',
        build: ({ q }) => {
          const year = /^\d{4}$/.test(String(q || '').trim())
            ? String(q).trim()
            : String(new Date().getFullYear() - 1);
          return { url: `https://api.nhtsa.gov/recalls/recallsByYear?year=${year}` };
        },
        parse: (d) => (d.results || []).map((r) => ({
          title: [r.Manufacturer, r.Subject].filter(Boolean).join(' — ') || 'Recall',
          description: cut(r.Summary || ''),
          date: r.ReportReceivedDate || '',
          link: 'https://www.nhtsa.gov/recalls',
          component: r.Component || '',
          units_affected: r.PotentialNumberofUnitsAffected || '',
        })),
      },
      complaints: {
        desc: 'Safety complaints for a vehicle; q is "make model", e.g. "toyota camry"',
        build: ({ q }) => {
          const [make = 'toyota', model = 'camry'] = String(q || '').trim().split(/\s+/);
          const p = new URLSearchParams({ make, model });
          return { url: `https://api.nhtsa.gov/complaints?${p}` };
        },
        parse: (d) => (d.results || []).map((r) => ({
          title: [r.make, r.model, r.modelYear && `(${r.modelYear})`].filter(Boolean).join(' '),
          description: cut(r.summary || ''),
          date: r.dateOfIncident || '',
          link: 'https://www.nhtsa.gov/complaints',
        })),
      },
    },
  },

  // ----- EPA Envirofacts (no key) ------------------------------------------
  epa: {
    label: 'Environmental Protection Agency (Envirofacts)',
    attribution: 'U.S. Environmental Protection Agency (public domain)',
    subsections: {
      water_systems: {
        desc: 'Public water systems',
        build: ({ limit }) => ({ url: efservice('WATER_SYSTEM', limit) }),
        parse: (rows) => asArray(rows).map((r) => ({
          title: r.PWS_NAME || r.WATER_SYSTEM_NAME || 'Unknown system',
          description: [r.STATE_CODE && `State: ${r.STATE_CODE}`,
            r.POPULATION_SERVED_COUNT && `Population served: ${num(Number(r.POPULATION_SERVED_COUNT))}`]
            .filter(Boolean).join(' · '),
          date: r.LAST_REPORTED_DATE || '',
          link: 'https://echo.epa.gov/',
          state: r.STATE_CODE || '',
        })),
      },
      facilities: {
        desc: 'Permitted discharge facilities',
        build: ({ limit }) => ({ url: efservice('PCS_PERMIT_FACILITY', limit) }),
        parse: (rows) => asArray(rows).map((r) => ({
          title: r.FACILITY_NAME || 'Unknown facility',
          description: [r.NPDES && `Permit: ${r.NPDES}`, r.CITY, r.STATE_CODE].filter(Boolean).join(' · '),
          date: '',
          link: r.NPDES ? `https://echo.epa.gov/detailed-facility-report?fid=${r.NPDES}` : 'https://echo.epa.gov/',
          permit: r.NPDES || '', state: r.STATE_CODE || '',
        })),
      },
      toxic_releases: {
        desc: 'Toxic Release Inventory facilities',
        build: ({ limit }) => ({ url: efservice('TRI_FACILITY', limit) }),
        parse: (rows) => asArray(rows).map((r) => ({
          title: r.FACILITY_NAME || 'Unknown facility',
          description: [r.PRIMARY_SIC && `Industry: ${r.PRIMARY_SIC}`,
            [r.CITY_NAME, r.STATE_ABBR].filter(Boolean).join(', ')].filter(Boolean).join(' · '),
          date: r.REPORTING_YEAR ? `${r.REPORTING_YEAR}-12-31` : '',
          link: 'https://enviro.epa.gov/triexplorer/',
          reporting_year: r.REPORTING_YEAR || '',
        })),
      },
    },
  },

  // ----- FCC open data, Socrata (no key) -----------------------------------
  fcc: {
    label: 'Federal Communications Commission',
    attribution: 'U.S. Federal Communications Commission (public domain)',
    subsections: {
      broadband: {
        desc: 'Broadband deployment filings',
        build: ({ limit }) => ({ url: socrata('i5zz-k6uu', limit) }),
        parse: (rows) => asArray(rows).map((r) => ({
          title: r.applicant_name || r.entity_name || 'Unknown',
          description: [r.service && `Service: ${r.service}`, r.state && `State: ${r.state}`].filter(Boolean).join(' · '),
          date: r.date || r.filing_date || '',
          link: 'https://broadbandmap.fcc.gov/',
          state: r.state || '',
        })),
      },
      spectrum: {
        desc: 'Spectrum licence grants',
        build: ({ limit }) => ({ url: socrata('9k46-wbcq', limit) }),
        parse: (rows) => asArray(rows).map((r) => ({
          title: r.licensee_name || r.entity_name || 'Unknown licensee',
          description: [r.callsign && `Callsign: ${r.callsign}`,
            r.frequency_assigned && `Frequency: ${r.frequency_assigned}`,
            r.radio_service_desc].filter(Boolean).join(' · '),
          date: r.grant_date || '',
          link: 'https://wireless2.fcc.gov/UlsApp/UlsSearch/searchLicense.jsp',
          callsign: r.callsign || '',
        })),
      },
      complaints: {
        desc: 'Consumer complaints, newest first',
        build: ({ limit }) => ({ url: `${socrata('3xyp-aqkj', limit)}&$order=date_of_issue%20DESC` }),
        parse: (rows) => asArray(rows).map((r) => ({
          title: r.issue || r.type_of_issue || 'Complaint',
          description: [r.method && `Method: ${r.method}`, r.status && `Status: ${r.status}`].filter(Boolean).join(' · '),
          date: r.date_of_issue || '',
          link: 'https://consumercomplaints.fcc.gov/',
        })),
      },
    },
  },

  // ----- Library of Congress (no key) --------------------------------------
  loc: {
    label: 'Library of Congress',
    attribution: 'Library of Congress',
    subsections: {
      collections: {
        desc: 'Search the digital collections',
        build: ({ q, limit }) => {
          const p = new URLSearchParams({ q: q || 'government', fo: 'json', c: String(limit) });
          return { url: `https://www.loc.gov/search/?${p}` };
        },
        parse: (d) => (d.results || []).map((r) => {
          // description is sometimes a string and sometimes an array of them.
          const desc = Array.isArray(r.description) ? r.description[0] : r.description;
          return {
            title: r.title || cut(desc, 120) || '(untitled)',
            description: cut(desc || ''),
            date: r.date || '',
            link: r.url || r.id || 'https://www.loc.gov/',
          };
        }),
      },
    },
  },

  // ----- National Archives catalog (no key) --------------------------------
  nara: {
    label: 'National Archives and Records Administration',
    attribution: 'U.S. National Archives and Records Administration (public domain)',
    subsections: {
      records: {
        desc: 'Search archival records',
        build: ({ q, limit }) => {
          const p = new URLSearchParams({ q: q || 'federal records', limit: String(limit) });
          return { url: `https://catalog.archives.gov/api/v2/records/search?${p}` };
        },
        parse: (d) => (((d.body || {}).hits || {}).hits || []).map((h) => {
          const src = h._source || {};
          const start = ((src.inclusiveDates || {}).inclusiveStartDate || {}).year;
          return {
            title: src.title || '(untitled)',
            description: cut(src.scopeAndContentNote || ''),
            date: start ? String(start) : '',
            link: h._id ? `https://catalog.archives.gov/id/${h._id}` : 'https://catalog.archives.gov/',
            naid: h._id || '',
          };
        }),
      },
    },
  },

  // ----- National Weather Service, standing in for NOAA (no key) -----------
  noaa: {
    label: 'National Oceanic and Atmospheric Administration (NWS)',
    attribution: 'NOAA / National Weather Service (public domain)',
    subsections: {
      alerts: {
        desc: 'Active weather alerts nationwide',
        build: () => ({ url: 'https://api.weather.gov/alerts/active' }),
        parse: (d) => (d.features || []).map((f) => {
          const p = f.properties || {};
          return {
            title: p.headline || p.event || 'Weather alert',
            description: cut(p.description || ''),
            date: p.onset || p.effective || '',
            link: p.uri || 'https://alerts.weather.gov/',
            severity: p.severity || '', event: p.event || '', area: p.areaDesc || '',
          };
        }),
      },
    },
  },

  // ----- SAM.gov contract opportunities (needs the caller's own key) -------
  sam: {
    label: 'SAM.gov',
    attribution: 'U.S. General Services Administration',
    keyRequired: 'datagov',
    subsections: {
      opportunities: {
        desc: 'Federal contract opportunities, most recent year',
        build: ({ q, limit, from, to, apiKey }) => {
          // SAM wants MM/DD/YYYY and rejects a range wider than a year.
          const fmtDate = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
          const end = to ? new Date(to) : new Date();
          const begin = from ? new Date(from) : new Date(end.getTime() - 364 * 864e5);
          const p = new URLSearchParams({
            limit: String(limit), api_key: apiKey,
            postedFrom: fmtDate(begin), postedTo: fmtDate(end),
          });
          if (q) p.set('title', q);
          return { url: `https://api.sam.gov/opportunities/v2/search?${p}` };
        },
        parse: (d) => (d.opportunitiesData || []).map((o) => ({
          title: o.title || '(untitled)',
          description: cut(o.description || ''),
          date: o.postedDate || '',
          link: o.uiLink || (o.noticeId ? `https://sam.gov/opp/${o.noticeId}` : 'https://sam.gov/'),
          notice_type: o.type || '', department: o.department || '', naics: o.naicsCode || '',
        })),
      },
    },
  },
};

// ---- factory helpers for repetitive subsections ---------------------------

// Envirofacts and Socrata both address a table or resource plus a row count.
const efservice = (table, limit) => `https://data.epa.gov/efservice/${table}/ROWS/0:${limit}/JSON`;
const socrata = (resource, limit) => `https://opendata.fcc.gov/resource/${resource}.json?$limit=${limit}`;

// Several upstreams answer with a bare array rather than an envelope, and
// answer with an object when they fail. Treat anything else as no rows.
function asArray(v) { return Array.isArray(v) ? v : []; }

// EDGAR full-text search: hits.hits[]._source.
function edgarHits(d, form) {
  return (((d.hits || {}).hits) || []).map((h) => {
    const src = h._source || {};
    const name = (src.display_names && src.display_names[0]) || src.entity_name || '(unknown filer)';
    return {
      title: name,
      description: cut([form && `${form} filing`, src.file_description].filter(Boolean).join(' — ')),
      date: src.file_date || '',
      link: src.entity_id
        ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${src.entity_id}&type=${encodeURIComponent(form || '')}`
        : 'https://www.sec.gov/edgar/search/',
      form_type: src.form_type || form || '',
      cik: src.entity_id || '',
    };
  });
}

// BLS v2 takes the series list as a JSON body, so these are the only POSTs.
function blsSub(seriesId, seriesName) {
  return {
    desc: `${seriesName}, monthly`,
    build: ({ from, to }) => {
      const thisYear = new Date().getFullYear();
      const startYear = from ? from.slice(0, 4) : String(thisYear - 3);
      const endYear = to ? to.slice(0, 4) : String(thisYear);
      return {
        url: 'https://api.bls.gov/publicAPI/v2/timeseries/data/',
        method: 'POST',
        body: { seriesid: [seriesId], startyear: startYear, endyear: endYear },
      };
    },
    parse: (d) => {
      const series = (((d.Results || {}).series) || [])[0] || {};
      return (series.data || []).map((x) => ({
        title: `${seriesName}: ${x.value ?? ''}`,
        description: `Period ${x.periodName || ''} ${x.year || ''}`.trim(),
        // period is Mnn for a month; M13 is the annual average, which has no
        // month of its own, so it is dated to the end of its year.
        date: blsDate(x.year, x.period),
        link: 'https://www.bls.gov/data/',
        value: x.value ?? '', year: x.year || '', period: x.periodName || '',
      }));
    },
  };
}

function blsDate(year, period) {
  if (!year) return '';
  const m = /^M(\d{2})$/.exec(String(period || ''));
  if (!m || m[1] === '13') return `${year}-12-31`;
  return `${year}-${m[1]}-01`;
}

// justice.gov and ftc.gov both expose the same Drupal-shaped JSON endpoints.
function drupalSub(base, endpoint, desc) {
  return {
    desc,
    build: ({ limit }) => ({ url: `${base}/${endpoint}.json?pagesize=${limit}` }),
    parse: (d) => {
      // Either {results: [...]} or a bare array, depending on the endpoint.
      const rows = Array.isArray(d) ? d : asArray(d.results);
      return rows.map((r) => ({
        title: r.title || r.headline || '(untitled)',
        description: cut(r.body || r.description || r.summary || ''),
        date: r.date || r.created || r.published || '',
        link: r.url || r.path || base,
      }));
    },
  };
}
function recallSub(path) {
  return {
    desc: `openFDA ${path.split('/')[0]} recalls`,
    build: ({ q, limit, apiKey }) => {
      let u = `https://api.fda.gov/${path}?limit=${limit}&sort=report_date:desc`;
      if (q) u += `&search="${encodeURIComponent(q)}"`;
      if (apiKey) u += `&api_key=${encodeURIComponent(apiKey)}`;
      return { url: u };
    },
    parse: (d) => (d.results || []).map((x) => ({
      title: cut(x.product_description, 100),
      description: cut(x.reason_for_recall),
      date: x.report_date || '',
      link: 'https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts',
      classification: x.classification || '', recalling_firm: x.recalling_firm || '',
    })),
  };
}

function treasurySub(path, fmt) {
  return {
    desc: `Treasury ${path}`,
    build: ({ limit, from, to }) => {
      let u = `https://api.fiscaldata.treasury.gov/services/api/fiscal_service/${path}?page[size]=${limit}&sort=-record_date`;
      if (from) u += `&filter=record_date:gte:${from}`;
      if (to) u += `&filter=record_date:lte:${to}`;
      return { url: u };
    },
    parse: (d) => (d.data || []).map((x) => ({ ...fmt(x), date: x.record_date || '', link: 'https://fiscaldata.treasury.gov/' })),
  };
}

function fedregSub(eoOnly) {
  return {
    desc: eoOnly ? 'Presidential documents / executive orders' : 'Federal Register documents, newest first',
    build: ({ q, limit, from, to }) => {
      const p = new URLSearchParams({ per_page: String(limit), order: 'newest', format: 'json' });
      if (q) p.set('conditions[term]', q);
      if (from) p.set('conditions[publication_date][gte]', from);
      if (to) p.set('conditions[publication_date][lte]', to);
      if (eoOnly) p.append('conditions[type][]', 'PRESDOCU');
      return { url: `https://www.federalregister.gov/api/v1/documents?${p}` };
    },
    parse: (d) => (d.results || []).map((x) => ({
      title: x.title || '(no title)',
      description: cut((x.agencies || []).map((a) => a.name).join(', ') + (x.abstract ? ` · ${x.abstract}` : ''), 280),
      date: x.publication_date || '',
      link: x.html_url || x.pdf_url || 'https://www.federalregister.gov/',
      document_number: x.document_number || '', type: x.type || '',
    })),
  };
}

// ===========================================================================
// Request execution
// ===========================================================================
async function runQuery(agencyId, subId, ctx) {
  const agency = REGISTRY[agencyId];
  const sub = agency.subsections[subId];

  // Two-step agencies (PubMed) handled explicitly.
  if (sub.twoStep && agencyId === 'nih' && subId === 'pubmed') {
    const q = ctx.q || 'health';
    const es = await jget(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(q)}&retmax=${ctx.limit}&retmode=json&sort=date`, { headers: UPSTREAM_HEADERS });
    const ids = es?.esearchresult?.idlist || [];
    if (!ids.length) return { rows: [], upstream: 'eutils.ncbi.nlm.nih.gov' };
    const sum = await jget(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`, { headers: UPSTREAM_HEADERS });
    const rows = ids.filter((id) => sum.result?.[id]?.title).map((id) => {
      const a = sum.result[id];
      return {
        title: a.title,
        description: `Authors: ${(a.authors || []).slice(0, 3).map((x) => x.name).join(', ')} · ${a.source || ''}`,
        date: a.pubdate || '',
        link: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      };
    });
    return { rows, upstream: 'eutils.ncbi.nlm.nih.gov' };
  }

  const spec = sub.build(ctx);
  const init = { headers: { ...UPSTREAM_HEADERS } };
  // A subsection may need headers of its own. SEC is the reason this exists:
  // EDGAR rejects any request whose User-Agent carries no contact address, so
  // the generic browser UA above is not enough.
  if (spec.headers) Object.assign(init.headers, spec.headers);
  if (spec.method === 'POST') {
    init.method = 'POST';
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(spec.body || {});
  }
  const data = await jget(spec.url, init);
  const rows = sub.parse(data, ctx).slice(0, ctx.limit);
  return { rows, upstream: new URL(spec.url).host };
}

// ---- discovery / openapi ---------------------------------------------------
function agenciesDoc() {
  return Object.entries(REGISTRY).map(([id, a]) => ({
    id, label: a.label,
    auth: a.keyRequired ? `caller must supply their own ${a.keyRequired} api_key (?api_key= or X-Api-Key header)` : 'none',
    attribution: a.attribution,
    subsections: Object.entries(a.subsections).map(([sid, s]) => ({
      id: sid, description: s.desc,
      requires_query: !!s.requiresQuery,
      path: `/api/${API_VERSION}/data/${id}/${sid}`,
    })),
  }));
}

function openApiDoc(origin) {
  const paths = {};
  for (const a of agenciesDoc()) {
    for (const s of a.subsections) {
      paths[s.path] = {
        get: {
          summary: `${a.label} — ${s.description}`,
          parameters: [
            { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Search term' + (s.requires_query ? ' (required)' : '') },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: DEFAULT_LIMIT, maximum: MAX_LIMIT } },
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'csv'] } },
            ...(a.auth === 'none' ? [] : [{ name: 'api_key', in: 'query', schema: { type: 'string' }, description: 'Your own api.data.gov key' }]),
          ],
          responses: { 200: { description: 'Normalized records' } },
        },
      };
    }
  }
  return {
    openapi: '3.0.3',
    info: { title: 'OpenGovDash Normalized Data API', version: API_VERSION, description: 'Normalized US federal government data. Records share the shape {title, description, date, link, ...}.' },
    servers: [{ url: origin }],
    paths,
  };
}

// ---- CSV serializer --------------------------------------------------------
function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Array.from(rows.reduce((set, r) => { Object.keys(r).forEach((k) => set.add(k)); return set; }, new Set()));
  const esc = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

// ===========================================================================
// Entry point — called by worker.js for any /api/v1* path.
// ===========================================================================
export async function handleDataApi(request, url, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: API_CORS });
  if (request.method !== 'GET') return apiJson({ ok: false, error: { type: 'method_not_allowed', message: 'Use GET.' } }, 405);

  const parts = url.pathname.split('/').filter(Boolean); // ['api','v1',...]
  const rest = parts.slice(2);

  // /api/v1  → index
  if (rest.length === 0) {
    return apiJson({
      ok: true, service: 'OpenGovDash Normalized Data API', version: API_VERSION,
      endpoints: {
        agencies: `/api/${API_VERSION}/agencies`,
        openapi: `/api/${API_VERSION}/openapi.json`,
        data: `/api/${API_VERSION}/data/{agency}/{subsection}?q=&limit=&from=&to=&format=json|csv`,
      },
      note: 'Agencies with auth != none require YOUR OWN api.data.gov key (?api_key= or X-Api-Key). Get one free at https://api.data.gov/signup/.',
    });
  }
  if (rest[0] === 'agencies') return apiJson({ ok: true, count: Object.keys(REGISTRY).length, agencies: agenciesDoc() });
  if (rest[0] === 'openapi.json') return apiJson(openApiDoc(url.origin));

  // /api/v1/data/{agency}/{subsection}
  if (rest[0] === 'data') {
    const [, agencyId, subId] = rest;
    const agency = REGISTRY[agencyId];
    if (!agency) return apiJson({ ok: false, error: { type: 'unknown_agency', message: `Unknown agency '${agencyId}'. See /api/${API_VERSION}/agencies.` } }, 404);
    const sub = agency.subsections[subId];
    if (!sub) return apiJson({ ok: false, error: { type: 'unknown_subsection', message: `Unknown subsection '${subId}' for '${agencyId}'.`, available: Object.keys(agency.subsections) } }, 404);

    const q = url.searchParams.get('q') || '';
    const limit = clampLimit(url.searchParams.get('limit'));
    const from = url.searchParams.get('from') || '';
    const to = url.searchParams.get('to') || '';
    const format = (url.searchParams.get('format') || 'json').toLowerCase();
    const apiKey = url.searchParams.get('api_key') || request.headers.get('X-Api-Key') || '';

    if (sub.requiresQuery && !q) return apiJson({ ok: false, error: { type: 'query_required', message: `'${agencyId}/${subId}' requires a ?q= keyword.` }, agency: agencyId, subsection: subId }, 400);
    if (agency.keyRequired && !apiKey) return apiJson({ ok: false, error: { type: 'api_key_required', message: `'${agencyId}' needs your own ${agency.keyRequired} key. Pass ?api_key= or X-Api-Key. Free at https://api.data.gov/signup/.` }, agency: agencyId, subsection: subId }, 401);

    // Edge cache (only cacheable when no caller key involved, to avoid keying on secrets).
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: 'GET' });
    let cacheStatus = 'MISS';
    if (!apiKey) {
      const hit = await cache.match(cacheKey);
      if (hit) { const h = new Headers(hit.headers); h.set('X-Cache', 'HIT'); return new Response(hit.body, { status: hit.status, headers: h }); }
    }

    let result;
    try {
      result = await runQuery(agencyId, subId, { q, limit, from, to, apiKey });
    } catch (e) {
      return apiJson({ ok: false, error: { type: 'upstream_error', message: String(e.message || e), upstream_status: e.status || null }, agency: agencyId, subsection: subId }, 502);
    }

    if (format === 'csv') {
      return new Response(toCsv(result.rows), { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${agencyId}-${subId}.csv"`, ...API_CORS } });
    }

    const body = {
      ok: true, agency: agencyId, subsection: subId,
      query: { q: q || null, limit, from: from || null, to: to || null },
      count: result.rows.length,
      results: result.rows,
      source: { upstream: result.upstream, fetched_at: new Date().toISOString() },
      attribution: agency.attribution,
    };
    const resp = apiJson(body, 200, { 'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`, 'X-Cache': cacheStatus });
    if (!apiKey) { const toCache = resp.clone(); await cache.put(cacheKey, toCache).catch(() => {}); }
    return resp;
  }

  return apiJson({ ok: false, error: { type: 'not_found', message: `No such route: ${url.pathname}` } }, 404);
}

// ---------------------------------------------------------------------------
// Programmatic access for the cross-reference layer (/api/db). Given an agency
// + subsection + context, returns the normalized rows (no HTTP envelope).
// ---------------------------------------------------------------------------
export async function fetchNormalized(agencyId, subId, ctx = {}) {
  const agency = REGISTRY[agencyId];
  if (!agency || !agency.subsections[subId]) throw new Error(`unknown table source '${agencyId}/${subId}'`);
  const c = { q: ctx.q || '', limit: clampLimit(ctx.limit || DEFAULT_LIMIT), from: ctx.from || '', to: ctx.to || '', apiKey: ctx.apiKey || '' };
  const { rows } = await runQuery(agencyId, subId, c);
  return rows;
}
// Whether a source agency needs a caller key (so /api/db can report requirements).
export function sourceNeedsKey(agencyId) { return !!(REGISTRY[agencyId] && REGISTRY[agencyId].keyRequired); }
export function listAgencies() { return agenciesDoc(); }
