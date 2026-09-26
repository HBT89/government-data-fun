"""OpenGovDash - Open Government Data Dashboard Backend"""
from flask import Flask, jsonify, request, send_from_directory, send_file
from flask_cors import CORS
import os
import json
import importlib
import traceback

app = Flask(__name__, static_folder='static')
CORS(app)

# Registry of all agency modules
AGENCY_REGISTRY = {
    'sec': 'api.agency_modules.sec',
    'fda': 'api.agency_modules.fda',
    'treasury': 'api.agency_modules.treasury',
    'usaspending': 'api.agency_modules.usaspending',
    'noaa': 'api.agency_modules.noaa',
    'epa': 'api.agency_modules.epa',
    'census': 'api.agency_modules.census',
    'doj': 'api.agency_modules.doj',
    'bls': 'api.agency_modules.bls',
    'fcc': 'api.agency_modules.fcc',
    'usgs': 'api.agency_modules.usgs',
    'nasa': 'api.agency_modules.nasa',
    'ftc': 'api.agency_modules.ftc',
    'nist': 'api.agency_modules.nist',
    'sam': 'api.agency_modules.sam',
    'fec': 'api.agency_modules.fec',
    'fdic': 'api.agency_modules.fdic',
    'nih': 'api.agency_modules.nih',
    'loc': 'api.agency_modules.loc',
    'nara': 'api.agency_modules.nara',
    'dot': 'api.agency_modules.dot',
    # Ported from the Worker's normalized data API so both
    # implementations cover the same agencies.
    'congress': 'api.agency_modules.congress',
    'fbi': 'api.agency_modules.fbi',
    'fedreg': 'api.agency_modules.fedreg',
    'fema': 'api.agency_modules.fema',
}

# Cache loaded modules
_module_cache = {}

def get_module(agency_id):
    if agency_id not in _module_cache:
        module_path = AGENCY_REGISTRY.get(agency_id)
        if module_path:
            _module_cache[agency_id] = importlib.import_module(module_path)
    return _module_cache.get(agency_id)

@app.route('/')
def index():
    return send_file('static/index.html')

@app.route('/api/agencies', methods=['GET'])
def list_agencies():
    """List all available agencies with metadata."""
    agencies = []
    for agency_id in AGENCY_REGISTRY:
        try:
            mod = get_module(agency_id)
            if mod and hasattr(mod, 'get_metadata'):
                meta = mod.get_metadata()
                meta['id'] = agency_id
                agencies.append(meta)
        except Exception as e:
            agencies.append({'id': agency_id, 'name': agency_id.upper(), 'error': str(e)})
    return jsonify(agencies)

@app.route('/api/data/<agency_id>', methods=['GET'])
def get_agency_data(agency_id):
    """Fetch data from a specific agency."""
    mod = get_module(agency_id)
    if not mod:
        return jsonify({"error": f"Unknown agency: {agency_id}"}), 404

    api_key = request.args.get('api_key', '')
    sub_section = request.args.get('sub_section', '')
    query = request.args.get('query', '')
    limit = request.args.get('limit', type=int)

    params = {}
    if sub_section:
        params['sub_section'] = sub_section
    if query:
        params['query'] = query
    if limit:
        params['limit'] = limit

    # Find the main data function
    func_name = f"get_{agency_id}_data"
    data_func = getattr(mod, func_name, None)
    if not data_func:
        # Try common patterns
        for attr in dir(mod):
            if attr.startswith('get_') and attr.endswith('_data') and callable(getattr(mod, attr)):
                data_func = getattr(mod, attr)
                break

    if not data_func:
        return jsonify({"error": f"No data function found for {agency_id}"}), 500

    try:
        result = data_func(api_key=api_key, params=params)
        # Apply limit to results if the module didn't handle it
        if limit and isinstance(result, dict) and 'results' in result:
            result['results'] = result['results'][:limit]
        return jsonify(result)
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e), "traceback": traceback.format_exc()}), 500

