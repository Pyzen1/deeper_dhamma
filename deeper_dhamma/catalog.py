"""
Monastic Teacher Catalog, Era Determination, and Episode Metadata Parsing.
"""

import re
from typing import Optional, Tuple

# Era classifications based on temporal vocal drift and recording media transitions
ERA_ANALOG = "1997_2003"        # Cassette recordings, higher pitch, faster cadence
ERA_EARLY_DIGITAL = "2004_2014"  # Early digital compression, intermediate cadence
ERA_HIGH_DEF = "2015_2026"       # Modern boundary microphones, mature timbre

KNOWN_TEACHERS = [
    {
        "slug": "ajahn_brahm",
        "display_name": "Ajahn Brahm",
        "patterns": [r"brahmavamso", r"\bajahn\s+brahm\b", r"\bbrahm\b"],
        "default_role": "monastic_primary",
    },
    {
        "slug": "ajahn_brahmali",
        "display_name": "Ajahn Brahmali",
        "patterns": [r"brahmali", r"bramali"],
        "default_role": "monastic_primary",
    },
    {
        "slug": "ajahn_hasapanna",
        "display_name": "Ajahn Hasapanna",
        "patterns": [r"hasapanna"],
        "default_role": "monastic_primary",
    },
    {
        "slug": "venerable_sunyo",
        "display_name": "Venerable Sunyo",
        "patterns": [r"sunyo"],
        "default_role": "monastic_primary",
    },
    {
        "slug": "ajahn_sujato",
        "display_name": "Ajahn Sujato",
        "patterns": [r"sujato"],
        "default_role": "monastic_primary",
    },
    {
        "slug": "ayya_vayama",
        "display_name": "Ayya Vayama",
        "patterns": [r"vayama"],
        "default_role": "monastic_primary",
    },
    {
        "slug": "ajahn_khemavaro",
        "display_name": "Ajahn Khemavaro",
        "patterns": [r"khemavaro"],
        "default_role": "monastic_primary",
    },
    {
        "slug": "ayya_karunika",
        "display_name": "Ayya Karunika",
        "patterns": [r"karunika"],
        "default_role": "monastic_primary",
    },
    {
        "slug": "ajahn_cunda",
        "display_name": "Ajahn Cunda",
        "patterns": [r"cunda"],
        "default_role": "monastic_primary",
    },
    {
        "slug": "ajahn_nissarano",
        "display_name": "Ajahn Nissarano",
        "patterns": [r"nissarano"],
        "default_role": "monastic_primary",
    },
    {
        "slug": "ajahn_dhammasiha",
        "display_name": "Ajahn Dhammasiha",
        "patterns": [r"dhammasiha"],
        "default_role": "monastic_primary",
    },
    {
        "slug": "ajahn_mudito",
        "display_name": "Ajahn Mudito",
        "patterns": [r"mudito"],
        "default_role": "monastic_primary",
    },
    {
        "slug": "ajahn_mudu",
        "display_name": "Ajahn Mudu",
        "patterns": [r"mudu\b"],
        "default_role": "monastic_primary",
    },
    {
        "slug": "venerable_radha",
        "display_name": "Venerable Radha",
        "patterns": [r"radha"],
        "default_role": "monastic_primary",
    },
    {
        "slug": "venerable_nibbuto",
        "display_name": "Venerable Nibbuto",
        "patterns": [r"nibbuto"],
        "default_role": "monastic_primary",
    },
    {
        "slug": "venerable_ananda",
        "display_name": "Venerable Ananda",
        "patterns": [r"ananda"],
        "default_role": "monastic_primary",
    },
    {
        "slug": "venerable_upasama",
        "display_name": "Venerable Upasama",
        "patterns": [r"upasama"],
        "default_role": "monastic_primary",
    },
    {
        "slug": "venerable_jhayako",
        "display_name": "Venerable Jhayako",
        "patterns": [r"jhayako"],
        "default_role": "monastic_primary",
    },
    {
        "slug": "ajahn_chah",
        "display_name": "Ajahn Chah",
        "patterns": [r"ajahn\s+chah", r"acha?n\s+chah?"],
        "default_role": "monastic_primary",
    },
]


def determine_era(year: int) -> str:
    """Returns the acoustic era tag based on the recording year."""
    if year <= 2003:
        return ERA_ANALOG
    elif 2004 <= year <= 2014:
        return ERA_EARLY_DIGITAL
    else:
        return ERA_HIGH_DEF


def identify_primary_teacher(text: str) -> Tuple[str, str]:
    """Identifies teacher from text metadata like episode title or filename."""
    lower_text = text.lower().replace("_", " ")
    for teacher in KNOWN_TEACHERS:
        for pattern in teacher["patterns"]:
            if re.search(pattern, lower_text):
                return teacher["slug"], teacher["display_name"]
    return "unknown_teacher", "Unknown Teacher"


def clean_slug(s: str) -> str:
    """Converts a title or string to a lowercase underscore slug."""
    s = s.lower().strip()
    s = re.sub(r"[^\w\s-]", "", s)
    s = re.sub(r"[\s-]+", "_", s)
    return s.strip("_")


def parse_episode_metadata(title: str, upload_date: str) -> Tuple[int, str, str]:
    """
    Extracts the year, folder subpath, and clean filename for an episode.
    Returns (year, subfolder, filename_stem).
    """
    # 1. Determine Year
    year_match = re.search(r"\b(19\d\d|20\d\d)\b", title)
    if year_match:
        year = int(year_match.group(1))
    elif upload_date and len(upload_date) >= 4 and upload_date[:4].isdigit():
        year = int(upload_date[:4])
    else:
        year = 2000

    # 2. Determine Subfolder (Series vs Standalone)
    lower_title = title.lower()
    series_slug = None

    if "rains retreat" in lower_title or "rains" in lower_title:
        series_slug = f"{year}_rains_retreat"
    elif "9 day" in lower_title or "9-day" in lower_title or "nine day" in lower_title:
        month_match = re.search(r"\b(january|february|march|april|may|june|july|august|september|october|november|december)\b", lower_title)
        if month_match:
            series_slug = f"{year}_{month_match.group(1)}_9_day_retreat"
        else:
            series_slug = f"{year}_9_day_retreat"
    elif "sutta retreat" in lower_title or "sutta study" in lower_title:
        series_slug = f"{year}_sutta_retreat"
    elif "easter retreat" in lower_title:
        series_slug = f"{year}_easter_retreat"
    elif "retreat" in lower_title:
        series_slug = f"{year}_retreat"

    subfolder = series_slug if series_slug else "standalone"

    # 3. Determine Clean Filename
    # Use upload date if available (YYYY-MM-DD)
    date_str = ""
    if upload_date and len(upload_date) == 8:
        date_str = f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:8]}"
    else:
        date_str = f"{year}-01-01"

    slug = clean_slug(title)
    filename_stem = f"{date_str}_{slug}"
    return year, subfolder, filename_stem
