# OpenGovDash API Spec Sheet (Connected Apps)

## Purpose
Use this spec to integrate with OpenGovDash as a normalized federal data provider and a cross-reference join layer.

Base URL: https://opengov-proxy.psjs.workers.dev

## API Surfaces
- Normalized data API: /api/v1
- Cross-reference table API: /api/db

## Discovery Endpoints
- GET /api/v1
- GET /api/v1/agencies
- GET /api/v1/openapi.json
- GET /api/db

Notes:
- /api/v1/agencies is the live source of truth for available agency/subsection paths.
- /api/db lists the current cross-reference table catalog.

## Normalized Data Endpoint
GET /api/v1/data/{agency}/{subsection}

Supported query params:
- q: string, optional unless subsection requires it
- limit: integer, default 20, max 100
- from: YYYY-MM-DD (optional)
- to: YYYY-MM-DD (optional)
- format: json or csv (default json)
- api_key: caller key for key-gated agencies
- X-Api-Key header: alternative to api_key

### Response Contract (JSON)
- ok: true
- agency: string
- subsection: string
- query: { q, limit, from, to }
- count: integer
- results: NormalizedRecord[]
- source: { upstream, fetched_at }
- attribution: string

### NormalizedRecord Contract
Required fields:
- title: string
- description: string
- date: string
- link: string

Additional fields vary by source and remain stable per subsection where upstream data allows.

## Cross-Reference Table Endpoint
GET /api/db/{table}

Supported query params:
- q: string, required for specific tables
- limit: integer, default 20, max 100
- from: YYYY-MM-DD (optional)
- to: YYYY-MM-DD (optional)
- format: json or csv
- api_key or X-Api-Key where table sources include key-gated agencies

### Response Contract (JSON)
- ok: true
- table: string
- query: { q, limit, from, to }
- sources: string[] (agency/subsection)
- count: integer
- partial_errors?: string[]
- rows: DbRow[]
- generated_at: date-time

### DbRow Contract
- Includes all NormalizedRecord fields
- Adds _source: string, formatted as provider tag (for example fda:recall)

## Full Agency Coverage
No key required:
- usgs: earthquakes
- fda: drug_events, drug_recalls, device_recalls, food_recalls, device_510k
- treasury: national_debt, daily_statements, interest_rates, exchange_rates
- nist: cve
- fedreg: documents, executive_orders
- usaspending: top_agencies, award_search (q required)
- fdic: institutions, failures
- fema: disasters
- census: population
- nih: pubmed, clinical_trials

api.data.gov caller key required:
- nasa: apod
- congress: bills
- fec: candidates, filings
- fbi: crime, arrests, agencies (agencies requires q=state)

## Full Cross-Reference Table Coverage
- drug-safety
  - Requires q
  - Sources: fda/drug_events, fda/drug_recalls, nih/clinical_trials
- cyber-landscape
  - q optional
  - Sources: nist/cve, usaspending/award_search, fedreg/documents
- disaster-response
  - Requires q
  - Sources: fema/disasters, usaspending/award_search

## Error Model
Data API common errors:
- 400 query_required
- 401 api_key_required
- 404 unknown_agency
- 404 unknown_subsection
- 502 upstream_error

Cross-reference API common errors:
- 400 query_required
- 401 api_key_required
- 404 unknown_table
- 502 table_error

Error envelope:
- ok: false
- error: { type, message, upstream_status? }

## CORS, Caching, and Throughput
- CORS: enabled for direct browser integration.
- Keyless /api/v1 requests are edge cached for a short TTL.
- Requests carrying caller keys are not served from shared keyless cache path.

## Machine-Readable Contract Files In This Repo
- OpenAPI: docs/openapi-contract.yaml
- JSON Schema: docs/schemas/normalized-record.schema.json
- JSON Schema: docs/schemas/data-envelope.schema.json
- JSON Schema: docs/schemas/db-envelope.schema.json
- JSON Schema: docs/schemas/error-envelope.schema.json

## Implementation Guidance for Client Apps
- Build endpoint selectors from discovery endpoints, not hardcoded lists.
- Validate all JSON with the provided schemas.
- Treat title/description/date/link as canonical display fields.
- Preserve _source when aggregating cross-reference rows in your app.
- Render partial results when partial_errors is present.