@app.route('/api/chat', methods=['POST'])
def chat():
    """AI chatbot endpoint for cross-referencing data."""
    data = request.json
    message = data.get('message', '')
    api_key = data.get('openai_api_key', '')
    context_data = data.get('context_data', {})
    history = data.get('history', [])

    if not api_key:
        return jsonify({"error": "OpenAI API key required for chat functionality"}), 400

    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key)

        # Build system prompt with context about available data
        system_prompt = """You are an AI assistant for OpenGovDash, a government data dashboard.
You help users analyze, cross-reference, and understand data from multiple US government agencies.

Available agencies and their data:
- SEC: Corporate filings (8-K, 10-K, 10-Q, 13F), company search
- FDA: Drug adverse events, drug/device/food recalls, 510(k) clearances
- Treasury: National debt, daily statements, interest rates, exchange rates
- USAspending: Federal spending, contracts, grants by agency
- NOAA: Weather alerts, forecasts
- EPA: Water systems, regulated facilities, toxic releases
- Census: Population, income by state
- DOJ: Press releases, news, speeches
- BLS: Unemployment, CPI, employment, wages
- FCC: Broadband data, spectrum licenses, consumer complaints
- USGS: Earthquakes, water monitoring
- NASA: Astronomy pictures, near-earth objects, Mars photos
- FTC: Press releases, enforcement cases
- NIST: CVE vulnerability database
- SAM.gov: Federal contract opportunities
- FEC: Campaign finance, candidates, committee filings
- FDIC: Bank financials, bank failures
- NIH: Clinical trials, PubMed research
- LOC: Library of Congress digital collections
- NARA: National Archives records
- DOT/NHTSA: Vehicle recalls, safety complaints

Cross-reference examples:
- FCC device registrations may also appear in FDA 510(k) (medical devices) or FTC enforcement
- SEC filings for pharma companies cross-reference with FDA drug approvals
- EPA facility data connects with SEC environmental disclosures
- FDIC bank data connects with Treasury financial data
- BLS employment data correlates with Census demographics
- USAspending contracts connect with SAM.gov opportunities
- NIST CVEs relate to FCC/FTC cybersecurity enforcement

When the user provides data context, analyze it and provide insights. You can suggest cross-references
between agencies and explain regulatory relationships."""

        if context_data:
            system_prompt += f"\n\nCurrent data context loaded by the user:\n{json.dumps(context_data, indent=2)[:3000]}"

        messages = [{"role": "system", "content": system_prompt}]
        for h in history[-10:]:
            messages.append({"role": h.get('role', 'user'), "content": h.get('content', '')})
        messages.append({"role": "user", "content": message})

        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=messages,
            max_tokens=2000,
            temperature=0.7
        )

        reply = response.choices[0].message.content
        return jsonify({"reply": reply})

    except Exception as e:
        error_msg = str(e)
        status_code = 500
        if '429' in error_msg or 'quota' in error_msg.lower() or 'rate' in error_msg.lower():
            is_project_key = api_key.startswith('sk-proj-') if api_key else False
            if is_project_key:
                error_msg = ('OpenAI quota exceeded. You are using a project-scoped key (sk-proj-...) '
                           'which has its own budget limit. Either increase the project budget at '
                           'platform.openai.com → Settings → Projects, switch to a personal key '
                           '(starts with sk-), or add prepaid credits to your account.')
            else:
                error_msg = ('OpenAI quota exceeded. Check your billing at platform.openai.com → '
                           'Settings → Billing. Newer accounts require prepaid credits before API use.')
            status_code = 429
        return jsonify({"error": error_msg}), status_code

@app.route('/api/cross-reference', methods=['POST'])
def cross_reference():
    """Cross-reference data between agencies."""
    data = request.json
    agencies = data.get('agencies', [])
    query = data.get('query', '')

    results = {}
    for agency_id in agencies:
        mod = get_module(agency_id)
        if mod:
            func_name = f"get_{agency_id}_data"
            data_func = getattr(mod, func_name, None)
            if data_func:
                try:
                    result = data_func(params={'query': query, 'sub_section': ''})
                    results[agency_id] = result
                except Exception as e:
                    results[agency_id] = {"error": str(e)}

    return jsonify(results)

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
