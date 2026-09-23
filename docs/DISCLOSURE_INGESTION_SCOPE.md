# Scope: STOCK Act disclosure ingestion

Everything below was verified against the live sources on 2026-09-22. Figures
come from the 2026 House index and a sample of eight member-filed PTRs.

This closes the one missing hop in the cross-reference index: person to
organization. Read [XREF_INDEX.md](XREF_INDEX.md) first.

## Why this hop is worth building

The House side turned out far better than expected, for one reason: PTR PDFs
name the ticker inline.

```
Amazon.com, Inc. - Common Stock (AMZN) [ST]    S (partial)  03/16/2026  $1,001 - $15,000
Apple Inc. - Common Stock (AAPL) [ST]          S (partial)  03/16/2026  $1,001 - $15,000
```

The index already maps `ticker:AMZN` to a CIK. So the chain is key-joined at
every hop that matters, with no name resolution anywhere:

```
person  --[name + StateDst]-->  PTR filing  --[ticker]-->  org  --[CIK]-->  SEC
```

Only the first hop is inferred, and it is inferred from name plus state and
district against 539 known legislators, which is a far smaller problem than
matching arbitrary company names.

## House: verified numbers

Source: `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{year}FD.zip`

No authentication, no gate, no rate limiting encountered. The ZIP is 60-106KB
and contains an XML index, not the documents.

2026 index, 1,672 filings:

| Filing type | Count | Meaning |
|---|---|---|
| C | 812 | Candidate |
| P | **396** | **Periodic Transaction Report, the trades** |
| X | 247 | Extension |
| W | 102 | Withdrawal |
| D | 73 | Blind trust |
| A | 38 | Amendment |
| T, H | 4 | Termination, other |

Index fields: `Prefix, Last, First, Suffix, FilingType, StateDst, Year, FilingDate, DocID`.
There is no bioguide id, which is why the person hop needs matching.

Of the 396 PTRs, 380 carry `Prefix: "Hon."`, marking a sitting member rather
than a candidate, across 105 distinct districts.

PDFs live at `/public_disc/ptr-pdfs/{year}/{DocID}.pdf`.

**Filing method is predictable from the DocID**, which decides whether a document
needs OCR:

| DocID shape | Share of 2026 PTRs | Text layer |
|---|---|---|
| 8-digit, starts 2003 | 87.6% | yes, extractable |
| 7-digit | 11.6% | no, scanned |
| other 8-digit | 0.8% | mixed |

Sampling eight member PTRs: seven extracted cleanly, one 30-page scan yielded
zero characters.

**Ticker coverage, corrected.** An initial reading of those eight documents gave
147 of 164 asset rows carrying a ticker, 90%. That figure was sample-biased: one
filing contributed 151 of the 164 rows and was an all-equity portfolio. Running
the parser across 30 filings gives **47 of 135 transactions with a ticker, 35%**.
Use 35%. The rest are assets with no ticker by nature: mutual funds, bonds, real
estate, private partnerships and trusts, none of which resolve to a listed CIK.

Of the transactions that do carry a ticker, roughly 87% resolve to an org entity;
the misses are ADRs and OTC symbols absent from SEC's listed-registrant file.

### Work involved

1. Fetch and parse the annual XML index. Trivial, it is already clean.
2. Fetch PTR PDFs for `FilingType=P`. 396 documents for 2026.
3. Extract text. `pypdf` is sufficient for the 88%.
4. Parse asset rows into `{asset_name, ticker, asset_type, transaction_type,
   date, amount_range, owner}`. This is the real work: the layout is a table
   flattened into text, and multi-line descriptions interleave with rows.
5. Match filer to a person entity on name plus `StateDst`. 539 candidates,
   bounded problem, but needs a reviewed exception list rather than blind
   fuzzy matching.
6. Emit bindings and a new `filing` entity type.

The 12% scanned minority should be indexed with their metadata and flagged
`text: false` rather than OCR'd initially. They are then visible as a known gap
instead of silently missing, and OCR can be added later without a reshape.

## Senate: blocked, and not only technically

Source: `https://efdsearch.senate.gov/search/`

`/search/` 302s. `/search/home/` serves an agreement form that must be accepted
before any search, establishing a session. Coverage is senators, former senators
and Senate candidates, 2012 to present.

**I did not accept that agreement.** Accepting a legal agreement on the project
owner's behalf is the owner's call, and the thing being accepted is the reason.

The gate quotes Title 1 of the Ethics in Government Act of 1978,
5 U.S.C. app. section 105(c). It states it is unlawful to obtain or use a report:

- for any unlawful purpose
- **for any commercial purpose, other than by news and communications media for
  dissemination to the general public**
- for determining or establishing the credit rating of any individual
- for use, directly or indirectly, in the solicitation of money for any
  political, charitable, or other purpose

The Attorney General may bring a civil action, with a penalty up to $10,000.

This is a scoping input, not a technical footnote. The stated goal for this index
is to publish it for other people to build applications on. The commercial-purpose
restriction and its news-media exception bear directly on that, and on what
licence the published data can carry. Other projects do redistribute this data,
which tells you the practice exists, not that any particular use is permitted.

This document does not offer a legal read on it. Someone qualified should look
before Senate data is redistributed, and the answer may differ for ingesting it,
serving it through an API, and publishing it as a downloadable dataset.

Note the statute governs the reports, not the site, so it is not avoided by
taking House data instead. The House simply does not put a click-through in
front of it.

## Suggested phasing

**Phase 1, House index only.** Parse the XML, emit a `filing` entity per PTR with
filer, date, type and document URL. No PDF parsing. This alone makes every
disclosure addressable by the index and is a small piece of work with no new
legal exposure.

**Phase 2, House PTR parsing.** Extract asset rows from the 88% with a text
layer, bind tickers to org entities through the existing xref. This is what
makes "pick a member, see their holdings" real.

**Phase 3, decide on Senate.** Gated on the legal question above, not on
engineering.

**Phase 4, OCR the scanned minority.** Optional, and clearly bounded once phases
1 and 2 define the gap.

## Schema sketch

A new entity kind, `filing`, ref prefix `f`, keyed by chamber and DocID:

```json
"h:20034201": {
  "k": "ptr",
  "ch": "house",
  "f": "p:A000377",
  "dt": "2026-03-31",
  "url": "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20034201.pdf",
  "text": true,
  "tx": [
    { "a": "Amazon.com, Inc. - Common Stock", "o": "o:0001018724",
      "ty": "ST", "act": "S", "d": "2026-03-16", "amt": "1001-15000" }
  ],
  "basis": "authority:house-clerk"
}
```

`f` points at the person entity, `o` at the org entity. A transaction with no
resolvable ticker keeps `a` and omits `o`, so the gap is legible rather than
guessed at.

The filer match needs its own basis, since it is inferred rather than asserted
by the source: `match:name+statedst` rather than `authority:`.
