"""Congress.gov - bills in the current Congress.

Ported from the Worker's normalized data API (proxy/api.js, REGISTRY.congress).
Needs an api.data.gov key; the caller supplies their own.
"""
import datetime
import requests

BASE_URL = "https://api.congress.gov/v3"
HEADERS = {'Accept': 'application/json', 'User-Agent': 'OpenGovDash/1.0'}


def current_congress(today=None):
    """The 119th sat from 2025, and a new one begins every second year."""
    year = (today or datetime.date.today()).year
    return 119 + max(0, (year - 2025) // 2)


def get_bills(api_key, query='', count=20):
    if not api_key:
        return [{"error": "Congress.gov requires an api.data.gov key"}]
    try:
        params = {'api_key': api_key, 'limit': count, 'format': 'json', 'sort': 'updateDate+desc'}
        if query:
            params['q'] = query
        resp = requests.get(f"{BASE_URL}/bill/{current_congress()}",
                            params=params, headers=HEADERS, timeout=20)
        if resp.status_code == 403:
            return [{"error": "Congress.gov rejected the key"}]
        if resp.status_code != 200:
            return [{"error": f"Congress.gov returned {resp.status_code}"}]
        results = []
        for x in resp.json().get('bills', [])[:count]:
            action = x.get('latestAction') or {}
            btype = str(x.get('type') or '').lower()
            results.append({
                'title': x.get('title') or f"{x.get('type', '')} {x.get('number', '')}".strip(),
                'description': (action.get('text') or '')[:300],
                'date': action.get('actionDate') or x.get('updateDate', ''),
                'link': f"https://www.congress.gov/bill/{x.get('congress')}th-congress/{btype}-bill/{x.get('number')}",
                'bill_number': x.get('number'),
                'bill_type': x.get('type'),
                'congress': x.get('congress'),
            })
        return results
    except Exception as e:
        return [{"error": str(e)}]


def get_congress_data(api_key=None, params=None):
    p = params or {}
    return {"results": get_bills(api_key, p.get('query', ''), p.get('limit', 20)),
            "source": "Congress.gov", "endpoint": "Recent Bills"}


def get_metadata():
    return {
        "name": "Congress.gov",
        "acronym": "Congress",
        "description": "Bills in the current Congress, with their latest action, from the Library of Congress",
        "endpoints": ["Recent Bills"],
        "sub_sections": [
            {"id": "bills", "name": "Recent Bills"},
        ],
        "has_search": True,
        "search_placeholder": "Search bills by keyword...",
        "auth_required": True,
        "base_url": "https://api.congress.gov",
        "data_categories": ["Legislative", "Government", "Legal"]
    }
