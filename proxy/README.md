# opengov-proxy — Cloudflare Worker

A tiny CORS-friendly pass-through for the ~10 US government APIs that don't send CORS headers. Used by the OpenGovDash static site so it can fetch BLS, PubMed, LOC, USASpending, DOJ, NHTSA, EPA, SAM, FTC, NARA, and FCC ECFS directly from a browser.

## Deploy

Automatic: push any change under `proxy/` to `main`. The `deploy-worker.yml` GitHub Actions workflow runs `wrangler deploy` using the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repo secrets.

Manual:

```bash
cd proxy
npx wrangler deploy
```

After deploy, the Worker is reachable at:

```
https://opengov-proxy.<your-subdomain>.workers.dev
```

Find `<your-subdomain>` with:

```bash
npx wrangler whoami
```

…or from the Cloudflare dashboard → Workers & Pages → your-subdomain badge.

## URL shape

```
GET/POST https://opengov-proxy.<sub>.workers.dev/p/<slug>/<upstream-path>?<qs>
```

Where `<slug>` is one of:

| Slug | Upstream |
|---|---|
| `bls` | `https://api.bls.gov` |
| `nih_pubmed` | `https://eutils.ncbi.nlm.nih.gov` |
| `loc` | `https://www.loc.gov` |
| `usaspending` | `https://api.usaspending.gov` |
| `doj` | `https://www.justice.gov` |
| `dot` | `https://api.nhtsa.gov` |
| `epa` | `https://data.epa.gov` |
| `sam` | `https://api.sam.gov` |
| `ftc` | `https://reportportal.ftc.gov` |
| `nara` | `https://catalog.archives.gov` |
| `fcc_ecfs` | `https://publicapi.fcc.gov` |

`GET /health` returns `{ok: true, upstreams: [...], dataApi: "/api/v1"}` for uptime probes.

## Normalized Data API (`/api/v1`)

A public, machine-readable API (in `api.js`) that lets other apps pull the **same normalized data** the OpenGovDash UI shows — the fetch + normalization happen server-side and return a stable JSON/CSV envelope. Unlike the `/p` relay (a dumb byte pass-through), this endpoint returns records already shaped into the OpenGovDash normal form.

```
GET /api/v1                                  → service index
GET /api/v1/agencies                         → machine-readable catalog of agencies + subsections
GET /api/v1/openapi.json                     → OpenAPI 3 spec (generated from the registry)
GET /api/v1/data/{agency}/{subsection}?q=&limit=&from=&to=&format=json|csv
```

Every record shares the contract `{ title, description, date, link, ...rich fields }`. Response envelope:

```json
{
  "ok": true,
  "agency": "usgs", "subsection": "earthquakes",
  "query": { "q": null, "limit": 20, "from": null, "to": null },
  "count": 20,
  "results": [ { "title": "M4.2 — …", "date": "…", "link": "…", "magnitude": 4.2 } ],
  "source": { "upstream": "earthquake.usgs.gov", "fetched_at": "…" },
  "attribution": "U.S. Geological Survey (public domain)"
}
```

**Auth model — no baked-in secrets.** Agencies whose `auth` is not `none` (NASA, Congress, FEC) require the **caller's own** api.data.gov key, passed as `?api_key=` or the `X-Api-Key` header. The site's key is never spent on anonymous callers. Get a free key at https://api.data.gov/signup/.

**CORS:** `Access-Control-Allow-Origin: *` (public-domain government data). This is separate from the origin-pinned `/p` relay.

**Caching:** keyless responses are edge-cached (`caches.default`, TTL 300s); responses served from cache carry `X-Cache: HIT`.

Coverage today (`/api/v1/agencies` is the source of truth): `usgs`, `fda`, `treasury`, `nist`, `fedreg`, `usaspending`, `fdic`, `fema`, `census`, `nih`, and the caller-key set `nasa` / `congress` / `fec`. Adding an agency = one entry in the `REGISTRY` in `api.js` (`build()` + `parse()`).

## Security notes

- `Access-Control-Allow-Origin` is pinned to `selvidge.tech`, `*.github.io`, and `localhost`. Other origins get `selvidge.tech` (their browsers will block the response).
- Inbound `Authorization`, `Cookie`, `X-Forwarded-For`, `X-Real-IP`, and `CF-*` headers are dropped before forwarding. The proxy never leaks client-side auth to the upstream gov API.
- The proxy never holds a secret. Agencies that need a key (SAM, data.gov-gated NASA/FEC endpoints) receive the user's key as a query string exactly as they would on a direct fetch.
- `Set-Cookie` is stripped from the response.

## Free-tier limits

Cloudflare Workers free plan: 100,000 requests/day, 10ms CPU time/request. OpenGovDash's usage pattern (~10 requests per pageview across the 10 proxied agencies) means the free tier covers ~10k pageviews/day, which is plenty for a public demo.
