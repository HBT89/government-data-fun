"""Parses House PTR PDFs into transactions and joins assets to org entities.

Curated tier. This reads the public index, fetches the documents it points at,
and produces the contents of those filings. It writes to --out, which defaults
to ./curated and is gitignored here: this output is not part of the public
index.

    python tools/build_curated_transactions.py [--out curated] [--limit N]

--out defaults to $CURATED_OUT, then ./curated, which is gitignored here.
Point it at a clone of the private curated repository to publish there.

Python rather than Node, unlike the rest of tools/, because extracting text
from a PDF needs a real dependency either way and the repo already carries a
Python toolchain. Only pypdf is required.

The 5 U.S.C. app. 105(c) restriction recorded on filing.json applies to
everything produced here.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone

try:
    from pypdf import PdfReader
except ImportError:                    # only the PDF reader needs it; the text
    PdfReader = None                   # logic is importable and testable without

UA = os.environ.get("HOUSE_USER_AGENT", "OpenGovDash XrefIndex/1.0 (contact@opengov.dev)")

# A transaction row. Anchoring on this rather than walking lines is deliberate:
# the asset name wraps across lines unpredictably, and sometimes shares a line
# with the transaction itself, so the row is the only reliable landmark.
#   owner   SP spouse, DC dependent child, JT joint; absent means the filer
#   action  P purchase, S sale, E exchange; S (partial) is a partial sale
TXN = re.compile(
    r"(?:^|\s)(?P<owner>SP|DC|JT)?\s*"
    r"(?P<action>P|S|E)(?P<partial>\s*\(partial\))?\s+"
    r"(?P<date>\d{2}/\d{2}/\d{4})\s+"
    r"(?P<notified>\d{2}/\d{2}/\d{4})\s+"
    r"(?P<low>\$[\d,]+)\s*-\s*(?P<high>\$[\d,]+)",
)

# Ticker and asset-type code, e.g. "(AMZN) [ST]". The two can be separated by a
# line break, which whitespace normalisation collapses to a single space.
TICKER = re.compile(r"\(([A-Z][A-Z0-9.\-]{0,5})\)\s*\[([A-Z]{2})\]")
BARE_TYPE = re.compile(r"\[([A-Z]{2})\]")

# The same symbol written without the parentheses the form asks for, e.g.
# "Apple Inc AAPL [ST]". The bracket is the anchor: the symbol is the token
# immediately before the asset-type code.
#
# This shape cannot be trusted on its own the way the parenthesised one can.
# "COMMON STOCK [ST]" and "CLASS A [ST]" both present a plausible symbol in the
# same position, so a candidate found here is only promoted to a ticker once it
# resolves against the SEC ticker list. An unresolvable candidate is dropped
# rather than recorded: a miss stays a miss rather than becoming a wrong company.
BARE_TICKER = re.compile(r"(?:^|\s)([A-Z][A-Z0-9.\-]{0,5})\s*\[([A-Z]{2})\]")

# All-caps words that occupy the symbol position but never are one. Checked
# before the xref, so a company that genuinely trades as one of these is still
# not read out of a bare token.
NOT_A_SYMBOL = {
    "A", "B", "C", "I", "II", "III", "AND", "OR", "THE", "OF",
    "INC", "LLC", "LLP", "LP", "LTD", "PLC", "CO", "CORP", "SA", "AG", "NV",
    "COMMON", "STOCK", "SHARES", "SHARE", "CLASS", "SERIES", "UNITS", "UNIT",
    "FUND", "FUNDS", "TRUST", "ETF", "REIT", "ADR", "IRA", "US", "USA", "NA",
    "BOND", "BONDS", "NOTE", "NOTES", "CD", "MUTUAL", "INDEX", "GROWTH",
}

HEADER_NAME = re.compile(r"Name:\s*(.+)")
HEADER_STATUS = re.compile(r"Status:\s*(.+)")
HEADER_DISTRICT = re.compile(r"State/District:\s*([A-Z]{2}\d{2})")
FILING_ID = re.compile(r"Filing ID #(\d+)")

# Page furniture that repeats on every page and would otherwise land inside an
# asset name.
NOISE = [
    re.compile(r"ID Owner Asset Transaction\s*Type\s*Date Notification\s*Date\s*Amount Cap\.\s*Gains >\s*\$200\?"),
    re.compile(r"Filing ID #\d+"),
    re.compile(r"\* For the complete list of asset type abbreviations.*?aspx\."),
    re.compile(r"Clerk of the House of Representatives.*?DC 20515"),
    re.compile(r"Digitally Signed:.*?\d{2}/\d{4}"),
    re.compile(r"I CERTIFY that.*?STOCK Act\.", re.S),
]


# Metadata labels that follow a transaction row. Their names are letter-spaced
# in the PDF ("FILING STATUS"), so extraction leaves only initials separated by
# the spaces the NULs became: "F S :", "S O :", "D :".
META_LABEL = re.compile(r"^[A-Z](\s+[A-Z])*\s*:")
# Column headers and other page furniture. Every alternative is a whole-line
# match: a prefix match here is dangerous, because a bare "T" would swallow
# every asset whose name begins with one.
FURNITURE = re.compile(
    r"(?:ID Owner Asset Transaction|Type|Date Notification|Date|Amount Cap\.|Gains >|\$200\?"
    r"|Yes\s+No|[A-Z](?:\s+[A-Z])*)",          # trailing case: spaced initials, e.g. "P T R"
)
# These identify their line by prefix rather than by the whole line.
FURNITURE_PREFIX = re.compile(
    r"^(?:Name:|Status:|State/District:|Filing ID #|\* For the complete list"
    r"|Clerk of the House|Digitally Signed:|I CERTIFY|my knowledge)"
)
# Description continuation, e.g. "sold @ $27.645/share BRK/B - 3 shares".
# Only used to decide whether a line inside a description is prose or the start
# of the next asset.
ASSET_HINT = re.compile(r"\([A-Z][A-Z0-9.\-]{0,5}\)|\[[A-Z]{2}\]")
# Marks a line as description prose rather than the start of the next asset
# name. A description has no terminator, so the run after "D :" is only closed
# by the next line carrying an asset hint. When the asset name wraps, its first
# line has no hint and would be swallowed by that run, which is what turns
# "Berkshire Hathaway Inc. Class B / Common Stock (BRK.B) [ST]" into a bare
# "Common Stock". These are the signals that a line is prose: a figure, a rate,
# a share count, a transaction verb, or a lowercase start, which only happens
# mid-sentence. A line carrying none of them, sitting directly above the hint
# line, is read back as part of the name.
PROSE = re.compile(
    r"[$@%]|/\s*share|\bshares?\b|\bper\b"
    r"|\b(?:sold|bought|purchased|acquired|exchanged|held|owned|gifted"
    r"|transferred|received|matured|redeemed|reinvest\w*|distribut\w*)\b",
    re.I,
)
# The lowercase-start test has to stay case-sensitive, so it is applied apart
# from the case-insensitive body above.
PROSE_LOWER_START = re.compile(r"^[a-z]")


def is_prose(line):
    """True when a line inside a description run reads as continuing prose."""
    return bool(PROSE_LOWER_START.match(line) or PROSE.search(line))


def clean_lines(text):
    """Normalise spacing but keep line structure.

    The flat-text approach loses the only reliable signal for where an asset
    name starts: the line break before it. Descriptions are free text with no
    terminator, so without lines an asset name cannot be separated from the
    description of the transaction above it.
    """
    text = text.replace("\x00", " ").replace("’", "'").replace("�", " ")
    out = []
    for line in text.split("\n"):
        line = re.sub(r"[ \t]+", " ", line).strip()
        # FURNITURE lists the column header in the fragments extraction usually
        # breaks it into. When it survives as one line instead, none of those
        # fullmatch, and the whole header is walked back into the first asset
        # name of the filing. NOISE already has the pattern for the intact
        # header, so strip it here before the fullmatch tests.
        line = NOISE[0].sub(" ", line).strip()
        if not line or FURNITURE.fullmatch(line) or FURNITURE_PREFIX.match(line):
            continue
        out.append(line)
    return out


def clean(text):
    text = text.replace("\x00", " ")
    text = text.replace("’", "'").replace("�", " ")
    for pat in NOISE:
        text = pat.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()


def amount_band(low, high):
    to_int = lambda s: int(s.replace("$", "").replace(",", ""))
    return f"{to_int(low)}-{to_int(high)}"


def parse_pdf(path):
    if PdfReader is None:
        sys.exit("pypdf is required: pip install pypdf")
    reader = PdfReader(path)
    raw = "\n".join((p.extract_text() or "") for p in reader.pages)
    return parse_text(raw, pages=len(reader.pages))


def parse_text(raw, pages=None):
    """Parse already-extracted PDF text. Split out from parse_pdf so the line
    handling, which is where the accuracy lives, can be tested against fixtures
    without a PDF and without network access to the Clerk."""
    flat = clean(raw)

    header = {
        "name": (HEADER_NAME.search(flat).group(1).split(" Status:")[0].strip()
                 if HEADER_NAME.search(flat) else None),
        "status": (HEADER_STATUS.search(flat).group(1).split(" State/District:")[0].strip()
                   if HEADER_STATUS.search(flat) else None),
        "district": (HEADER_DISTRICT.search(flat).group(1) if HEADER_DISTRICT.search(flat) else None),
        "filing_id": (FILING_ID.search(raw).group(1) if FILING_ID.search(raw) else None),
        "pages": pages,
        "chars": len(flat),
    }

    # Two passes over the same cleaned lines, because neither view alone is
    # sufficient. A transaction row can wrap across a line break, so rows are
    # found in the joined text for full recall. An asset name can only be
    # separated from the free-prose description above it by the line break
    # before it, so names are recovered from the line structure.
    lines = clean_lines(raw)

    joined = ""
    owner_line = []                      # for each char in joined, its line index
    for idx, line in enumerate(lines):
        if joined:
            joined += " "
            owner_line.append(idx)
        joined += line
        owner_line.extend([idx] * len(line))

    # Classify each line once: does it end a name, or is it prose to discard?
    is_meta = [bool(META_LABEL.match(l)) for l in lines]
    in_desc = [False] * len(lines)
    desc = False
    run = []                             # lines provisionally taken as prose
    for i, l in enumerate(lines):
        if is_meta[i]:
            desc = l.lstrip().startswith("D")
            in_desc[i] = True
            run = []
        elif desc:
            # Prose continues until a line that looks like the next asset. That
            # line is not where the name begins, though: a wrapped asset name
            # puts its first line above the one carrying the ticker, with no
            # hint of its own, and the forward pass has just marked it prose.
            # Give back the trailing lines of the run that carry no prose
            # signal, which is what keeps "Berkshire Hathaway Inc. Class B"
            # attached to the "Common Stock (BRK.B) [ST]" line beneath it.
            if ASSET_HINT.search(l):
                desc = False
                while run and not is_prose(lines[run[-1]]):
                    in_desc[run.pop()] = False
                run = []
            else:
                in_desc[i] = True
                run.append(i)

    txns = []
    consumed_to = -1                     # last line already absorbed into a name
    for m in TXN.finditer(joined):
        li = owner_line[m.start()] if m.start() < len(owner_line) else len(lines) - 1

        # Walk back from the row's line, collecting name lines until a metadata
        # label, a description line, or a line already used by an earlier row.
        parts = []
        # Text on the row's own line before the match belongs to the name.
        line_start = m.start()
        while line_start > 0 and owner_line[line_start - 1] == li:
            line_start -= 1
        head = joined[line_start:m.start()].strip()
        if head:
            parts.append(head)
        j = li - 1
        while j > consumed_to and j >= 0 and not is_meta[j] and not in_desc[j]:
            parts.append(lines[j])
            j -= 1
        consumed_to = li
        name = re.sub(r"\s+", " ", " ".join(reversed(parts))).strip(" .,-")

        tick = TICKER.search(name)
        bare = BARE_TYPE.search(name)
        ticker = tick.group(1) if tick else None
        # Parentheses missing: take the token in front of the asset-type code as
        # a candidate only. It stays a candidate until it resolves in main().
        cand = None if tick else BARE_TICKER.search(name)
        candidate = cand.group(1) if cand and cand.group(1) not in NOT_A_SYMBOL else None
        asset_type = tick.group(2) if tick else (bare.group(1) if bare else None)
        if tick:
            display = TICKER.sub("", name)
        elif candidate:
            display = BARE_TICKER.sub("", name)
        else:
            display = BARE_TYPE.sub("", name)
        # The owner code sits in the Owner column, which extraction places ahead
        # of the asset name rather than beside the row. Captured separately, so
        # strip it here instead of leaving it in the display name.
        # The Owner column is printed to the left of the asset, so extraction can
        # place the code at the head of the name rather than beside the row,
        # where TXN would have captured it. It was already being stripped off
        # the display name; read it before discarding it, otherwise a spouse or
        # dependent-child holding is silently recorded as the filer's own. The
        # code beside the row wins when both are present.
        owner_prefix = re.match(r"^(SP|DC|JT)\b\s*", display)
        if owner_prefix:
            display = display[owner_prefix.end():]
        owner = m.group("owner") or (owner_prefix.group(1) if owner_prefix else None)
        display = re.sub(r"\s+", " ", display).strip(" .,-")

        txns.append({
            "a": display or None,
            "tk": ticker,
            # How the symbol was established, in the same vocabulary the index
            # uses: the document printed it in the slot the form reserves for
            # it, or it was inferred from a bare token and confirmed against
            # SEC's ticker list. Set for a candidate once it resolves.
            "tkb": "authority:document" if ticker else None,
            "tkc": candidate,
            "ty": asset_type,
            "own": owner or "self",
            "act": m.group("action") + ("p" if m.group("partial") else ""),
            "d": m.group("date"),
            "nd": m.group("notified"),
            "amt": amount_band(m.group("low"), m.group("high")),
        })
    return header, txns


def resolve_ticker(tk, xref):
    """Look up a ticker in the public xref, tolerating share-class punctuation.

    SEC's company_tickers.json writes share classes with a hyphen (BRK-B); PTR
    documents write them with a dot (BRK.B). Same security, same CIK. Only the
    separator is normalised: no other spelling is guessed at, so a miss stays a
    miss rather than becoming a wrong company.
    """
    hit = xref.get(f"ticker:{tk}")
    if hit:
        return hit
    if "." in tk or "-" in tk:
        swapped = tk.replace(".", "-") if "." in tk else tk.replace("-", ".")
        return xref.get(f"ticker:{swapped}")
    return None


def fetch(url, cache_dir, sleep):
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, url.rsplit("/", 1)[-1])
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path, True
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r, open(path, "wb") as f:
        f.write(r.read())
    time.sleep(sleep)          # the Clerk is a public service, not a CDN
    return path, False


CURATED_README = """# Curated tier

