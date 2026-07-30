#!/usr/bin/env python3
"""Tests for `served_card_assertions.py` — the post-deploy check that the card is CRLF-delimited.

    cd infra && python3 test_served_card_assertions.py

WHY A TEST FOR AN ASSERTION SCRIPT. Same reason as `test_deploy_assertions.py`: this checker
will only ever see the healthy case once B-025 is deployed. Run against the live service after
the fix it passes whether or not the byte counting inside it works at all, so the failure case
has to be CONSTRUCTED. Every payload below is built byte for byte, including the exact 147-byte
bare-LF card production actually served.

The B-025 card and the correct card differ by SIX BYTES and nothing else. No status code, no
header, no property, and no parse distinguishes them — which is precisely why the defect
survived a deployment. That pair is the sharpest test in this file.
"""

import sys

from served_card_assertions import evaluate

FAILURES: list[str] = []
CHECKS = 0

VCARD_TYPE = "text/vcard; charset=utf-8"

# The card's lines, exactly as `renderContactCard` states them.
LINES = (
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:VIGA Farm Friend",
    "N:;VIGA Farm Friend;;;",
    "ORG:Vashon Island Growers Association",
    "TEL;TYPE=CELL,VOICE:+12068645326",
    "END:VCARD",
)

# The correct card: 153 bytes, 6 CRLF, 0 bare LF. Verified on the wire against a local
# standalone build, where `file(1)` reads "vCard visiting card, version 3.0".
GOOD = "\r\n".join(LINES).encode("utf-8")

# The B-025 card as production actually served it: 147 bytes, 0 CRLF, 6 bare LF, rejected by
# `file(1)` with "lines not separated by CRLF".
B025 = "\n".join(LINES).encode("utf-8")


def check(name: str, condition: bool, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{' — ' + detail if detail else ''}")
        FAILURES.append(name)


def main() -> int:
    print("\nThe B-025 payload itself")

    # Pin the byte counts from the bug report, so this test is anchored to the real numbers
    # rather than to whatever the helpers above happen to produce.
    crlf_b025 = B025.count(b"\r\n")
    crlf_good = GOOD.count(b"\r\n")
    check(
        "the constructed B-025 card is 147 bytes with 0 CRLF, as production served it",
        len(B025) == 147 and crlf_b025 == 0,
        f"got {len(B025)} bytes, {crlf_b025} CRLF",
    )
    check(
        "the constructed correct card is 153 bytes with 6 CRLF",
        len(GOOD) == 153 and crlf_good == 6,
        f"got {len(GOOD)} bytes, {crlf_good} CRLF",
    )
    check(
        "the two cards differ by exactly the six CR bytes and nothing else",
        len(GOOD) - len(B025) == 6 and GOOD.replace(b"\r\n", b"\n") == B025,
    )

    verdict = evaluate(B025, VCARD_TYPE)
    check(
        "the exact production payload is REJECTED",
        not verdict.ok,
        "this is the whole point of the check; a pass here means B-025 could ship again",
    )
    check(
        "the rejection names bare LF and cites B-025",
        any("BARE LF" in p and "B-025" in p for p in verdict.problems),
        f"problems were {verdict.problems}",
    )

    print("\nThe correct card")

    verdict = evaluate(GOOD, VCARD_TYPE)
    check("the 153-byte CRLF card is ACCEPTED", verdict.ok, f"problems: {verdict.problems}")
    check(
        "and the pass note states the byte and CRLF counts it actually measured",
        any("153 bytes" in n and "6 CRLF" in n for n in verdict.notes),
        f"notes were {verdict.notes}",
    )

    print("\nA lookup that read nothing is not a pass")

    # The failure this repo keeps rediscovering: a check that inspected no input reporting green.
    check("an empty body is REJECTED", not evaluate(b"", VCARD_TYPE).ok)
    check(
        "and it is reported as a failed request, not as a malformed card",
        any("EMPTY" in p for p in evaluate(b"", VCARD_TYPE).problems),
    )

    print("\nThe media type is half the mechanism")

    check(
        "a correct card served as text/plain is REJECTED",
        not evaluate(GOOD, "text/plain; charset=utf-8").ok,
        "without text/vcard a browser renders the card instead of opening Contacts",
    )
    check(
        "a missing content-type is REJECTED",
        not evaluate(GOOD, None).ok,
    )
    check(
        "and text/vcard is accepted regardless of parameter spelling or case",
        evaluate(GOOD, "Text/VCard").ok,
    )

    print("\nStructure a bare-LF check alone would miss")

    # Each of these is a DIFFERENT silent failure: the card saves cleanly and is useless.
    no_tel = "\r\n".join(l for l in LINES if not l.startswith("TEL")).encode("utf-8")
    check(
        "a card with no TEL line is REJECTED",
        not evaluate(no_tel, VCARD_TYPE).ok,
        "it would save a contact with no number in it",
    )

    bad_tel = GOOD.replace(b"+12068645326", b"206-864-5326")
    check(
        "a card whose TEL is not exact E.164 is REJECTED",
        not evaluate(bad_tel, VCARD_TYPE).ok,
        "the send path requires E.164; this repo already shipped a malformed number once",
    )

    no_begin = "\r\n".join(LINES[1:]).encode("utf-8")
    check(
        "a card missing BEGIN:VCARD is REJECTED",
        not evaluate(no_begin, VCARD_TYPE).ok,
    )

    reordered = "\r\n".join(
        ("BEGIN:VCARD", "FN:VIGA Farm Friend", "VERSION:3.0", "END:VCARD")
    ).encode("utf-8")
    check(
        "a card stating VERSION after a content property is REJECTED",
        not evaluate(reordered, VCARD_TYPE).ok,
        "VERSION must precede the content properties in vCard 3.0",
    )

    print("\nA single stray bare LF is still a defect")

    # The partial case: five separators correct, one not. A check that only asked "is there any
    # CRLF?" would pass this, and the card would still be malformed.
    partial = GOOD.replace(b"ORG:", b"\nORG:", 1)
    v = evaluate(partial, VCARD_TYPE)
    check("a card with 6 CRLF and ONE extra bare LF is REJECTED", not v.ok)
    check(
        "and the count of bare LF is reported accurately",
        any("1 BARE LF" in p for p in v.problems),
        f"problems were {v.problems}",
    )

    print(f"\n{CHECKS} checks, {len(FAILURES)} failed")
    if FAILURES:
        for name in FAILURES:
            print(f"  FAILED: {name}")
        return 1
    print("served card assertion tests PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
