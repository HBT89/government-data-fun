"""Fixture tests for the PTR text parser.

These run against extracted-text fixtures rather than PDFs, so they need
neither pypdf nor network access to the Clerk. The fixtures reproduce the
shapes that pypdf's extraction produces from the House form: the transaction
row as the only reliable landmark, letter-spaced metadata labels reduced to
initials ("F S :", "D :"), and asset names that wrap across lines.

    python tools/test_curated_parser.py

Fixtures are not a substitute for measuring against the real corpus. They pin
the behaviour of each defect that has been diagnosed; the coverage figure still
has to be taken over live filings.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_curated_transactions import parse_text, resolve_ticker, NOT_A_SYMBOL

HEADER = """Name: Hon. Jane Q Doe
Status: Member
State/District: CA12
Filing ID #20034201
ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains > $200?
"""

# Stands in for data/index/xref.json. Only the ticker namespace is consulted.
XREF = {
    "ticker:AAPL": "o:0000320193",
    "ticker:MSFT": "o:0000789019",
    "ticker:BRK-B": "o:0001067983",
    "ticker:T": "o:0000732717",
}

CASES = []


def case(fn):
    CASES.append(fn)
    return fn


def parse(body):
    _, txns = parse_text(HEADER + body)
    return txns


def one(body):
    txns = parse(body)
    assert len(txns) == 1, f"expected 1 transaction, got {len(txns)}: {txns}"
    return txns[0]


# --- regression: the shapes that already worked must keep working -----------

@case
def test_parenthesised_ticker():
    t = one("Apple Inc. (AAPL) [ST] P 01/15/2026 02/01/2026 $1,001 - $15,000\n")
    assert t["tk"] == "AAPL", t
    assert t["tkb"] == "authority:document", t
    assert t["ty"] == "ST", t
    assert t["a"] == "Apple Inc", t          # trailing punctuation is stripped
    assert t["act"] == "P" and t["own"] == "self", t
    assert t["amt"] == "1001-15000", t


@case
def test_partial_sale_and_dates():
    t = one("Apple Inc. (AAPL) [ST] S (partial) 03/01/2026 03/15/2026 $50,001 - $100,000\n")
    assert t["act"] == "Sp", t
    assert t["d"] == "03/01/2026" and t["nd"] == "03/15/2026", t
    assert t["amt"] == "50001-100000", t


@case
def test_no_ticker_keeps_asset_type():
    t = one("Some Private Placement [OL] P 01/15/2026 02/01/2026 $1,001 - $15,000\n")
    assert t["tk"] is None and t["tkb"] is None, t
    assert t["ty"] == "OL", t


# --- defect 1: symbol written without parentheses ---------------------------

@case
def test_bare_symbol_becomes_a_candidate():
    """'Apple Inc AAPL [ST]' yielded no ticker at all before."""
    t = one("Apple Inc AAPL [ST] P 01/15/2026 02/01/2026 $1,001 - $15,000\n")
    assert t["tk"] is None, "a bare symbol is not a ticker until it resolves"
    assert t["tkc"] == "AAPL", t
    assert t["ty"] == "ST", t
    assert t["a"] == "Apple Inc", t


@case
def test_bare_candidate_promotes_when_sec_knows_it():
    t = one("Apple Inc AAPL [ST] P 01/15/2026 02/01/2026 $1,001 - $15,000\n")
    assert resolve_ticker(t["tkc"], XREF) == "o:0000320193"


@case
def test_bare_candidate_is_dropped_when_unknown():
    t = one("Zyzzyva Holdings ZZZZ [ST] P 01/15/2026 02/01/2026 $1,001 - $15,000\n")
    assert t["tkc"] == "ZZZZ", t
    assert resolve_ticker(t["tkc"], XREF) is None, "must not invent a company"


@case
def test_stopword_in_symbol_position_is_not_a_candidate():
    """The risk the parenthesised form does not have: the token before the
    asset-type code is very often an ordinary word."""
    for body, why in [
        ("Vanguard Index COMMON STOCK [ST] P 01/15/2026 02/01/2026 $1,001 - $15,000\n", "STOCK"),
        ("Berkshire Hathaway CLASS B [ST] P 01/15/2026 02/01/2026 $1,001 - $15,000\n", "B"),
        ("Acme Holdings INC [ST] P 01/15/2026 02/01/2026 $1,001 - $15,000\n", "INC"),
    ]:
        t = one(body)
        assert t["tk"] is None and t["tkc"] is None, f"{why} was taken as a symbol: {t}"


@case
def test_mixed_case_word_is_never_a_candidate():
    t = one("Vanguard Total Market Common Stock [ST] P 01/15/2026 02/01/2026 $1,001 - $15,000\n")
    assert t["tkc"] is None, t


@case
def test_parenthesised_form_is_not_read_as_bare():
    t = one("Apple Inc. (AAPL) [ST] P 01/15/2026 02/01/2026 $1,001 - $15,000\n")
    assert t["tkc"] is None, "the parenthesised branch should own this row"


# --- defect 2: asset name absorbed into the description above it ------------

@case
def test_wrapped_name_after_a_description():
    """The reported case: 'Common Stock' instead of the full name, because the
    first line of the name fell inside the previous transaction's description."""
    t = parse(
        "Apple Inc. (AAPL) [ST] P 01/15/2026 02/01/2026 $1,001 - $15,000\n"
        "F S : New\n"
        "S O : Fidelity Brokerage\n"
        "D : Purchased at $185.50/share\n"
        "Berkshire Hathaway Inc. Class B\n"
        "Common Stock (BRK.B) [ST] S 01/20/2026 02/01/2026 $15,001 - $50,000\n"
    )[1]
    assert t["a"] == "Berkshire Hathaway Inc. Class B Common Stock", t
    assert t["tk"] == "BRK.B", t


