"""FBI Crime Data Explorer - national crime and arrest rates.

Ported from the Worker's normalized data API (proxy/api.js, REGISTRY.fbi).
Needs an api.data.gov key; the caller supplies their own.
"""
import datetime
import requests

CDE = "https://api.usa.gov/crime/fbi/cde"
HEADERS = {'Accept': 'application/json', 'User-Agent': 'OpenGovDash/1.0'}
EXPLORER = "https://cde.ucr.cjis.gov/LATEST/webapp/#/pages/explorer/crime/crime-trend"


def month_range(today=None):
    """CDE takes MM-YYYY. Default to the ten years ending last year, since the
    most recent complete year is the latest with national data."""
    year = (today or datetime.date.today()).year - 1
    return f"01-{year - 9}", f"12-{year}"


def _flatten(rates, label, link, count):
    """CDE returns {offense: {year: value}}. Flatten to one row per year."""
    out = []
    for offense, series in (rates or {}).items():
        if not isinstance(series, dict):
            continue
        for period, value in series.items():
            out.append({
                'title': f"{label} - {offense}",
                'description': f"{period}: {value}",
                'date': str(period),
                'link': link,
                'offense': offense,
                'period': str(period),
                'value': value,
            })
    out.sort(key=lambda r: r['date'], reverse=True)
    return out[:count]


def get_crime(api_key, offense='', count=20):
    if not api_key:
        return [{"error": "FBI Crime Data Explorer requires an api.data.gov key"}]
    try:
        frm, to = month_range()
        offense = (offense or '').strip() or 'violent-crime'
        resp = requests.get(f"{CDE}/summarized/state/national/{offense}",
                            params={'from': frm, 'to': to, 'API_KEY': api_key},
                            headers=HEADERS, timeout=25)
        if resp.status_code == 403:
            return [{"error": "FBI CDE rejected the key"}]
        if resp.status_code != 200:
            return [{"error": f"FBI CDE returned {resp.status_code}"}]
        rates = (resp.json().get('offenses') or {}).get('rates')
        return _flatten(rates, 'United States Offenses', EXPLORER, count)
    except Exception as e:
        return [{"error": str(e)}]


def get_fbi_data(api_key=None, params=None):
    p = params or {}
    return {"results": get_crime(api_key, p.get('query', ''), p.get('limit', 20)),
            "source": "FBI Crime Data Explorer", "endpoint": "National Crime Rates"}


def get_metadata():
    return {
        "name": "FBI Crime Data Explorer",
        "acronym": "FBI",
        "description": "National crime rate trends by offense, from the Uniform Crime Reporting program",
        "endpoints": ["National Crime Rates"],
        "sub_sections": [
            {"id": "crime", "name": "Crime Rates"},
        ],
        "has_search": True,
        "search_placeholder": "Offense slug (e.g. 'violent-crime', 'burglary')...",
        "auth_required": True,
        "base_url": "https://api.usa.gov",
        "data_categories": ["Crime", "Public Safety", "Statistics"]
    }
