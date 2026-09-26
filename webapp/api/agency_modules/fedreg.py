"""Federal Register - daily journal of the US government.

Ported from the Worker's normalized data API (proxy/api.js, REGISTRY.fedreg)
so the Flask backend and the deployed front end cover the same agency. No key.
"""
import requests

BASE_URL = "https://www.federalregister.gov/api/v1"
HEADERS = {'Accept': 'application/json', 'User-Agent': 'OpenGovDash/1.0'}


def _documents(query='', count=20, presidential_only=False):
    try:
        params = {'per_page': count, 'order': 'newest', 'format': 'json'}
        if query:
            params['conditions[term]'] = query
        if presidential_only:
            params['conditions[type][]'] = 'PRESDOCU'
        resp = requests.get(f"{BASE_URL}/documents", params=params, headers=HEADERS, timeout=20)
        if resp.status_code != 200:
            return [{"error": f"Federal Register returned {resp.status_code}"}]
        results = []
        for x in resp.json().get('results', [])[:count]:
            agencies = ', '.join(a.get('name', '') for a in (x.get('agencies') or []) if a.get('name'))
            abstract = x.get('abstract') or ''
            desc = f"{agencies} - {abstract}" if agencies and abstract else (agencies or abstract)
            results.append({
                'title': x.get('title') or '(no title)',
                'description': desc[:280],
                'date': x.get('publication_date', ''),
                'link': x.get('html_url') or x.get('pdf_url') or 'https://www.federalregister.gov/',
                'document_number': x.get('document_number', ''),
                'type': x.get('type', ''),
            })
        return results
    except Exception as e:
        return [{"error": str(e)}]


def get_fedreg_data(api_key=None, params=None):
    p = params or {}
    query = p.get('query', '')
    count = p.get('limit', 20)
    if p.get('sub_section') == 'executive_orders':
        return {"results": _documents(query, count, presidential_only=True),
                "source": "Federal Register", "endpoint": "Executive Orders"}
    return {"results": _documents(query, count),
            "source": "Federal Register", "endpoint": "Documents"}


def get_metadata():
    return {
        "name": "Federal Register",
        "acronym": "FedReg",
        "description": "Daily journal of the US government - rules, proposed rules, notices and presidential documents",
        "endpoints": ["Documents", "Executive Orders"],
        "sub_sections": [
            {"id": "documents", "name": "Documents"},
            {"id": "executive_orders", "name": "Executive Orders"},
        ],
        "has_search": True,
        "search_placeholder": "Search the Federal Register (e.g. 'emissions')...",
        "auth_required": False,
        "base_url": "https://www.federalregister.gov",
        "data_categories": ["Regulatory", "Legal", "Government"]
    }
