"""Deterministic rider fake-name screening and passenger-manifest verification.

Context: drivers were murdered by passengers registered under placeholder
names ("Snake", "Mr. Dot"). The drivers' union demands passenger profiling
with NIN (Nigerian National Identification Number). This module provides
offline, deterministic heuristics only — no external calls, no stored data.

Decision boundary: a low plausibility score is a *screening signal* for
manual review / step-up verification, never an automated guilt verdict.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

# ---------------------------------------------------------------------------
# Embedded reference data
# ---------------------------------------------------------------------------

# Whole-name placeholders that are never plausible passenger names.
FAKE_FULLNAMES = frozenset(
    {
        "snake",
        "mr dot",
        "mrdot",
        "mr",
        "mr.",
        "ms",
        "mrs",
        "dot",
        "test",
        "testuser",
        "test user",
        "unknown",
        "unknown user",
        "anonymous",
        "anon",
        "nobody",
        "no one",
        "noone",
        "fake",
        "dummy",
        "sample",
        "example",
        "admin",
        "administrator",
        "user",
        "guest",
        "null",
        "none",
        "n/a",
        "na",
        "john doe",
        "jane doe",
        "qwerty",
        "asdf",
        "asdfgh",
        "passenger",
        "rider",
        "customer",
    }
)

# Individual words that strongly indicate a placeholder when present.
FAKE_WORDS = frozenset(
    {
        "snake",
        "test",
        "fake",
        "dummy",
        "unknown",
        "anonymous",
        "nobody",
        "sample",
    }
)

# Small embedded profanity list (English). Screening signal only.
PROFANITY_WORDS = frozenset(
    {
        "fuck",
        "shit",
        "bitch",
        "bastard",
        "asshole",
        "dick",
        "pussy",
        "whore",
        "idiot",
        "stupid",
        "mad",
    }
)

# Common Nigerian given names and surnames across Yoruba, Igbo, Hausa/Fulani,
# plus common English/Christian names in everyday Nigerian use. Lowercase.
NIGERIAN_NAMES = frozenset(
    {
        # Yoruba
        "adebayo", "adewale", "adeyemi", "adesola", "adetola", "adekunle",
        "ademola", "adeola", "abiodun", "abimbola", "ayodele", "ayomide",
        "babatunde", "boluwatife", "damilola", "femi", "folake", "funke",
        "kehinde", "kolawole", "olayinka", "opeyemi", "segun", "taiwo",
        "temitope", "titilayo", "toyin", "wale", "yemi", "yetunde",
        "oluwaseun", "oluwatobi", "olufemi", "olumide", "olusegun",
        "oluwadamilola", "olalekan", "adeleke", "ajayi", "balogun",
        "ogunleye", "fashola", "oyekan", "alabi", "adigun", "olowu",
        # Igbo
        "adaeze", "adanna", "amara", "chiamaka", "chidinma", "chidiebere",
        "chiemeka", "chigozie", "chika", "chimamanda", "chinonso",
        "chukwudi", "chukwuemeka", "ebere", "ezinne", "ifeanyi",
        "ikechukwu", "kelechi", "ngozi", "nnamdi", "obinna", "okechukwu",
        "oluchi", "onyeka", "somtochi", "uche", "ugochukwu", "okonkwo",
        "obi", "eze", "nwachukwu", "okafor", "chukwu", "anyaoku", "kalu",
        "mbakwe", "nwosu", "okoro", "onwuka", "uzoma",
        # Hausa / Fulani
        "abubakar", "ahmad", "aisha", "aliyu", "amina", "aminu",
        "balarabe", "bashir", "bello", "danjuma", "fatima", "garba",
        "habib", "halima", "haruna", "hassan", "husseini", "ibrahim",
        "idris", "ismail", "jibril", "kabir", "lawal", "maryam",
        "muhammad", "musa", "mustapha", "nasir", "rabiu", "sadiq",
        "salisu", "sani", "shehu", "suleiman", "tanimu", "umar", "usman",
        "yakubu", "yusuf", "zainab", "abdullahi", "abdurrahman",
        "danladi", "gambo", "hadiza", "khadija", "sa'adu",
        # Common English / Christian names in Nigerian use
        "john", "james", "david", "michael", "sarah", "mary", "peter",
        "paul", "grace", "faith", "joy", "blessing", "daniel", "samuel",
        "joseph", "elizabeth", "victoria", "deborah", "ruth", "esther",
        "stephen", "thomas", "andrew", "philip", "patrick", "henry",
        "charles", "george", "rose", "angela", "cynthia", "emmanuel",
        "francis", "gloria", "helen", "isaac", "jacob", "janet", "mark",
        "matthew", "mercy", "moses", "nathaniel", "prince", "richard",
        "robert", "susan", "sunday", "gift", "favour", "promise",
    }
)

VOWELS = frozenset("aeiouy")
PLAUSIBLE_THRESHOLD = 0.5

# ---------------------------------------------------------------------------
# Name screening heuristics
# ---------------------------------------------------------------------------


def _normalize(name: str) -> str:
    """Lowercase, strip accents, collapse punctuation/whitespace."""
    decomposed = unicodedata.normalize("NFKD", name)
    ascii_only = "".join(c for c in decomposed if not unicodedata.combining(c))
    ascii_only = ascii_only.replace(".", " ").replace("_", " ").replace("-", " ")
    return re.sub(r"\s+", " ", ascii_only.strip().lower())


def _words(normalized: str) -> list[str]:
    return [word for word in normalized.split(" ") if word]


def _has_repeated_char_run(text: str, run: int = 4) -> bool:
    return bool(re.search(r"(.)\1{" + str(run - 1) + r",}", text))


def _is_gibberish_word(word: str) -> bool:
    """Long alphabetic token with no vowels — e.g. 'qzxkv' / 'bcdfg'."""
    letters = [c for c in word if c.isalpha()]
    return len(letters) >= 5 and not any(c in VOWELS for c in letters)


def _is_emoji_or_symbol_only(name: str) -> bool:
    has_letter = any(c.isalpha() for c in name)
    has_digit = any(c.isdigit() for c in name)
    return bool(name.strip()) and not has_letter and not has_digit


def screen_name(name: str) -> dict[str, Any]:
    """Score passenger-name plausibility.

    Returns {"score": float in [0, 1], "flags": [str], "plausible": bool}.
    score == 1.0 means clearly plausible; 0.0 means clearly fake.
    plausible == (score >= 0.5).
    """
    flags: list[str] = []
    score = 0.5

    stripped = (name or "").strip()
    if not stripped:
        return {"score": 0.0, "flags": ["empty_name"], "plausible": False}

    normalized = _normalize(stripped)
    words = _words(normalized)
    joined = normalized.replace(" ", "")

    # --- hard-negative structural signals ---------------------------------
    if _is_emoji_or_symbol_only(stripped):
        flags.append("no_letters_or_digits")
        score -= 0.5
    elif stripped.isdigit():
        flags.append("digits_only")
        score -= 0.5

    alpha_chars = [c for c in stripped if c.isalpha()]
    if len(alpha_chars) == 1 and not any(c.isdigit() for c in stripped):
        flags.append("single_character")
        score -= 0.4

    if alpha_chars and _has_repeated_char_run(joined):
        flags.append("repeated_characters")
        score -= 0.35

    # --- placeholder / fake dictionary signals -----------------------------
    if normalized in FAKE_FULLNAMES or joined in FAKE_FULLNAMES:
        flags.append("placeholder_name")
        score -= 0.5

    fake_hits = sorted({w for w in words if w in FAKE_WORDS})
    if fake_hits:
        flags.append("placeholder_word")
        score -= 0.4

    profanity_hits = sorted({w for w in words if w in PROFANITY_WORDS})
    if profanity_hits:
        flags.append("profanity")
        score -= 0.4

    if words and all(_is_gibberish_word(w) for w in words if any(c.isalpha() for c in w)) and any(
        any(c.isalpha() for c in w) for w in words
    ):
        flags.append("gibberish_no_vowels")
        score -= 0.35

    # --- positive signals ---------------------------------------------------
    known_hits = {w for w in words if w in NIGERIAN_NAMES}
    if known_hits:
        score += 0.25 + 0.1 * (len(known_hits) - 1)

    original_words = stripped.split()
    capitalized = [w for w in original_words if len(w) >= 2 and w[0].isupper() and w[1:].islower()]
    if len(capitalized) >= 2:
        score += 0.15

    score = max(0.0, min(1.0, round(score, 4)))
    return {
        "score": score,
        "flags": flags,
        "plausible": score >= PLAUSIBLE_THRESHOLD,
    }


# ---------------------------------------------------------------------------
# NIN (National Identification Number) format validation
# ---------------------------------------------------------------------------


# Canonical trivial sequences that are never real NINs.
SEQUENTIAL_NIN_BLACKLIST = frozenset({"01234567890", "98765432109"})


def _is_sequential(digits: str) -> bool:
    """Detect trivially sequential NINs.

    Covers the canonical keyboard cycles (01234567890 / 98765432109) plus
    any strict step +-1 run. Note the contract deliberately keeps
    "12345678901" valid: it wraps (9 -> 0 -> 1) and is not a canonical
    cycle, and only a format check is performed here.
    """
    if digits in SEQUENTIAL_NIN_BLACKLIST:
        return True
    ascending = all(int(digits[i + 1]) - int(digits[i]) == 1 for i in range(len(digits) - 1))
    descending = all(int(digits[i]) - int(digits[i + 1]) == 1 for i in range(len(digits) - 1))
    return ascending or descending


def validate_nin_format(nin: str | None) -> tuple[bool | None, list[str]]:
    """Offline NIN format check.

    Returns (format_ok, flags). format_ok is None when no NIN was supplied.
    Rules: exactly 11 digits, not all-same-digit, not strictly sequential.
    This is a format check only — it does not confirm the NIN exists or
    belongs to the passenger.
    """
    if nin is None:
        return None, []
    cleaned = nin.strip()
    flags: list[str] = []
    if len(cleaned) != 11 or not cleaned.isdigit():
        flags.append("nin_not_11_digits")
        return False, flags
    if len(set(cleaned)) == 1:
        flags.append("nin_all_same_digit")
        return False, flags
    if _is_sequential(cleaned):
        flags.append("nin_sequential_digits")
        return False, flags
    return True, flags


def verify_passenger(name: str, nin: str | None) -> dict[str, Any]:
    """Screen one manifest passenger entry."""
    screened = screen_name(name)
    nin_ok, nin_flags = validate_nin_format(nin)
    return {
        "name": name,
        "name_ok": screened["plausible"],
        "nin_format_ok": nin_ok,
        "flags": screened["flags"] + nin_flags,
    }


def verify_manifest(passengers: list[dict[str, Any]]) -> dict[str, Any]:
    """Screen every passenger on a manifest."""
    results = [
        verify_passenger(str(entry.get("name", "")), entry.get("nin"))
        for entry in passengers
    ]
    return {"results": results}
