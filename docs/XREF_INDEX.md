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
  entities/person.json    entities and their per-agency bindings
  index/xref.json         any known foreign id -> entity ref
  index/sources.json      per-agency dereference templates
  manifest.json           what was built, from what, when
```

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

```
node tools/build-person-index.mjs
```

No dependencies, Node 18+. Fetches
[unitedstates/congress-legislators](https://github.com/unitedstates/congress-legislators)
and writes all four files. Re-run to refresh.

## Coverage

Built, all authority-based:

| Agency | Bound | Machine endpoint |
|---|---|---|
| congress (bioguide) | 539 | yes, needs congress.gov key |
| govtrack | 539 | yes, keyless |
| wikidata | 538 | yes, keyless |
| fec | 537 | yes, needs api.data.gov key |
| opensecrets | 523 | web only |
| icpsr | 319 | web only |
| lis | 100 | web only |

539 current legislators, 100 senators and 439 representatives. 3,185 reverse-lookup
keys, no collisions.

## Not built yet

**Organizations.** The org entity type is the bridge from a person to SEC, FCC and
USAspending records. It is not built, and it is harder than the person side: SEC
carries CIK, but FCC exposes only a licensee name with no FRN, so SEC-to-FCC
sameness has to be established by name resolution rather than a shared key. Those
entities will carry a non-authority `basis`.

**Financial disclosures.** The person-to-organization hop depends on STOCK Act
filings, which no source in this repo currently provides. Until that lands, a
person resolves to their campaign finance and legislative record, not to company
holdings.
