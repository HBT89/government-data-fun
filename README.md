# OpenGovDash — User Guide

**Open the app:** https://selvidge.tech/government-data-fun/

OpenGovDash is a free, no-install web app for exploring **21 US government agencies** and ~56 live data endpoints — SEC filings, FDA recalls, BLS employment, NASA, USGS earthquakes, federal spending, campaign finance, and more. Search and filter the raw data yourself, or ask the built-in AI assistant to fetch and cross-reference it for you.

Nothing to download. No account. Your API keys (if you add any) never leave your browser.

---

## 1. Getting started

When you first open the app you'll see a **setup wizard**. Pick one of three tracks:

| Track | What you get | Need a key? |
|---|---|---|
| **Free AI** | The AI assistant runs on Cloudflare Workers AI (Llama 3.3 70B). Works immediately, supports tool-use, no signup. Add a Groq or Gemini key for faster, higher-limit access. | No (optional) |
| **Best Quality** | Highest-quality answers and the most reliable tool-use. Uses Anthropic Claude or OpenAI (pay-per-use). | Yes |
| **Just Data** | Skip AI entirely. Browse, search, and filter all 21 agencies. You can turn AI on later. | No |

You can change tracks or add/remove keys any time — click **API Key** in the chat top bar. The wizard's last step runs a quick live test so you can confirm your provider works before you dive in.

In a hurry? Hit **"Skip · just show me the data"** on the first screen.

---

## 2. The AI assistant

The chat isn't just a chatbot — it can **call the government APIs for you**. Ask a question and it picks the right agency tools, fetches live data, and synthesizes an answer that cites where each fact came from. You'll see its tool activity inline (`⚙ calling query_sec(...)` → `↳ query_sec → 8 results`).

It has one tool per agency plus a `cross_reference` tool that searches several agencies at once.

**Things to try:**

- *"What are the latest SEC 8-K filings that mention cybersecurity?"*
- *"Cross-reference 'Samsung' across FCC, FDA, and FTC."*
- *"Show me recent FDA drug recalls and any related SEC filings from those companies."*
- *"Search PubMed for GLP-1 agonist clinical trials."*
- *"What federal contracts mention 'quantum computing' in USAspending?"*

**Tips**

- Be specific. "Recent 8-K filings about Apple" works better than "tell me about Apple."
- The assistant runs up to 5 tool rounds per question, then answers with what it has. If it stops short, ask a narrower question.
- **Provider quality matters.** Free mode is good for exploring; Claude or OpenAI give noticeably better synthesis and more reliable tool-use. Groq's free tier is a great middle ground (fast, 14.4k requests/day).

### Which provider should I use?

| Provider | Cost | Get a key | Notes |
|---|---|---|---|
| **Free (Workers AI)** | Free, no signup | — | Default. Llama 3.3 70B. Shared daily limit; if it's exhausted the app tells you honestly and suggests adding a key. |
| **Groq** | Free tier — 30 req/min, 14.4k/day | https://console.groq.com/keys | Best free-with-key option. Fast, reliable tool-use. |
| **Google Gemini** | Free tier — 15 req/min, 1.5k/day | https://aistudio.google.com/app/apikey | No credit card needed. |
| **Anthropic Claude** | Pay-per-use (~$3/$15 per 1M tokens) | https://console.anthropic.com/settings/keys | Best answer quality. |
| **OpenAI** | Pay-per-use (~$0.15 per 1M input) | https://platform.openai.com/api-keys | Requires prepaid credits on new accounts. |

---

## 3. Your API keys are private

If you add a key, it is stored **only in your browser's localStorage** and sent **only to that provider** when you chat. OpenGovDash has no server that sees, logs, or stores your keys.

In the **API Key** panel you can:

- See a health dashboard for every key (green = verified, amber = rate-limited, red = invalid).
- Watch keys validate live as you paste them.
- See keys masked (`sk-···abcd`) and reveal them with a Show toggle.
- **Revoke** any key with one click — it's wiped from memory and localStorage immediately.

Because keys live in the browser, **don't enter keys on a shared or public computer.**

### The data.gov key (optional)

