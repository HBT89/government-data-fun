# Cross-Reference Index

A resolvable identity layer over US government data.

## The model

Two distinct things, and keeping them apart is the whole design.

**A relationship** is the assertion that data in one agency and data in another
describe *the same entity*. FEC candidate `S8WA00194` and Congress bioguide
`C000127` are the same person.

**A link** is the literal address you go to next. Given `S8WA00194`, the link is
`https://api.open.fec.gov/v1/candidate/S8WA00194/`.

A consumer holding this index never searches. It resolves an entity, reads the
binding for the agency it wants, substitutes the id into that agency's template,
and fetches exactly one known record.

## Files

```
data/
  entities/person.json    sitting members of Congress
  entities/org.json       SEC registrants with a listed ticker
  index/xref.json         any known foreign id -> entity ref
  index/sources.json      per-agency dereference templates
  manifest.json           what was built, from what, when
```

Files are pretty-printed rather than minified. They are committed artifacts that
get regenerated, so a readable diff between refreshes is worth more than the
bytes; serve them gzipped.

## Entity

`data/entities/person.json`, keyed by bioguide id. Field names are short because
this file is fetched whole.

```json
"C000127": {
  "n":  "Maria Cantwell",
  "t":  "sen",
  "st": "WA",
  "d":  null,
  "pt": "D",
  "b": {
    "congress":    "C000127",
    "fec":         ["S8WA00194", "H2WA01054"],
    "govtrack":    "300018",
    "opensecrets": "N00007836",
    "wikidata":    "Q22250",
    "lis":         "S275",
    "icpsr":       "39310"
  },
  "basis": "authority:congress-legislators"
}
```

`b` is the bindings map: agency id to that agency's native identifier. A value is
an array when the agency legitimately assigns more than one, which FEC does for
anyone who has run for a different office.

`basis` records how sameness was established. Every person entity is currently
`authority:congress-legislators`, meaning a curated upstream asserted it and this
project did not infer anything. When name-matched entities are added they will
carry a different basis, so a consumer can filter on it.

The entity ref is `p:` plus the key, e.g. `p:C000127`.

## Organization

`data/entities/org.json`, keyed by the zero-padded CIK.

```json
"0001652044": {
  "n": "Alphabet Inc.",
  "b": {
    "sec":    "0001652044",
    "ticker": ["GOOGL", "GOOG", "GOOGM", "GOOGN"]
  },
  "basis": "authority:sec-company-tickers"
}
```

`ticker` is an array for the same reason `fec` is on the person side: one entity,
several identifiers. Alphabet has four share classes, Berkshire two. 1,448 of the
8,046 companies carry more than one.

The CIK is stored zero-padded to ten digits because that is what EDGAR accepts.
`data.sec.gov/submissions/CIK0000320193.json` returns 200;
`CIK320193.json` returns 404.

The entity ref is `o:` plus the key, e.g. `o:0000320193`.

Coverage is SEC registrants with a listed ticker. Private companies, non-filers
and foreign issuers without a US listing are absent by construction, not by
oversight.

## Reverse lookup

`data/index/xref.json` maps `"<agency>:<native id>"` to an entity ref:

```json
"fec:S8WA00194": "p:C000127",
"govtrack:300018": "p:C000127",
"wikidata:Q22250": "p:C000127"
```

One object access. Arrive holding any agency's id, leave holding the entity.

## Dereferencing

`data/index/sources.json` holds one entry per agency:

- `api` machine endpoint, or `null` when the agency has none
- `web` human page
- `via` the same data through this project's normalized API, when covered
- `key` which caller key `api` needs, if any

Substitute `{id}`, and `{key}` where required. `api: null` is deliberate: an
index that advertises pointers it cannot follow is worse than one that admits
the gap. Templates are verified against the live endpoint before they are added.

## Building

Three stages. Entity builders write their own file; the xref stage merges them.

```
node tools/build-person-index.mjs
node tools/build-org-index.mjs
node tools/build-xref.mjs
```

No dependencies, Node 18+. Re-run to refresh.

The xref stage fails the build on a collision, meaning one foreign identifier
resolved to two entities. That makes a lookup ambiguous, so it is treated as a
data error rather than reported and passed over.

SEC rejects requests whose User-Agent carries no contact address. The org builder
defaults to the string already declared in `webapp/api/agency_modules/sec.py`;
override it with `SEC_USER_AGENT` to name yourself.

## Coverage

Built, all authority-based. No name matching anywhere in the current index.

**Person** — 539 sitting legislators, 100 senators and 439 representatives,
from unitedstates/congress-legislators.

| Namespace | Bound | Machine endpoint |
|---|---|---|
| congress (bioguide) | 539 | yes, needs congress.gov key |
| govtrack | 539 | yes, keyless |
| wikidata | 538 | yes, keyless |
| fec | 537 | yes, needs api.data.gov key |
| opensecrets | 523 | web only |
| icpsr | 319 | web only |
| lis | 100 | web only |

**Organization** — 8,046 companies from 10,459 ticker rows, from SEC
company_tickers.json.

| Namespace | Bound | Machine endpoint |
|---|---|---|
| sec (CIK) | 8,046 | yes, keyless, contact UA required |
| ticker | 10,459 | none, reverse lookup only |

21,690 reverse-lookup keys across 9 namespaces, no collisions.

## Not built yet

**Person-to-organization.** The two entity types exist but nothing joins them.
That hop depends on STOCK Act disclosures, which no source in this repo provides.
Until it lands, a person resolves to their campaign finance and legislative
record, and an organization to its SEC filings, but not to each other.

**FCC and USAspending bindings.** Neither can be key-joined to an org. `fcc.py`
returns a licensee name with no FRN, and USAspending matches on recipient name.
Both need name resolution, so those bindings will carry a non-authority `basis`
and consumers will be able to filter them out. Nothing in the current index
depends on a name match.