@case
def test_description_prose_stays_out_of_the_name():
    """The other side of the same fix: prose must not be pulled into the name."""
    t = parse(
        "Apple Inc. (AAPL) [ST] P 01/15/2026 02/01/2026 $1,001 - $15,000\n"
        "F S : New\n"
        "D : sold @ $27.645/share BRK/B - 3 shares\n"
        "part of a scheduled rebalance of the account\n"
        "Microsoft Corporation (MSFT) [ST] S 01/20/2026 02/01/2026 $1,001 - $15,000\n"
    )[1]
    assert t["a"] == "Microsoft Corporation", t


@case
def test_multiline_name_after_multiline_prose():
    t = parse(
        "Apple Inc. (AAPL) [ST] P 01/15/2026 02/01/2026 $1,001 - $15,000\n"
        "D : Purchased 40 shares at $185.50 per share through a\n"
        "standing limit order placed in December\n"
        "Alphabet Inc. Class A\n"
        "Capital Stock (GOOGL) [ST] P 01/22/2026 02/01/2026 $1,001 - $15,000\n"
    )[1]
    assert t["a"] == "Alphabet Inc. Class A Capital Stock", t


# --- owner attribution ------------------------------------------------------

@case
def test_owner_code_beside_the_row():
    t = one("Apple Inc. (AAPL) [ST] SP P 01/15/2026 02/01/2026 $1,001 - $15,000\n")
    assert t["own"] == "SP", t


@case
def test_owner_code_at_the_head_of_the_name():
    """Extraction puts the Owner column ahead of the asset name. The code was
    being stripped off the display name and thrown away, so the holding was
    recorded as the filer's own."""
    t = one("SP Apple Inc. (AAPL) [ST] P 01/15/2026 02/01/2026 $1,001 - $15,000\n")
    assert t["own"] == "SP", t
    assert t["a"] == "Apple Inc", t


@case
def test_absent_owner_is_the_filer():
    t = one("Apple Inc. (AAPL) [ST] P 01/15/2026 02/01/2026 $1,001 - $15,000\n")
    assert t["own"] == "self", t


# --- share-class punctuation ------------------------------------------------

@case
def test_share_class_separator_is_normalised():
    assert resolve_ticker("BRK.B", XREF) == "o:0001067983"
    assert resolve_ticker("BRK-B", XREF) == "o:0001067983"
    assert resolve_ticker("NOPE", XREF) is None


@case
def test_single_letter_symbols_stay_out_of_the_stoplist_by_accident():
    """'T' is a real ticker but also a stray initial. It is stoplisted only
    where it would be ambiguous; confirm the stoplist is what we think it is."""
    assert "T" not in NOT_A_SYMBOL
    assert {"A", "B", "STOCK", "CLASS", "INC"} <= NOT_A_SYMBOL


# --- known limitation ------------------------------------------------------

@case
def test_capitalised_prose_without_signals_is_still_absorbed():
    """Documents where the new boundary rule stops.

    A description line is given back to the asset name when it carries no
    figure, rate, share count, verb or lowercase start. A capitalised fragment
    with none of those is indistinguishable from the first line of a name on
    line structure alone, so it is still read as part of the name. This is the
    residual error of the fix, recorded rather than hidden: it trades a
    truncated name, which was silent, for an over-long one, which is visible.
    Settling it needs the real corpus, not another fixture.
    """
    t = parse(
        "Apple Inc. (AAPL) [ST] P 01/15/2026 02/01/2026 $1,001 - $15,000\n"
        "D : Rebalance\n"
        "Scheduled quarterly review\n"
        "Microsoft Corporation (MSFT) [ST] S 01/20/2026 02/01/2026 $1,001 - $15,000\n"
    )[1]
    assert t["a"] == "Scheduled quarterly review Microsoft Corporation", t
    assert t["tk"] == "MSFT", "the join to the org entity is unaffected"


def main():
    failed = []
    for fn in CASES:
        try:
            fn()
            print(f"  ok   {fn.__name__}")
        except AssertionError as e:
            failed.append((fn.__name__, e))
            print(f"  FAIL {fn.__name__}: {e}")
    print(f"\n{len(CASES) - len(failed)}/{len(CASES)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
