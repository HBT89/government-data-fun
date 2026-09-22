// Dereference table: how to turn a native identifier into a request.
//
// This is the "link" half of the index. A consumer that holds an entity
// binding does not search anything: it takes the agency id, picks the
// template here, substitutes {id}, and has the exact upstream address of
// that datapoint.
//
// `api`  machine endpoint returning data for that id
// `web`  human-facing page for the same thing
// `via`  the same data through this project's own normalized API, when covered
// `key`  which caller key the api template needs, if any

export const SOURCES = {
  congress: {
    label: 'Congress.gov (Library of Congress)',
    idName: 'bioguide',
    api: 'https://api.congress.gov/v3/member/{id}?format=json&api_key={key}',
    // Verified 2026-09-22: returns 403 to automated fetches. Fine in a browser,
    // not something a crawler can follow.
    web: 'https://bioguide.congress.gov/search/bio/{id}',
    via: null,
    key: 'congress_gov',
    attribution: 'Library of Congress / Congress.gov',
  },
  fec: {
    label: 'Federal Election Commission (openFEC)',
    idName: 'candidate_id',
    api: 'https://api.open.fec.gov/v1/candidate/{id}/?api_key={key}',
    web: 'https://www.fec.gov/data/candidate/{id}/',
    via: '/api/v1/data/fec/candidates',
    key: 'datagov',
    attribution: 'Federal Election Commission',
  },
  govtrack: {
    label: 'GovTrack',
    idName: 'govtrack_id',
    api: 'https://www.govtrack.us/api/v2/person/{id}',
    web: 'https://www.govtrack.us/congress/members/{id}',
    via: null,
    key: null,
    attribution: 'GovTrack.us',
  },
  opensecrets: {
    label: 'OpenSecrets (Center for Responsive Politics)',
    idName: 'cid',
    api: null,
    web: 'https://www.opensecrets.org/members-of-congress/summary?cid={id}',
    via: null,
    key: null,
    attribution: 'OpenSecrets.org',
  },
  wikidata: {
    label: 'Wikidata',
    idName: 'qid',
    api: 'https://www.wikidata.org/wiki/Special:EntityData/{id}.json',
    web: 'https://www.wikidata.org/wiki/{id}',
    via: null,
    key: null,
    attribution: 'Wikidata (CC0)',
  },
  lis: {
    label: 'U.S. Senate LIS',
    idName: 'lis_id',
    api: null,
    web: 'https://www.senate.gov/senators/',
    via: null,
    key: null,
    attribution: 'U.S. Senate',
  },
  sec: {
    label: 'SEC EDGAR',
    idName: 'cik',
    // Verified 2026-09-22: the id MUST be the 10-digit zero-padded CIK.
    // data.sec.gov/submissions/CIK320193.json returns 404;
    // data.sec.gov/submissions/CIK0000320193.json returns 200. Bindings store
    // the padded form so the template is a straight substitution.
    // SEC rejects requests whose User-Agent carries no contact address.
    api: 'https://data.sec.gov/submissions/CIK{id}.json',
    web: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={id}&type=&dateb=&owner=include&count=40',
    via: null,
    key: null,
    ua: 'contact',
    attribution: 'U.S. Securities and Exchange Commission, EDGAR',
  },
  ticker: {
    label: 'Exchange ticker symbol',
    idName: 'ticker',
    // Not an agency. A namespace a caller may arrive holding, so it earns a
    // reverse-lookup entry even though there is nothing to dereference.
    api: null,
    web: null,
    via: null,
    key: null,
    attribution: 'SEC company_tickers.json',
  },
  house_doc: {
    label: 'U.S. House Clerk, financial disclosure document',
    idName: 'doc_id',
    // The path differs by filing kind, so the entity carries the full url and
    // this template covers the PTR case only. Prefer the entity's own `url`.
    api: null,
    web: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/{id}.pdf',
    via: null,
    key: null,
    attribution: 'Clerk of the U.S. House of Representatives',
  },
  icpsr: {
    label: 'ICPSR / Voteview',
    idName: 'icpsr',
    // Verified 2026-09-22: voteview.com/api/getmember/{id} and
    // /api/getmembersbycongress/{n} both 404. No machine endpoint advertised
    // until one is confirmed working. The person page does resolve.
    api: null,
    web: 'https://voteview.com/person/{id}',
    via: null,
    key: null,
    attribution: 'Voteview (UCLA)',
  },
};

// Substitute {id} and {key} into a template. Returns null when the source has
// no template of that kind, so callers can tell "no machine endpoint" from
// "endpoint that happens to need a key".
export function deref(agency, kind, id, key = '') {
  const s = SOURCES[agency];
  if (!s) return null;
  const tpl = s[kind];
  if (!tpl) return null;
  return tpl.replace('{id}', encodeURIComponent(String(id))).replace('{key}', encodeURIComponent(key));
}