A free [data.gov key](https://api.data.gov/signup/) unlocks:

- **SAM.gov** federal contract opportunities (required — SAM won't work without it)
- Higher rate limits on **NASA** and **FEC**

Paste it in the wizard's data step or the API Key panel. It's optional for everything else.

---

## 4. Browsing the data yourself

Pick any agency from the left sidebar. Each agency page gives you:

- **Datasets** — sub-sections (e.g. SEC: 8-K, 10-K, 10-Q, 13F, S-1).
- **Search** — for agencies that support it; the placeholder tells you what to type.
- **Filters** — result limit (10–100) and, where the API supports it, a date range.
- **Views** — card view or table view, plus a result count.

Use the **Back** button (top-left) or your browser's Back button to step back through pages — navigation stays inside the app.

---

## 5. The 21 agencies

| Agency | What's there | Notes |
|---|---|---|
| **SEC** | EDGAR filings: 8-K, 10-K, 10-Q, 13F, S-1, company search | |
| **FDA** | Drug adverse events, drug/device/food recalls, 510(k) clearances | |
| **Treasury** | National debt, daily statements, interest & exchange rates | |
| **USAspending** | Top agencies by budget, federal accounts, award/contract search | Award Search needs a keyword |
| **NOAA** | Weather alerts and forecasts | |
| **USGS** | Recent earthquakes | |
| **NASA** | Astronomy Pic of the Day, near-Earth objects, Mars photos | data.gov key raises limits |
| **BLS** | Unemployment, CPI, employment, average hourly earnings | |
| **Census** | Population and median income by state | |
| **FDIC** | Bank financials, bank failures | |
| **NIH** | PubMed research, ClinicalTrials.gov | |
| **FEC** | Candidates, committee filings | data.gov key raises limits |
| **LOC** | Library of Congress digital collections | |
| **NIST** | CVE vulnerability database | |
| **FCC** | Equipment authorizations, ECFS filings, consumer complaints, broadband | |
| **DOJ** | Press releases, blog, speeches, news | |
| **DOT / NHTSA** | Vehicle recalls and safety complaints | Search as "Make Model Year" (e.g. *Toyota Camry 2023*) |
| **EPA** | Toxic Release Inventory, water systems, regulated facilities | |
| **SAM.gov** | Federal contract opportunities | Requires a free data.gov key |
| **NARA** | National Archives catalog | The Archives' public API is currently down on their side; the app says so and links you to their site |
| **FTC** | Press releases / enforcement | The FTC publishes no public data feed; the app links you to ftc.gov |

When an upstream government API is broken or unavailable, OpenGovDash tells you plainly and links you to the source instead of showing fake or empty data.

---

## 6. Troubleshooting

**"Free AI has hit its shared daily limit."**
Free mode runs on a shared allowance that resets at 00:00 UTC. Add a free Groq key for unlimited fast access, or come back later.

**An agency shows "temporarily unreachable."**
Government APIs go down sometimes. Try again in a bit, or try a different dataset. NARA and FTC have known upstream outages (see the table above).

**The assistant answered without using a tool / answer seems generic.**
Free-tier models are weaker at deciding when to call tools. Ask more directly ("use the SEC tool to…") or switch to Groq/Claude/OpenAI.

**My key shows red / "invalid."**
Re-check it in the API Key panel. Make sure there's no trailing space, and that the key matches the selected provider (OpenAI `sk-…`, Groq `gsk_…`, Gemini `AIza…`, Claude `sk-ant-…`).

**SAM.gov shows "requires a data.gov API key."**
That's expected — get a free key at https://api.data.gov/signup/ and paste it in the API Key panel.

**Browser Back left the site.**
Fixed — Back now navigates within the app. From the overview/home screen, Back does exit (that's the entry point).

---

## 7. Privacy

- No accounts, no tracking, no analytics.
- API keys: browser-only, never sent to any OpenGovDash server (there isn't one — it's a static site).
- Government data is fetched live; some requests for agencies that block browsers are relayed through a thin Cloudflare proxy that **strips your auth headers and cookies** before forwarding and holds no secrets.

---

## Running it locally / self-hosting

Everything above is for users of the hosted app. To run your own copy:

**Static only (simplest):**
```bash
cd webapp/static
python -m http.server 8000
# open http://localhost:8000/index.html
```
Agencies that block cross-origin browser requests (BLS, NIH, LOC, USAspending, DOJ, DOT, EPA, SAM, FTC, NARA, SEC, FCC ECFS) will fall back to the shared Cloudflare proxy automatically.

**With the optional Flask backend** (proxies the CORS-restricted agencies locally):
```bash
cd webapp
pip install -r requirements.txt
python app.py
# open http://localhost:5000
```

**Deploy your own copy to GitHub Pages:**
Fork the repo. The `deploy-pages.yml` workflow publishes `webapp/static/` on every push to `main`. For the CORS-restricted agencies and free AI to work, deploy the Cloudflare Worker in `proxy/` (`cd proxy && npx wrangler deploy`) and point the `PROXY_BASE` constant in `webapp/static/index.html` at your Worker URL. The Worker needs Workers AI enabled (free) for the no-key Free mode.

**Project layout:**
```
webapp/static/index.html   The entire frontend (single file)
webapp/app.py              Optional Flask backend (self-host)
webapp/api/agency_modules/ One module per agency
proxy/worker.js            Cloudflare Worker: CORS relay + free AI
.github/workflows/         Pages deploy, Worker deploy, secret scan
docs/                      Changelog + archived design notes
```

## Developer API

Other apps can pull the same normalized data programmatically:

- **Data API** — `https://opengov-proxy.psjs.workers.dev/api/v1/data/{agency}/{subsection}` returns normalized records (`{title, description, date, link, …}`). Discovery at `/api/v1/agencies`, spec at `/api/v1/openapi.json`.
- **Cross-reference tables** — `/api/db/{table}` joins several agencies into one result set (e.g. `drug-safety`, `cyber-landscape`, `disaster-response`). List them at `/api/db`.
- **Connected-app contract files (repo)** — OpenAPI + JSON Schema: `docs/openapi-contract.yaml`, `docs/schemas/normalized-record.schema.json`, `docs/schemas/data-envelope.schema.json`, `docs/schemas/db-envelope.schema.json`, `docs/schemas/error-envelope.schema.json`.

Most agencies need no key; NASA/Congress/FEC/FBI take your own free [api.data.gov](https://api.data.gov/signup/) key. Full usage docs: **[`/docs/api`](https://selvidge.tech/government-data-fun/docs/api.html)**.

## License

MIT.
