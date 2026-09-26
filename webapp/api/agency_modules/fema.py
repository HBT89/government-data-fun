"""FEMA - OpenFEMA disaster declarations.

Ported from the Worker's normalized data API (proxy/api.js, REGISTRY.fema).
No key.
"""
import requests

BASE_URL = "https://www.fema.gov/api/open/v2"
HEADERS = {'Accept': 'application/json', 'User-Agent': 'OpenGovDash/1.0'}


def get_disasters(query='', count=20):
    try:
        params = {'$top': count, '$orderby': 'declarationDate desc'}
        if query:
            # OData escapes a single quote by doubling it.
            safe = query.replace("'", "''")
            params['$filter'] = f"contains(declarationTitle, '{safe}') or contains(state, '{safe}')"
        resp = requests.get(f"{BASE_URL}/DisasterDeclarationsSummaries",
                            params=params, headers=HEADERS, timeout=20)
        if resp.status_code != 200:
            return [{"error": f"OpenFEMA returned {resp.status_code}"}]
        results = []
        for x in resp.json().get('DisasterDeclarationsSummaries', [])[:count]:
            bits = [f"State: {x.get('state')}" if x.get('state') else '',
                    f"Type: {x.get('incidentType')}" if x.get('incidentType') else '',
                    f"Area: {x.get('designatedArea')}" if x.get('designatedArea') else '']
            num = x.get('disasterNumber')
            results.append({
                'title': x.get('declarationTitle') or (f"DR-{num}" if num else 'Disaster declaration'),
                'description': ' - '.join(b for b in bits if b),
                'date': x.get('declarationDate', ''),
                'link': f"https://www.fema.gov/disaster/{num}" if num else 'https://www.fema.gov/openfema',
                'disaster_number': num,
                'state': x.get('state', ''),
                'incident_type': x.get('incidentType', ''),
            })
        return results
    except Exception as e:
        return [{"error": str(e)}]


def get_fema_data(api_key=None, params=None):
    p = params or {}
    return {"results": get_disasters(p.get('query', ''), p.get('limit', 20)),
            "source": "FEMA OpenFEMA", "endpoint": "Disaster Declarations"}


def get_metadata():
    return {
        "name": "Federal Emergency Management Agency",
        "acronym": "FEMA",
        "description": "Disaster declarations, incident types and designated areas from OpenFEMA",
        "endpoints": ["Disaster Declarations"],
        "sub_sections": [
            {"id": "disasters", "name": "Disaster Declarations"},
        ],
        "has_search": True,
        "search_placeholder": "Search by title or state (e.g. 'flood', 'CA')...",
        "auth_required": False,
        "base_url": "https://www.fema.gov",
        "data_categories": ["Emergency", "Disaster", "Public Safety"]
    }
