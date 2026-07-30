#!/usr/bin/env python3
"""Assert that the DEPLOYED contact card is a well-formed, CRLF-delimited vCard.

    cd infra
    python3 served_card_assertions.py                        # against the live web service
    python3 served_card_assertions.py --base-url https://…

WHY THIS EXISTS — B-025. The card was served for a full deployment as 147 bytes with **0 CR
and 6 bare LF**, and `file(1)` rejected it ("lines not separated by CRLF"), while
`renderContactCard` produced 153/6/0 and its own CRLF assertion passed. The build was the
culprit: the minifier folded `.join("\\r\\n")` into a single template literal and wrote the
separators as *raw CR and LF bytes in the source*, which ECMA-262 normalizes to a bare LF at
parse time (§12.9.6). The CR was gone before the string existed at runtime.

WHY IT IS A SEPARATE CHECK FROM `deploy_assertions.py`. That script is metadata-only — it
compares revision timestamps against secret version timestamps and never makes an HTTP request.
This one is the opposite kind of check: it reads the RESPONSE BYTES off the wire. Keeping them
apart preserves that split, and it means a card regression is diagnosed as a card regression
rather than as a mysterious failure inside a secret-freshness script.

WHY BYTES AND NOT A PARSED CARD. The failure mode is invisible to anything that parses. A
bare-LF card still contains every property, still has the right display name and the right
number, and still downloads with a 200 and the right media type. Every check short of counting
the separator bytes passes. What it does NOT do is open the add-contact sheet — iOS and Android
reject it by doing *nothing at all*, which is also exactly what a working tap looks like to
anyone not watching closely. So the assertion is on the bytes.

WHAT IT DOES NOT PROVE. That a real handset accepts the card. A physical tap remains the
deciding test (RUNBOOK §Deploy), because "opens nothing" is the failure mode and no synthetic
check can observe a phone's address book. This closes the gap that made B-025 survive a deploy
unnoticed; it does not replace the handset.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from dataclasses import dataclass, field

BASE_URL = "https://farm-friend-web-p5mfxfp5za-uw.a.run.app"
CARD_PATH = "/api/public/contact-card"

# The properties a vCard 3.0 contact card must carry, in the order the card states them. Order
# matters to a parser: it reads BEGIN first and stops at END, and VERSION must precede the
# content properties.
REQUIRED_PROPERTIES = (
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:",
    "N:",
    "ORG:",
    "TEL;",
    "END:VCARD",
)


@dataclass
class Verdict:
    ok: bool
    problems: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def evaluate(body: bytes, content_type: str | None) -> Verdict:
    """Judge the served card from its raw bytes.

    Pure — no network, no clock, no environment. Everything that decides the verdict is an
    argument, which is what lets the tests reproduce the exact B-025 payload byte for byte.
    """
    problems: list[str] = []
    notes: list[str] = []

    # An empty body means the REQUEST failed, not that the card is fine. Reporting "no problems
    # found" for bytes that were never read is the green-because-it-looked-at-nothing shape this
    # repo keeps finding.
    if not body:
        return Verdict(
            ok=False,
            problems=["the response body was EMPTY — the request failed; not a passing state"],
        )

    # The media type is half the mechanism: without `text/vcard` a browser renders the card as
    # a page of text instead of handing it to Contacts, and the tap appears to do nothing.
    if content_type is None or "text/vcard" not in content_type.lower():
        problems.append(
            f"content-type is {content_type!r}, which does not contain `text/vcard` — "
            "a browser will render the card as text instead of opening the add-contact sheet"
        )

    # THE B-025 ASSERTION. Counted on the raw bytes, because this is the one property that no
    # parse, no status code, and no header can reveal.
    crlf = body.count(b"\r\n")
    bare_lf = body.count(b"\n") - crlf
    if bare_lf:
        problems.append(
            f"the served card has {bare_lf} BARE LF and {crlf} CRLF — a vCard's lines must be "
            "CRLF-delimited (RFC 6350 §3.2). iOS and Android reject a bare-LF card by opening "
            "NOTHING, which is indistinguishable from a working tap. This is B-025"
        )
    if crlf == 0:
        problems.append(
            "the served card contains NO CRLF at all — it cannot be a well-formed vCard"
        )

    text = body.decode("utf-8", errors="replace")

    # Every required property must be present AND in order. A card whose delimiters are buried
    # mid-body is not a card, and a missing TEL is a contact with no number in it.
    position = -1
    for prop in REQUIRED_PROPERTIES:
        at = text.find(prop, position + 1)
        if at == -1:
            problems.append(
                f"the served card is missing the required property `{prop}`"
            )
        elif at <= position:
            problems.append(
                f"the served card states `{prop}` out of order — a parser reads BEGIN:VCARD "
                "first and stops at END:VCARD"
            )
        else:
            position = at

    # A card that carries no phone number is the one failure worse than a malformed one: it
    # saves cleanly and is silently useless. Anchored to the TEL line's own value.
    tel_lines = [ln for ln in text.replace("\r\n", "\n").split("\n") if ln.startswith("TEL")]
    if not tel_lines:
        problems.append("the served card has no TEL line, so it saves a contact with no number")
    else:
        for line in tel_lines:
            value = line.split(":", 1)[-1].strip()
            if not value.startswith("+") or not value[1:].isdigit():
                problems.append(
                    f"the served card's TEL value {value!r} is not exact E.164 — the send path "
                    "requires that form, so this number may not be textable"
                )
            else:
                notes.append(f"TEL carries an E.164 number ending {value[-4:]}")

    if not problems:
        notes.append(
            f"{len(body)} bytes, {crlf} CRLF, 0 bare LF, all {len(REQUIRED_PROPERTIES)} "
            "required properties present and in order"
        )

    return Verdict(ok=not problems, problems=problems, notes=notes)


def fetch_card(base_url: str) -> tuple[bytes, str | None]:
    """Fetch the card and return its RAW body bytes plus the content-type.

    `curl` rather than `urllib` deliberately: this check is about bytes on the wire, and curl
    writes the body to a file without any text-mode handling. Python's HTTP stack is also
    byte-exact here, but the shell command is the same one a person runs by hand from the
    RUNBOOK, so a discrepancy between this check and a manual verification cannot hide in a
    library difference.
    """
    url = f"{base_url.rstrip('/')}{CARD_PATH}"
    result = subprocess.run(
        ["curl", "-sS", "--fail-with-body", "-D", "-", "--output", "-", url],
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"curl {url} failed: {result.stderr.decode('utf-8', 'replace').strip()}"
        )

    # Headers and body arrive on the same stream; split on the blank line that ends the final
    # header block. `rsplit` handles a 1xx or redirect preamble carrying its own block.
    raw = result.stdout
    separator = b"\r\n\r\n"
    if separator not in raw:
        raise RuntimeError(f"could not find the header/body boundary in the response from {url}")
    headers_raw, _, body = raw.rpartition(separator)

    content_type: str | None = None
    for line in headers_raw.decode("utf-8", "replace").splitlines():
        name, _, value = line.partition(":")
        if name.strip().lower() == "content-type":
            content_type = value.strip()

    return body, content_type


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=BASE_URL)
    args = parser.parse_args()

    url = f"{args.base_url.rstrip('/')}{CARD_PATH}"
    print(f"Fetching the served contact card from {url}…")
    try:
        body, content_type = fetch_card(args.base_url)
    except RuntimeError as exc:
        print(f"\nFAILED: {exc}")
        return 1

    verdict = evaluate(body, content_type)

    print("\nServed contact card")
    for note in verdict.notes:
        print(f"  PASS  {note}")
    for problem in verdict.problems:
        print(f"  FAIL  {problem}")

    if not verdict.ok:
        print(
            "\nFAILED — the deployed contact card is malformed.\n"
            "A malformed card fails by opening NOTHING on the handset, so this will not\n"
            "surface as an error anywhere else. The renderer builds its separator with\n"
            "`String.fromCharCode` precisely so the build cannot strip it; check\n"
            "`packages/core/src/public/vcard.ts` and\n"
            "`apps/web/lib/contact-card-build.test.ts` before redeploying."
        )
        return 1

    print("\nserved card assertions PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
