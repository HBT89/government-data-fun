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
data/                     public tier, committed here
  entities/person.json    sitting members of Congress
  entities/org.json       SEC registrants with a listed ticker
  entities/filing.json    House disclosure documents, addressable
  index/xref.json         any known foreign id -> entity ref
  index/sources.json      per-agency dereference templates
  person/<bioguide>.json  one person and their filings, addressable alone
  manifest.json           what was built, from what, when

curated/                  not committed; see Tiers
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

## Filing

`data/entities/filing.json`, keyed by chamber and document id.

```json
"h:20034201": {
  "k": "ptr",
  "ch": "house",
  "b": { "house_doc": "20034201" },
  "f": "p:A000379",
  "fn": "Alford, Mark",
  "inc": true,
  "st": "MO", "d": 4,
  "y": 2026,
  "dt": "3/31/2026",
  "url": "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20034201.pdf",
  "text": true,
  "basis": "match:name+statedst"
}
```

**Metadata only.** This records that a filing exists, who filed it and where the
document is. It does not contain the contents of any filing.

`f` is the filer, resolved to a person entity. `inc` is true when the Clerk's
index marks the filer `Hon.`, meaning they filed as a sitting member rather than
a candidate. `text` says whether the PDF carries a text layer, predicted from the
document id shape, so a consumer knows what is machine-readable without fetching
every file.

The filer match is inferred rather than asserted by the source, so it carries a
`match:` basis rather than `authority:`:

| basis | Count | |
|---|---|---|
| `match:name+statedst` | 405 | district seat plus surname |
| `match:name+state` | 17 | member changed districts; state plus surname, and only when exactly one member in the state matches |
| `unmatched` | 1,262 | candidates and departed members, who correctly resolve to no sitting legislator |

Measured on the 2026 index: **381 of 381 PTRs filed by sitting members matched**,
and 96.8% of all `Hon.` filings. The large unmatched count is the 823 candidate
filings and former members, which is the correct outcome rather than a miss.

## Shards

`data/person/<bioguide>.json` is one person and the filings attributed to them.

```json
{
  "kind": "person-shard",
  "ref": "p:A000379",
  "person": { "n": "Mark Alford", "t": "rep", "st": "MO", "d": 4, "b": { ... } },
  "counts": { "filings": 1, "ptr": 1 },
  "filings": { "h:20034201": { ... } },
  "use_restriction": "..."
}
```

Nothing here is new. It is the same person entity and the same filing entities
carrying the same bases, addressed per entity rather than per file. A consumer
that wants one member had to fetch `person.json` and `filing.json` whole, 888KB
between them, to read about 7KB. Resolving through `xref.json` to a `p:` ref and
fetching that one shard is 7.3KB at worst and 1.1KB on average.

| | Whole files | Largest shard |
|---|---|---|
| Bytes for one person | 888.1KB | 7.3KB |

539 shards, 119 of which carry at least one filing. The 422 attributed filings
are exactly the ones `filing.json` resolves to a sitting member; the remaining
1,262 belong to candidates and departed members, so they have no person to hang
under and stay reachable through `filing.json` alone.

A shard that carries filings also carries `use_restriction`, for the same reason
`filing.json` does: the restriction should travel with the data, and a shard is
where a consumer actually arrives.

This adds an address rather than replacing one. Fetching 539 shards to read
every person is worse than fetching `person.json`, which stays where it is.

    node tools/build-shards.mjs [--out data]

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
node tools/build-filing-index.mjs --years 2026
node tools/build-xref.mjs
node tools/build-shards.mjs
```

The shard stage is a reprojection of the entity files and reads nothing
upstream, so it can run any time after the entity builders. It folds its own
summary into `manifest.json` when that file already exists.

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

**Filing** — 1,684 House disclosure documents for 2026, of which 397 are PTRs,
from the Clerk's annual XML index.

| Namespace | Bound | Machine endpoint |
|---|---|---|
| house_doc | 1,684 | PDF, use the entity's own `url` |

1,012 carry a text layer, 186 are scans, 486 have a document id shape this build
does not classify. Those totals describe every kind of filing at once, which
overstates the gap that matters: the curated build reads PTRs and nothing else.

| kind | text | scan | unclassified |
|---|---|---|---|
| candidate | 634 | 34 | 155 |
| **ptr** | **348** | **46** | **3** |
| extension | 0 | 47 | 200 |
| withdrawal | 0 | 35 | 67 |
| blind_trust | 0 | 24 | 49 |
| amendment | 26 | 0 | 12 |
| other | 2 | 0 | 0 |
| termination | 2 | 0 | 0 |

Of the 397 PTRs, 348 are parseable today, 46 are scans awaiting OCR and 3 carry
an id shape this build will not guess at. The unclassified backlog is
overwhelmingly extensions, withdrawals, blind trusts and candidate filings,
none of which the curated build reads. Classifying them is a completeness
question for the metadata, not a blocker on transaction coverage.

Extending the shape rule to those prefixes means sampling the documents
themselves, the same way the current rule was established. Guessing from the id
alone is what `null` exists to avoid.

**Organization** — 8,046 companies from 10,459 ticker rows, from SEC
company_tickers.json.

| Namespace | Bound | Machine endpoint |
|---|---|---|
| sec (CIK) | 8,046 | yes, keyless, contact UA required |
| ticker | 10,459 | none, reverse lookup only |

23,374 reverse-lookup keys across 10 namespaces, no collisions.

## Tiers

The index is split in two, and the line is between addressable and queryable.

**Public**, in `data/`: the identity crosswalks. Person, organization and filing
entities, plus the reverse lookup. This tells you who exists, what identifiers
they carry in each system, that a filing exists and where to fetch it. Anyone can
take this and do their own analysis.

**Curated**, built to `curated/` and not committed here: the contents of filings.
Parsed transactions, resolved asset-to-organization joins, and anything linking a
person to holdings. That is original selection and arrangement over public facts,
and it is a separate product.

The builders take `--out`, so the curated stage can be pointed at a private
location.

### Use restriction

Filing records derive from financial disclosure reports. Title 1 of the Ethics in
Government Act of 1978, 5 U.S.C. app. section 105(c), makes it unlawful to obtain
or use such a report for an unlawful purpose, for a commercial purpose other than
by news and communications media for dissemination to the general public, to
establish any individual's credit rating, or in the solicitation of money.

That provision binds each person who obtains or uses a report, independently.
Redistributing this index does not transfer the obligation and does not discharge
it. `filing.json` carries the restriction in a `use_restriction` field so it
travels with the data rather than living only in a README.

## Not built yet

**Person-to-organization.** Filings are now addressable and attributed to a
filer, but their contents are not parsed, so nothing yet links a person to a
holding. That is the curated tier, scoped in
[DISCLOSURE_INGESTION_SCOPE.md](DISCLOSURE_INGESTION_SCOPE.md). Ticker coverage
measured 90% on sampled asset rows, and the index already resolves tickers to
CIKs, so the join is key-based once the parsing lands.

**Senate filings.** House only so far. The Senate requires accepting an agreement
before searching; see the scope document.

**FCC and USAspending bindings.** Neither can be key-joined to an org. `fcc.py`
returns a licensee name with no FRN, and USAspending matches on recipient name.
Both need name resolution, so those bindings will carry a non-authority `basis`
and consumers will be able to filter them out. Nothing in the current index
depends on a name match.
