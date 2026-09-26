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

The Flask app and the Cloudflare Worker each carry their own agency list, and
they have drifted apart. The README's "21 agencies" describes the Flask app,
not what is deployed.

| | Count |
|---|---|
| Flask (`webapp/app.py`) | 21 |
| Worker (`proxy/worker.js`) | 18, from 20 upstream host entries |
| In both | 12 |

In both: `bls`, `doj`, `dot`, `epa`, `fcc`, `ftc`, `loc`, `nara`, `nih`, `sam`, `sec`, `usaspending`.

**Flask only** (9) -- served by the local backend, no Worker route, so
the deployed front end cannot reach them through the proxy:

`census`, `fda`, `fdic`, `fec`, `nasa`, `nist`, `noaa`, `treasury`, `usgs`.

**Worker only** (6) -- proxied for the deployed front end, no Python
module, so the local backend cannot serve them:

`congress`, `ecfr`, `fbi`, `fedreg`, `fema`, `regulations`.

Neither list is a superset of the other, so neither deployment has every data
point the project describes. Which list is authoritative is an open decision,
not an oversight to patch: reconciling them means either porting nine Python
modules to the Worker, adding six modules to Flask, or declaring one of the two
the product and retiring the other.

The cross-reference index sidesteps this entirely. It reads SEC directly rather
than through the proxy, so it depends on neither list.