Parsed contents of House periodic transaction reports, with assets joined to
organization entities by ticker. Generated by `tools/build_curated_transactions.py`
in the public index repository; this directory holds its output.

**This is not the public index.** The public tier records that a filing exists,
who filed it and where the PDF is. This tier is the contents of those filings:
original selection and arrangement over public facts, and a separate product.

Every transaction carries how its symbol was established:

- `authority:document` -- the document printed the symbol in the slot the form
  reserves for it.
- `match:bare-symbol` -- the parentheses were missing, so the token in front of
  the asset-type code was read and then confirmed against SEC's ticker list. An
  unconfirmed token is dropped rather than recorded.

Regenerate rather than edit. Nothing here is hand-maintained.

## Use restriction

{restriction}

That provision binds each person who obtains or uses a report, independently.
Holding this data in a private repository does not discharge it, and
redistributing it does not transfer it.
"""


def write_readme(out, restriction):
    """Leave the output directory self-describing.

    When --out points at the private curated repository, that repository should
    say what it holds and under what restriction without depending on anyone
    remembering to write it down. Only written when absent, so edits survive a
    rebuild.
    """
    path = os.path.join(out, "README.md")
    if os.path.exists(path):
        return
    body = CURATED_README.format(restriction=restriction or "See the public index.")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(body)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", default="data")
    # Defaults to ./curated, which is gitignored here. Point it at a clone of
    # the private curated repository to publish there instead; CURATED_OUT
    # keeps that path out of every command line.
    ap.add_argument("--out", default=os.environ.get("CURATED_OUT", "curated"))
    ap.add_argument("--limit", type=int, default=0, help="0 means every eligible filing")
    ap.add_argument("--sleep", type=float, default=0.4)
    args = ap.parse_args()

    with open(os.path.join(args.index, "entities", "filing.json"), encoding="utf-8") as f:
        filings = json.load(f)
    with open(os.path.join(args.index, "index", "xref.json"), encoding="utf-8") as f:
        xref = json.load(f)["xref"]

    # Only PTRs, only the ones predicted to carry a text layer. The scanned
    # minority is left for an OCR stage and is counted, not silently dropped.
    eligible = [(ref, e) for ref, e in filings["entities"].items()
                if e["k"] == "ptr" and e.get("text") is True]
    skipped_scan = sum(1 for e in filings["entities"].values()
                       if e["k"] == "ptr" and e.get("text") is not True)
    if args.limit:
        eligible = eligible[:args.limit]

    cache = os.path.join(args.out, ".cache")
    docs, stats = {}, {
        "filings_parsed": 0, "filings_failed": 0, "filings_zero_txn": 0,
        "transactions": 0, "with_ticker": 0, "resolved_org": 0,
        "unresolved_ticker": 0, "id_mismatch": 0, "skipped_scanned": skipped_scan,
        "cached": 0, "downloaded": 0,
        "bare_symbol_promoted": 0, "bare_symbol_dropped": 0,
    }
    unresolved = {}

    for n, (ref, e) in enumerate(eligible, 1):
        try:
            path, was_cached = fetch(e["url"], cache, args.sleep)
            stats["cached" if was_cached else "downloaded"] += 1
            header, txns = parse_pdf(path)
        except Exception as exc:
            stats["filings_failed"] += 1
            sys.stderr.write(f"  {ref}: {type(exc).__name__}: {exc}\n")
            continue

        # The document states its own filing id. If it disagrees with the index
        # the pairing is wrong and nothing downstream should trust it.
        doc_id = ref.split(":", 1)[1]
        if header["filing_id"] and header["filing_id"] != doc_id:
            stats["id_mismatch"] += 1
            sys.stderr.write(f"  {ref}: document says filing id {header['filing_id']}\n")
            continue

        for t in txns:
            stats["transactions"] += 1
            cand = t.pop("tkc", None)
            # A bare token is a ticker only if SEC knows it. Promote before the
            # counting below, so a promoted symbol is counted exactly like a
            # parenthesised one and the coverage figure keeps one meaning.
            if not t["tk"] and cand:
                if resolve_ticker(cand, xref):
                    t["tk"], t["tkb"] = cand, "match:bare-symbol"
                    stats["bare_symbol_promoted"] += 1
                else:
                    stats["bare_symbol_dropped"] += 1
            if t["tk"]:
                stats["with_ticker"] += 1
                org = resolve_ticker(t["tk"], xref)
                if org:
                    t["o"] = org
                    stats["resolved_org"] += 1
                else:
                    stats["unresolved_ticker"] += 1
                    unresolved[t["tk"]] = unresolved.get(t["tk"], 0) + 1

        if not txns:
            stats["filings_zero_txn"] += 1
        stats["filings_parsed"] += 1
        docs[ref] = {"f": e.get("f"), "dt": e.get("dt"), "st": e.get("st"), "d": e.get("d"),
                     "src": e["url"], "n": len(txns), "tx": txns}

        if n % 50 == 0:
            sys.stdout.write(f"  {n}/{len(eligible)} filings, {stats['transactions']} transactions\n")
            sys.stdout.flush()

    out_doc = {
        "v": 1,
        "kind": "transaction",
        "tier": "curated",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "note": "Parsed contents of House periodic transaction reports, with assets joined to org entities by ticker. Derived from the public filing index.",
        "use_restriction": filings.get("use_restriction"),
        "stats": stats,
        "count": len(docs),
        "filings": docs,
    }
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "transactions.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(out_doc, f, indent=2)
        f.write("\n")
    write_readme(args.out, filings.get("use_restriction"))

    pct = lambda a, b: f"{(100 * a / b):.1f}%" if b else "n/a"
    print(f"\n{stats['filings_parsed']} filings parsed, {stats['filings_failed']} failed, "
          f"{stats['filings_zero_txn']} yielded no transactions")
    print(f"{stats['transactions']} transactions")
    print(f"  with ticker      {stats['with_ticker']} ({pct(stats['with_ticker'], stats['transactions'])})")
    print(f"  resolved to org  {stats['resolved_org']} ({pct(stats['resolved_org'], stats['transactions'])})")
    print(f"    of which from a bare symbol {stats['bare_symbol_promoted']}")
    print(f"  ticker unresolved {stats['unresolved_ticker']}")
    print(f"  bare symbols dropped as unrecognised {stats['bare_symbol_dropped']}")
    print(f"  scanned PTRs skipped {stats['skipped_scanned']}")
    if stats["id_mismatch"]:
        print(f"  FILING ID MISMATCHES {stats['id_mismatch']}")
    if unresolved:
        top = sorted(unresolved.items(), key=lambda kv: -kv[1])[:12]
        print("  most common unresolved tickers: " + ", ".join(f"{k}({v})" for k, v in top))


if __name__ == "__main__":
    main()
