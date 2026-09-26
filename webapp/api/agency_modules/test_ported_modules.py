"""Tests for the four agency modules ported from the Worker's data API.

    python webapp/api/agency_modules/test_ported_modules.py

Covers what can be checked without reaching a government API: the date
arithmetic, the response reshaping, the missing-key path, and the contract
app.py relies on. The live calls themselves are not exercised here.
"""
import datetime
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from api.agency_modules import congress, fbi, fedreg, fema

FAIL = 0


def chk(name, cond, extra=''):
    global FAIL
    print(f"  {'ok  ' if cond else 'FAIL'} {name}{'' if cond else ' :: ' + str(extra)}")
    if not cond:
        FAIL += 1


def main():
    # The 119th Congress sits from 2025, and a new one begins every second year.
    for year, want in [(2024, 119), (2025, 119), (2026, 119), (2027, 120), (2028, 120), (2029, 121)]:
        got = congress.current_congress(datetime.date(year, 6, 1))
        chk(f"congress in {year} is the {want}th", got == want, got)

    # CDE wants MM-YYYY, and the latest complete year is the one before this.
    frm, to = fbi.month_range(datetime.date(2026, 9, 26))
    chk("fbi asks for ten complete years", (frm, to) == ('01-2016', '12-2025'), f"{frm}..{to}")

    rows = fbi._flatten({'violent-crime': {'2023': 10, '2024': 12}}, 'US', 'http://x', 20)
    chk("fbi flattens to one row per period", len(rows) == 2, rows)
    chk("  newest first", rows[0]['period'] == '2024', rows)
    chk("  keeping offense and value", rows[0]['offense'] == 'violent-crime' and rows[0]['value'] == 12)
    chk("  honours the limit", len(fbi._flatten({'a': {'1': 1, '2': 2, '3': 3}}, 'US', 'x', 2)) == 2)
    chk("fbi tolerates no rates at all", fbi._flatten(None, 'US', 'x', 5) == [])
    chk("fbi skips a series that is not a mapping", fbi._flatten({'a': 'nope'}, 'US', 'x', 5) == [])

    # A missing key must be a reported error, not an exception and not a call.
    chk("congress without a key reports an error", 'error' in congress.get_bills('', '')[0])
    chk("fbi without a key reports an error", 'error' in fbi.get_crime('', '')[0])

    # The contract app.py dispatches against.
    need = {'name', 'acronym', 'description', 'endpoints', 'sub_sections',
            'has_search', 'auth_required', 'base_url', 'data_categories'}
    for name, mod in [('congress', congress), ('fbi', fbi), ('fedreg', fedreg), ('fema', fema)]:
        meta = mod.get_metadata()
        chk(f"{name} metadata is complete", need <= set(meta), sorted(need - set(meta)))
        chk(f"  {name} exposes get_{name}_data", callable(getattr(mod, f'get_{name}_data', None)))

    print(f"\n{'FAILED' if FAIL else 'all passed'}")
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
