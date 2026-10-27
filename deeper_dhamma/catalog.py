"""
Monastic Teacher Catalog, Era Determination, and Episode Metadata Parsing.
"""

import html
import re
import unicodedata
from typing import List, Optional, Tuple

# Era classifications based on temporal vocal drift and recording media transitions
ERA_ANALOG = "1997_2003"        # Cassette recordings, higher pitch, faster cadence
ERA_EARLY_DIGITAL = "2004_2014"  # Early digital compression, intermediate cadence
ERA_HIGH_DEF = "2015_2026"       # Modern boundary microphones, mature timbre

KNOWN_TEACHERS = [
    {
        "slug": "ajahn_brahmali",
        "display_name": "Ajahn Brahmali",
        "patterns": [r"\bbrahmali\b", r"\bbramali\b"],
        "default_role": "monastic_primary",
        "color": "#ea580c",
    },
    {
        "slug": "ajahn_brahm",
        "display_name": "Ajahn Brahm",
        "patterns": [
            r"brahmavamso",
            r"\bajahn\s+brahm\b",
            r"\bbrahm\b(?!ali)",
            r"\bajahn\s+bram\b",
            r"\bbram\b(?!ali)",
        ],
        "default_role": "monastic_primary",
        "color": "#f59e0b",
    },
    {
        "slug": "ajahn_hasapanna",
        "display_name": "Ajahn Hasapanna",
        "patterns": [r"(?:ajahn|ayya)\s+hasapanna\b", r"\bhasapanna\b"],
        "default_role": "monastic_primary",
        "color": "#ec4899",
    },
    {
        "slug": "venerable_sunyo",
        "display_name": "Venerable Sunyo",
        "patterns": [r"(?:venerable|ven|ajahn)\s+sunyo\b", r"\bsunyo\b"],
        "default_role": "monastic_primary",
        "color": "#eab308",
    },
    {
        "slug": "bhante_sujato",
        "display_name": "Bhante Sujato",
        "patterns": [r"(?:bhante|ajahn)\s+sujato\b", r"\bsujato\b"],
        "default_role": "monastic_primary",
        "color": "#10b981",
    },
    {
        "slug": "ayya_vayama",
        "display_name": "Ayya Vayama",
        "patterns": [r"(?:ayya|ayye|ajahn)\s+vayama\b"],
        "default_role": "monastic_primary",
        "color": "#a855f7",
    },
    {
        "slug": "ajahn_khemavaro",
        "display_name": "Ajahn Khemavaro",
        "patterns": [r"(?:ajahn|venerable)\s+khemavaro\b", r"\bkhemavaro\b"],
        "default_role": "monastic_primary",
        "color": "#14b8a6",
    },
    {
        "slug": "ajahn_appicchato",
        "display_name": "Ajahn Appicchato",
        "patterns": [r"(?:ajahn|venerable|ven)\s+appic+h?ato\b", r"\bappic+h?ato\b"],
        "default_role": "monastic_primary",
        "color": "#06b6d4",
    },
    {
        "slug": "ajahn_santutthi",
        "display_name": "Ajahn Santutthi",
        "patterns": [r"(?:ajahn|venerable|ven)\s+santut+hi\b", r"\bsantut+hi\b"],
        "default_role": "monastic_primary",
        "color": "#d97706",
    },
    {
        "slug": "ayya_karunika",
        "display_name": "Ayya Karunika",
        "patterns": [r"(?:ayya|ayye)\s+karunika\b", r"\bkarunika\b"],
        "default_role": "monastic_primary",
        "color": "#f43f5e",
    },
    {
        "slug": "ayya_seri",
        "display_name": "Ayya Seri",
        "patterns": [r"(?:ayya|ayye)\s+seri\b", r"\bseri\b"],
        "default_role": "monastic_primary",
        "color": "#8b5cf6",
    },
    {
        "slug": "bhante_gunaratana",
        "display_name": "Bhante Gunaratana",
        "patterns": [r"gunaratana\b", r"\bbhante\s+g\b"],
        "default_role": "monastic_primary",
        "color": "#b45309",
    },
    {
        "slug": "venerable_cittapalo",
        "display_name": "Venerable Cittapalo",
        "patterns": [r"(?:venerable|ven|bhante|ajahn)\s+cittapalo\b", r"\bcittapalo\b"],
        "default_role": "monastic_primary",
        "color": "#0284c7",
    },
    {
        "slug": "venerable_nitho",
        "display_name": "Venerable Nitho",
        "patterns": [r"(?:venerable|ven|bhante|ajahn)\s+nitho\b", r"\bnitho\b"],
        "default_role": "monastic_primary",
        "color": "#059669",
    },
    {
        "slug": "ayya_visuddhi",
        "display_name": "Ayya Visuddhi",
        "patterns": [r"(?:ayya|ayye)\s+visuddhi\b", r"\bvisuddhi\b"],
        "default_role": "monastic_primary",
        "color": "#d946ef",
    },
    {
        "slug": "venerable_jhanarato",
        "display_name": "Venerable Jhanarato",
        "patterns": [r"(?:venerable|ven|bhante|ajahn)\s+jhanarato\b", r"\bjhanarato\b"],
        "default_role": "monastic_primary",
        "color": "#6366f1",
    },
    {
        "slug": "ajahn_dhiravamso",
        "display_name": "Ajahn Dhiravamso",
        "patterns": [r"(?:ajahn|venerable|ven)\s+dh?iravamso\b", r"\bdh?iravamso\b"],
        "default_role": "monastic_primary",
        "color": "#ca8a04",
    },
    {
        "slug": "venerable_ekaggata",
        "display_name": "Venerable Ekaggata",
        "patterns": [r"(?:venerable|ven|bhante|ajahn)\s+ekag+at+a\b", r"\bekag+at+a\b"],
        "default_role": "monastic_primary",
        "color": "#0d9488",
    },
    {
        "slug": "venerable_munissara",
        "display_name": "Venerable Munissara",
        "patterns": [r"(?:venerable|ven|bhante|ajahn)\s+munissara\b", r"\bmunissara\b"],
        "default_role": "monastic_primary",
        "color": "#4f46e5",
    },
    {
        "slug": "bhante_akaliko",
        "display_name": "Bhante Akaliko",
        "patterns": [r"(?:bhante|venerable|ven|ajahn)\s+akaliko\b", r"\bakaliko\b"],
        "default_role": "monastic_primary",
        "color": "#16a34a",
    },
    {
        "slug": "ajahn_chandako",
        "display_name": "Ajahn Chandako",
        "patterns": [r"(?:ajahn|venerable|ven)\s+chandako\b", r"\bchandako\b"],
        "default_role": "monastic_primary",
        "color": "#c2410c",
    },
    {
        "slug": "ajahn_kassapa",
        "display_name": "Ajahn Kassapa",
        "patterns": [r"(?:ajahn|venerable|ven)\s+kassapa\b", r"\bkassapa\b"],
        "default_role": "monastic_primary",
        "color": "#9333ea",
    },
    {
        "slug": "ajahn_sangharatana",
        "display_name": "Ajahn Sangharatana",
        "patterns": [r"(?:ajahn|venerable|ven)\s+sangharatana\b", r"\bsangharatana\b"],
        "default_role": "monastic_primary",
        "color": "#e11d48",
    },
    {
        "slug": "ajahn_pasada",
        "display_name": "Ajahn Pasada",
        "patterns": [r"(?:ajahn|venerable|ven)\s+pasada\b", r"\bpasada\b"],
        "default_role": "monastic_primary",
        "color": "#2563eb",
    },
    {
        "slug": "venerable_bodhidhaja",
        "display_name": "Venerable Bodhidhaja",
        "patterns": [r"(?:venerable|ven|bhante|ajahn)\s+bodhidhaja\b", r"\bbodhidhaja\b"],
        "default_role": "monastic_primary",
        "color": "#38bdf8",
    },
    {
        "slug": "venerable_buddharakkhita",
        "display_name": "Venerable Buddharakkhita",
        "patterns": [r"(?:venerable|ven|bhante|ajahn)\s+buddharakkhita\b", r"\bbuddharakkhita\b"],
        "default_role": "monastic_primary",
        "color": "#0891b2",
    },
    {
        "slug": "ajahn_cunda",
        "display_name": "Ajahn Cunda",
        "patterns": [r"(?:ajahn|bhante|venerable)\s+cunda\b"],
        "default_role": "monastic_primary",
        "color": "#65a30d",
    },
    {
        "slug": "ajahn_nissarano",
        "display_name": "Ajahn Nissarano",
        "patterns": [r"(?:ajahn|venerable)\s+nissarano\b", r"\bnissarano\b"],
        "default_role": "monastic_primary",
        "color": "#7c3aed",
    },
    {
        "slug": "ajahn_dhammasiha",
        "display_name": "Ajahn Dhammasiha",
        "patterns": [r"(?:ajahn|venerable)\s+dhammasiha\b", r"\bdhammasiha\b"],
        "default_role": "monastic_primary",
        "color": "#b91c1c",
    },
    {
        "slug": "ajahn_mudito",
        "display_name": "Ajahn Mudito",
        "patterns": [r"(?:ajahn|venerable|ven)\s+mudito\b", r"\bmudito\b"],
        "default_role": "monastic_primary",
        "color": "#84cc16",
    },
    {
        "slug": "ajahn_mudu",
        "display_name": "Ajahn Mudu",
        "patterns": [r"(?:ajahn|venerable|ven)\s+mudu\b"],
        "default_role": "monastic_primary",
        "color": "#10b981",
    },
    {
        "slug": "venerable_radha",
        "display_name": "Venerable Radha",
        "patterns": [r"(?:venerable|ven|bhante)\s+radha\b"],
        "default_role": "monastic_primary",
        "color": "#0284c7",
    },
    {
        "slug": "venerable_nibbuto",
        "display_name": "Venerable Nibbuto",
        "patterns": [r"(?:venerable|ven|bhante|ajahn)\s+nibbuto\b", r"\bnibbuto\b"],
        "default_role": "monastic_primary",
        "color": "#0d9488",
    },
    {
        "slug": "venerable_ananda",
        "display_name": "Venerable Ananda",
        "patterns": [r"(?:venerable|ven|bhante)\s+ananda\b"],
        "default_role": "monastic_primary",
        "color": "#64748b",
    },
    {
        "slug": "venerable_upasama",
        "display_name": "Venerable Upasama",
        "patterns": [r"(?:venerable|ven|ajahn)\s+upasama\b"],
        "default_role": "monastic_primary",
        "color": "#d97706",
    },
    {
        "slug": "venerable_jhayako",
        "display_name": "Venerable Jhayako",
        "patterns": [r"(?:venerable|ven|bhante)\s+jhayako\b"],
        "default_role": "monastic_primary",
        "color": "#9333ea",
    },
    {
        "slug": "ajahn_chah",
        "display_name": "Ajahn Chah",
        "patterns": [r"ajahn\s+chah\b", r"acha?n\s+chah?\b"],
        "default_role": "monastic_primary",
        "color": "#78350f",
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


def identify_all_teachers(text: str) -> List[Tuple[str, str]]:
    """Identifies all matching teachers from text metadata like episode title or filename."""
    lower_text = text.lower().replace("_", " ")
    results = []
    seen = set()
    for teacher in KNOWN_TEACHERS:
        for pattern in teacher["patterns"]:
            if re.search(pattern, lower_text):
                slug = teacher["slug"]
                if slug not in seen and slug != "unknown_teacher":
                    seen.add(slug)
                    results.append((slug, teacher["display_name"]))
                break
    return results


def identify_primary_teacher(text: str) -> Tuple[str, str]:
    """Identifies teacher from text metadata like episode title or filename."""
    lower_text = text.lower().replace("_", " ")
    for teacher in KNOWN_TEACHERS:
        for pattern in teacher["patterns"]:
            if re.search(pattern, lower_text):
                return teacher["slug"], teacher["display_name"]
    return "unknown_teacher", "Unknown Teacher"


MONTH_MAP = {
    "january": "01", "jan": "01",
    "february": "02", "feb": "02",
    "march": "03", "mar": "03",
    "april": "04", "apr": "04",
    "may": "05",
    "june": "06", "jun": "06",
    "july": "07", "jul": "07",
    "august": "08", "aug": "08",
    "september": "09", "sep": "09", "sept": "09",
    "october": "10", "oct": "10",
    "november": "11", "nov": "11",
    "december": "12", "dec": "12",
}

NON_ENGLISH_PATTERNS = [
    r"\b(?:in\s+)?thai(?:\s+language)?\b",
    r"\b(?:with\s+)?sinhalese(?:\s+translation)?\b",
    r"\b(?:in\s+)?sinhala(?:\s+language)?\b",
    r"\b(?:in\s+)?chinese(?:\s+language)?\b",
    r"\bmandarin\b",
    r"\bcantonese\b",
    r"\bvietnamese\b",
    r"\bburmese\b",
    r"\bwith\s+\w+\s+translation\b",
    r"[\u0e00-\u0e7f]",  # Thai Unicode range
    r"[\u4e00-\u9fff]",  # Chinese Unicode range
    r"[\u0d80-\u0dff]",  # Sinhala Unicode range
]
_NON_ENGLISH_REGEX = re.compile("|".join(NON_ENGLISH_PATTERNS), re.IGNORECASE)


def is_english_talk(title: str) -> bool:
    """Returns True if the talk title does not indicate non-English language or translation."""
    return not bool(_NON_ENGLISH_REGEX.search(title))


def clean_slug(text: str) -> str:
    """
    Normalizes unicode strings (e.g. Pali diacritics: ā -> a, ṇ -> n, ḍ -> d)
    into clean, lowercase, underscore-separated ASCII slugs.
    """
    text = html.unescape(text)
    decomposed = unicodedata.normalize("NFKD", text)
    ascii_only = decomposed.encode("ascii", "ignore").decode("ascii")
    lowered = ascii_only.lower()
    slug = re.sub(r"[^a-z0-9]+", "_", lowered)
    return slug.strip("_")


to_ascii_slug = clean_slug  # Backward-compatible alias


def extract_year_and_date(title: str, upload_date: str) -> Tuple[str, str]:
    """
    Extracts the true talk year and yyyy-mm-dd date prefix.
    Detects dates or years in the title for older releases / backfilled talks,
    falling back to upload_date.
    """
    # 1. Explicit full date in title: e.g. 15 August 2001, 26th April 2003, 27 November 2025
    m_full_date = re.search(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(19\d\d|20\d\d)\b", title)
    if m_full_date:
        day = m_full_date.group(1).zfill(2)
        mon_name = m_full_date.group(2).lower()
        yr = m_full_date.group(3)
        if mon_name in MONTH_MAP:
            return yr, f"{yr}-{MONTH_MAP[mon_name]}-{day}"

    # 2. Month + Year: e.g. November 2011, October 2013
    m_mon_yr = re.search(r"\b([A-Za-z]+)\s+(19\d\d|20\d\d)\b", title)
    if m_mon_yr:
        mon_name = m_mon_yr.group(1).lower()
        yr = m_mon_yr.group(2)
        if mon_name in MONTH_MAP:
            return yr, f"{yr}-{MONTH_MAP[mon_name]}-01"

    # 3. Series or title starting with year: e.g. 2017 Rains Retreat, 1997 9 Day Retreat
    m_start_yr = re.match(r"^(19\d\d|20\d\d)\b", title)
    if m_start_yr:
        yr = m_start_yr.group(1)
        if upload_date and len(upload_date) == 8:
            return yr, f"{yr}-{upload_date[4:6]}-{upload_date[6:8]}"
        return yr, f"{yr}-01-01"

    # 4. Standalone year at end of title: e.g. ... | 1997
    m_end_yr = re.search(r"\|\s*(19\d\d|20\d\d)\s*$", title)
    if m_end_yr:
        yr = m_end_yr.group(1)
        if upload_date and len(upload_date) == 8:
            return yr, f"{yr}-{upload_date[4:6]}-{upload_date[6:8]}"
        return yr, f"{yr}-01-01"

    # Fallback to upload_date
    yr = upload_date[:4] if len(upload_date) >= 4 else "unknown_year"
    d_prefix = f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:8]}" if len(upload_date) == 8 else yr
    return yr, d_prefix


def parse_episode_metadata(title: str, upload_date: str) -> Tuple[str, str, str]:
    """
    Parses an episode title into a (year, series_folder, clean_filename) tuple.
    Extracts true talk year, series, part tags (padded), and normalized ASCII slug.
    """
    title = html.unescape(title)
    talk_year, date_prefix = extract_year_and_date(title, upload_date)

    m_fraction = re.search(r"^(.*?)\s*\((\d+)/(\d+)\)(.*)$", title)
    m_part = re.search(r"^(.*?)\s*-\s*Part\s+(\d+)/(\d+)(.*)$", title, re.IGNORECASE)
    m_lead_frac = re.search(r"^(.*?)\|\s*(\d+)/(\d+)\s+(Retreat.*)$", title, re.IGNORECASE)
    m_day = re.search(r"^(.*?\bRetreat\b)\s*-\s*Day\s+(\d+)(.*)$", title, re.IGNORECASE)

    if m_fraction:
        series_raw, cur_str, total_str, remainder = m_fraction.groups()
        pad = len(total_str)
        part_tag = f"{cur_str.zfill(pad)}_{total_str}"
        series_folder = clean_slug(series_raw.replace("|", " "))
        remainder_slug = clean_slug(remainder)
        parts = [date_prefix, series_folder, part_tag, remainder_slug]
        filename = "_".join(p for p in parts if p)
        return talk_year, series_folder, filename

    if m_part:
        series_raw, cur_str, total_str, remainder = m_part.groups()
        pad = len(total_str)
        part_tag = f"part_{cur_str.zfill(pad)}_{total_str}"
        series_folder = clean_slug(series_raw.replace("|", " "))
        remainder_slug = clean_slug(remainder)
        parts = [date_prefix, series_folder, part_tag, remainder_slug]
        filename = "_".join(p for p in parts if p)
        return talk_year, series_folder, filename

    if m_lead_frac:
        pre_series, cur_str, total_str, post_series = m_lead_frac.groups()
        pad = len(total_str)
        part_tag = f"{cur_str.zfill(pad)}_{total_str}"
        series_folder = clean_slug(f"{pre_series} {post_series}")
        parts = [date_prefix, series_folder, part_tag]
        filename = "_".join(p for p in parts if p)
        return talk_year, series_folder, filename

    if m_day:
        series_raw, day_str, remainder = m_day.groups()
        part_tag = f"day_{day_str.zfill(2)}"
        series_folder = clean_slug(series_raw.replace("|", " "))
        remainder_slug = clean_slug(remainder)
        parts = [date_prefix, series_folder, part_tag, remainder_slug]
        filename = "_".join(p for p in parts if p)
        return talk_year, series_folder, filename

    clean_title = clean_slug(title)
    parts = [date_prefix, clean_title]
    filename = "_".join(p for p in parts if p)
    return talk_year, "standalone", filename
