"""Parses House PTR PDFs into transactions and joins assets to org entities.

Curated tier. This reads the public index, fetches the documents it points at,
and produces the contents of those filings. It writes to --out, which defaults
to ./curated and is gitignored here: this output is not part of the public
index.

    python tools/build_curated_transactions.py [--out curated] [--limit N]

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
except ImportError:
    sys.exit("pypdf is required: pip install pypdf")

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
    reader = PdfReader(path)
    raw = "\n".join((p.extract_text() or "") for p in reader.pages)
    flat = clean(raw)

    header = {
        "name": (HEADER_NAME.search(flat).group(1).split(" Status:")[0].strip()
                 if HEADER_NAME.search(flat) else None),
        "status": (HEADER_STATUS.search(flat).group(1).split(" State/District:")[0].strip()
                   if HEADER_STATUS.search(flat) else None),
        "district": (HEADER_DISTRICT.search(flat).group(1) if HEADER_DISTRICT.search(flat) else None),
        "filing_id": (FILING_ID.search(raw).group(1) if FILING_ID.search(raw) else None),
        "pages": len(reader.pages),
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
    for i, l in enumerate(lines):
        if is_meta[i]:
            desc = l.lstrip().startswith("D")
            in_desc[i] = True
        elif desc:
            # Prose continues until a line that looks like the next asset.
            if ASSET_HINT.search(l):
                desc = False
            else:
                in_desc[i] = True

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
        asset_type = tick.group(2) if tick else (bare.group(1) if bare else None)
        display = (TICKER.sub("", name) if tick else BARE_TYPE.sub("", name))
        # The owner code sits in the Owner column, which extraction places ahead
        # of the asset name rather than beside the row. Captured separately, so
        # strip it here instead of leaving it in the display name.
        owner_prefix = re.match(r"^(SP|DC|JT)\b\s*", display)
        if owner_prefix:
            display = display[owner_prefix.end():]
        display = re.sub(r"\s+", " ", display).strip(" .,-")

        txns.append({
            "a": display or None,
            "tk": ticker,
            "ty": asset_type,
            "own": m.group("owner") or "self",
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", default="data")
    ap.add_argument("--out", default="curated")
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

    pct = lambda a, b: f"{(100 * a / b):.1f}%" if b else "n/a"
    print(f"\n{stats['filings_parsed']} filings parsed, {stats['filings_failed']} failed, "
          f"{stats['filings_zero_txn']} yielded no transactions")
    print(f"{stats['transactions']} transactions")
    print(f"  with ticker      {stats['with_ticker']} ({pct(stats['with_ticker'], stats['transactions'])})")
    print(f"  resolved to org  {stats['resolved_org']} ({pct(stats['resolved_org'], stats['transactions'])})")
    print(f"  ticker unresolved {stats['unresolved_ticker']}")
    print(f"  scanned PTRs skipped {stats['skipped_scanned']}")
    if stats["id_mismatch"]:
        print(f"  FILING ID MISMATCHES {stats['id_mismatch']}")
    if unresolved:
        top = sorted(unresolved.items(), key=lambda kv: -kv[1])[:12]
        print("  most common unresolved tickers: " + ", ".join(f"{k}({v})" for k, v in top))


if __name__ == "__main__":
    main()
