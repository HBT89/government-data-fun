# Running locally

## Launch

```
pip install -r webapp/requirements.txt
python webapp/app.py            # http://127.0.0.1:5000
```

`app.py` serves `webapp/static/index.html` at `/` and the agency endpoints at
`/api/data/<agency>`. No build step and no keys are needed to start: keys are
per-user and live in the browser, and `.env.example` lists the few the backend
can hold instead.

Verified from a clean install: the server boots, `/` returns the UI and
`/api/agencies` returns all 21 agency descriptors.

## What "all data points" currently means

The app fetches live government APIs at request time. There is no bundled
dataset and no fixture layer, so every data point depends on outbound network
access to the agency that serves it. In a restricted environment the app still
boots and still renders, but each endpoint returns an error envelope rather
than records:

```json
{"endpoint": "8-K Filings", "source": "SEC EDGAR",
 "results": [{"error": "... Tunnel connection failed: 403 Forbidden"}]}
```

That shape is by design -- the error travels in the result rather than failing
the request -- which also means a fully blocked environment looks like a
working app serving empty sections.

### Hosts the app needs

All 61, collected from the agency modules, the Worker's upstream table and the
index builders. Anything less than the full list leaves specific sections dark.

```
alerts.weather.gov
api.bls.gov
api.census.gov
api.congress.gov
api.fda.gov
api.fiscaldata.treasury.gov
api.nasa.gov
api.nhtsa.gov
api.open.fec.gov
api.regulations.gov
api.sam.gov
api.usa.gov
api.usaspending.gov
api.weather.gov
aqs.epa.gov
banks.data.fdic.gov
bioguide.congress.gov
broadbandmap.fcc.gov
catalog.archives.gov
clinicaltrials.gov
consumercomplaints.fcc.gov
data.census.gov
data.epa.gov
data.sec.gov
disclosures-clerk.house.gov
earthquake.usgs.gov
echo.epa.gov
efts.sec.gov
enviro.epa.gov
eutils.ncbi.nlm.nih.gov
fiscaldata.treasury.gov
nvd.nist.gov
opendata.fcc.gov
publicapi.fcc.gov
pubmed.ncbi.nlm.nih.gov
sam.gov
services.nvd.nist.gov
unitedstates.github.io
voteview.com
waterdata.usgs.gov
waterservices.usgs.gov
weather.gov
wireless2.fcc.gov
www.accessdata.fda.gov
www.bls.gov
www.ecfr.gov
www.fda.gov
www.fdic.gov
www.fec.gov
www.federalregister.gov
www.fema.gov
www.ftc.gov
www.govtrack.us
www.justice.gov
www.loc.gov
www.nhtsa.gov
www.opensecrets.org
www.sec.gov
www.senate.gov
www.usaspending.gov
www.wikidata.org
```

`unitedstates.github.io`, `voteview.com`, `www.govtrack.us`,
`www.opensecrets.org` and `www.wikidata.org` are not agencies; they are the
upstreams the cross-reference index resolves people through.

## Two implementations, different coverage

There are three lists in this repository and only two of them are about agency
coverage. Comparing the wrong pair is easy and gives a flattering number:

| List | What it is |
|---|---|
| `AGENCY_REGISTRY` in `webapp/app.py` | Python modules, one per agency |
| `REGISTRY` in `proxy/api.js` | the normalized data API, one per agency |
| `UPSTREAMS` in `proxy/worker.js` | a CORS host allowlist, **not** an agency list |

`UPSTREAMS` carries several hosts for a single agency and hosts for agencies
with no implementation at all, so counting it overstates coverage. Real
coverage is `AGENCY_REGISTRY` against `REGISTRY`:

| | Count |
|---|---|
| Flask (`webapp/app.py`) | 25 |
| Data API (`proxy/api.js`) | 25 |
| In both | 25 |

**Full parity.** Every agency is implemented on both sides, so the local
backend and the deployed front end cover the same ground. Four were ported
into Flask (`congress`, `fbi`, `fedreg`, `fema`) and eleven into the data API
(`bls`, `doj`, `dot`, `epa`, `fcc`, `ftc`, `loc`, `nara`, `noaa`, `sam`,
`sec`), in both directions from the implementation that already existed rather
than written fresh against the docs.

The README's "21 agencies" is now the understatement rather than the
overstatement: there are 25.

One gap inside an agency rather than between them: NOAA's two-step forecast
(resolve a point, then fetch its forecast URL) exists only in Flask. The data
API serves active alerts, which is a single call. Adding it means generalising
the two-step path that currently exists only for PubMed.

### Keeping them honest

```
node tools/test-agency-parity.mjs
```

It parses both lists and fails when the split changes, naming what moved.
Adding an agency to one side then becomes a decision -- implement it on the
other, or record the gap in `EXPECTED` deliberately -- rather than a drift
nobody notices.

Separately, `UPSTREAMS` now carries every host the Python modules fetch, so
anything the browser needs is at least reachable through the proxy. That is a
routing fix, not coverage: a host being reachable does not give the data API
an implementation for it.

The cross-reference index depends on neither list. It reads SEC directly
rather than through the proxy.
