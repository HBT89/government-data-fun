# Working notes

State and hard-won detail for this repository, so a session can act without
re-deriving it. Update it when something here stops being true.

## What this is

Two things living in one repo:

1. **OpenGovDash** — a browser app over US government APIs, in two independent
   implementations (a Flask backend and a Cloudflare Worker).
2. **The cross-reference index** — a resolvable identity layer over those
   agencies, in `data/` and `tools/`.

### The index model, settled — do not relitigate

- A **relationship** asserts two agencies' records describe the same entity.
  A **link** is the literal address you dereference next.
- Consumers **never search**. They resolve an id through `xref.json` to an
  entity ref, then fetch exactly one known file.
- Every binding carries a **basis**: `authority:` when a source asserted it,
  `match:` when we inferred it. A miss stays a miss rather than becoming a
  wrong answer — see `resolve_ticker` and the bare-symbol promotion.
- **Two tiers.** Public (`data/`) is metadata: who exists, what identifiers
  they carry, that a filing exists and where its PDF is. Curated is the
  *contents* of filings, and is a separate product in a private repo.

## Layout

```
data/                       public tier, committed
  entities/{person,org,filing}.json
  index/{xref,sources}.json
  person/<bioguide>.json    per-person shards
tools/                      index builders (Node, no deps) + the Python parser
proxy/                      Cloudflare Worker: CORS relay, data API, /xref, /curated
webapp/                     Flask backend + static front end
docs/                       specs and runbooks
```

Curated output goes to `$CURATED_OUT` (default `./curated`, gitignored).
The private repo is **HBT89/govdata-curated**.

## Commands

```
# index, in order
node tools/build-person-index.mjs
node tools/build-org-index.mjs
node tools/build-filing-index.mjs --years 2026,2025,2024
node tools/build-xref.mjs
node tools/build-shards.mjs

# curated tier (needs pypdf)
CURATED_OUT=../govdata-curated python tools/build_curated_transactions.py

# app
pip install -r webapp/requirements.txt && python webapp/app.py   # :5000

# every test, none need network
node tools/test-agency-parity.mjs
node proxy/test-data-api.mjs
node proxy/test-curated-route.mjs
node proxy/test-xref-route.mjs
python tools/test_curated_parser.py
python webapp/api/agency_modules/test_ported_modules.py
```

`build-xref.mjs` and `build-shards.mjs` share `manifest.json` and each carries
over what it does not own, so either order is safe.

## Traps

**Three lists, and only two are agency coverage.** Comparing the wrong pair
gives a flattering number:

| List | What it is |
|---|---|
| `AGENCY_REGISTRY` in `webapp/app.py` | Python modules, one per agency |
| `REGISTRY` in `proxy/api.js` | normalized data API, one per agency |
| `UPSTREAMS` in `proxy/worker.js` | **CORS host allowlist, not agencies** |

`UPSTREAMS` holds several hosts per agency and hosts for agencies with no
implementation. `tools/test-agency-parity.mjs` compares the right pair and
fails on drift. Both are at 25, full parity.

**Network.** Every data point is a live fetch; there is no bundled dataset and
no fixture layer. 61 upstream hosts, listed in `docs/LOCAL_DEV.md`. The error
travels *inside* the result envelope rather than failing the request, so a
blocked environment looks like a working app with empty panels, not an outage.

**SEC** 403s any request whose User-Agent carries no contact address. Default
is `contact@opengov.dev`, confirmed by the owner. `runQuery` honours
per-subsection headers specifically for this.

**EDGAR** only accepts the 10-digit zero-padded CIK. `CIK320193.json` 404s;
`CIK0000320193.json` works.

**voteview.com/api/getmember** 404s and **bioguide.congress.gov** 403s bots.
Both are `api: null` in `sources.mjs` with a verification date. Do not
"fix" them by inventing an endpoint.

**Document ids** are the filing entity key and are not guaranteed unique
across years, so the multi-year build refuses duplicates rather than silently
overwriting. 2026 is clean: 1,684 ids, 1,684 distinct.

**Text-layer classification** was sampled from the 2026 index. Unknown id
shapes return `null` rather than a guess. The headline "486 unclassified"
counts every filing kind; of the 397 PTRs only **3** are unclassified and 46
are scans. Do not read it as a PTR backlog.

**Windows**: Git Bash `/tmp` is invisible to Windows Python, and Git Bash
`tar` cannot read zips — use `/c/Windows/System32/tar.exe`.

## Current state

Merged to `main` and **deployed**. Pages, Worker, secret scan and CodeQL all
green on `38cf7a2`. Both deploy workflows fire on push to `main` only, so any
later change needs to land there to reach production.

Built and tested:

- Index: 539 people, 8,046 orgs, 1,684 filings, 23,374 xref keys across 10
  namespaces, no collisions, 539 person shards (7.2KB worst case vs 888KB for
  the whole files).
- `/xref` public route, `/curated` authenticated route, Pages publishing with
  pre-publish verification.
- 25 agencies on both implementations.

**The published index lives on the custom domain, not `github.io`:**

```
https://selvidge.tech/government-data-fun/data
```

That is what the Pages deployment itself reports and where the app is already
served. Everything was originally configured against
`hbt89.github.io/government-data-fun`, which was wrong; do not reintroduce it.

Pending, needing the owner:

1. `wrangler secret put CURATED_TOKEN` and `GITHUB_TOKEN`; add the consumer
   origin to `CURATED_ALLOWED_ORIGINS`. Until then `/curated` answers 503.
2. Allowlist the 61 hosts, then rebuild.
3. Pages reported its environment URL as `http://`, which suggests *Enforce
   HTTPS* is unchecked. A browser consumer on https cannot fetch an http
   origin, so this needs confirming in Settings → Pages.

Pending, needing network:

- **Ticker coverage is unmeasured.** 35% stands. The parser fixes are pinned
  by fixtures, not the corpus, and the 90% in an early draft was biased by one
  all-equity portfolio.
- Multi-year build; curated data does not exist yet at all.
- The 11 ported data API agencies and the 4 ported Flask modules have never
  made a live call.

Open, needing a decision:

- NOAA's two-step forecast is Flask-only; the data API serves alerts only.
  Adding it means generalising the two-step path that exists only for PubMed.
- **Senate ingestion is blocked on legal, not engineering.**
  `efdsearch.senate.gov` gates on an agreement quoting 5 U.S.C. app. 105(c),
  which was not accepted. Separable from the redistribution question.

## Decisions already made

- Curated access is **named and authenticated**, not public. `/curated`
  requires a bearer token, answers only configured origins, is never cached in
  a shared cache, and fails closed when the secret is unset.
- A `VITE_`-prefixed token ships to every visitor and would make the tier
  public by accident. Consumer-side, the token belongs behind the consumer's
  own backend.
- Pages is the canonical origin; the Worker route is a cache in front of it.
- Both implementations are kept at parity rather than one being retired.
- Shards carry no `generated_at`: a per-file timestamp rewrote all 539 on
  every rebuild and made the diff say a rebuild happened instead of what
  changed. `manifest.json` holds the build time.
