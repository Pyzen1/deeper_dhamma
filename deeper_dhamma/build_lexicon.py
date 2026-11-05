"""
Deterministic Lexicon Compiler for Deeper Dhamma (buddhism_lexicon.db).

Builds the canonical Buddhism Lexicon SQLite database strictly from local,
verifiable upstream authority files stored in `databases/sources/`:
1. SuttaCentral Pali Glossary for Bhikkhus Bodhi and Sujato
   - Local source: `databases/sources/suttacentral_bodhi_sujato_glossary.json`
   - Canonical URL: https://discourse.suttacentral.net/t/pali-glossary-for-bhikkhus-bodhi-and-sujato/12008
2. SuttaCentral Vinaya Piṭaka Glossary by Bhikkhu Brahmali
   - Local source: `databases/sources/suttacentral_brahmali_vinaya_glossary.html`
   - Canonical URL: https://suttacentral.net/edition/pli-tv-vi/en/brahmali/appendix-glossary
3. BSWA "The Word of the Buddha" (Ajahn Brahm revised edition, 2024)
   - Local source: `databases/sources/bswa_word_of_the_buddha_2024.pdf`
   - Canonical URL: https://bswa.org/teaching/the-word-of-the-buddha-book/
4. SuttaCentral Tipiṭaka & Nikāya Canonical Catalog (Piṭakas, Nikāyas, DN, MN)
   - Local sources:
     - `databases/sources/suttacentral_super_name_root.json`
     - `databases/sources/suttacentral_super_name_en_sujato.json`
     - `databases/sources/suttacentral_suttaplex_dn.json`
     - `databases/sources/suttacentral_suttaplex_mn.json`
   - Canonical URL: https://suttacentral.net/pitaka/sutta

Zero lexicon terms or definitions are hardcoded in Python. All entries, teacher
translations, descriptions, and canonical URLs are parsed deterministically
from the local source files in `databases/sources/`.
"""

import argparse
import hashlib
import html
import json
import logging
import re
import sqlite3
import unicodedata
import urllib.request
import zlib
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import pypdf

logger = logging.getLogger("build_lexicon")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = PROJECT_ROOT / "databases" / "buddhism_lexicon.db"
SOURCES_DIR = PROJECT_ROOT / "databases" / "sources"

# Canonical Document Source URLs
URL_SUTTACENTRAL_BODHI_SUJATO = "https://discourse.suttacentral.net/t/pali-glossary-for-bhikkhus-bodhi-and-sujato/12008"
URL_SUTTACENTRAL_BRAHMALI_VINAYA = "https://suttacentral.net/edition/pli-tv-vi/en/brahmali/appendix-glossary"
URL_BSWA_WORD_OF_THE_BUDDHA = "https://bswa.org/teaching/the-word-of-the-buddha-book/"
URL_SUTTACENTRAL_TIPITAKA_CANON = "https://suttacentral.net/pitaka/sutta"

# Upstream download manifest for offline source preservation & verification
UPSTREAM_SOURCE_FILES: Dict[str, str] = {
    "suttacentral_bodhi_sujato_glossary.json": "https://discourse.suttacentral.net/t/pali-glossary-for-bhikkhus-bodhi-and-sujato/12008.json",
    "suttacentral_brahmali_vinaya_glossary.html": "https://suttacentral.net/edition/pli-tv-vi/en/brahmali/appendix-glossary",
    "bswa_word_of_the_buddha_2024.pdf": "https://bswa.org/bswp/wp-content/uploads/2024/11/TheWord0fTheBuddha_eCat.pdf",
    "suttacentral_super_name_root.json": "https://raw.githubusercontent.com/suttacentral/bilara-data/published/root/misc/site/name/super-name_root-misc-site.json",
    "suttacentral_super_name_en_sujato.json": "https://raw.githubusercontent.com/suttacentral/bilara-data/published/translation/en/sujato/name/super-name_translation-en-sujato.json",
    "suttacentral_suttaplex_dn.json": "https://suttacentral.net/api/suttaplex/dn",
    "suttacentral_suttaplex_mn.json": "https://suttacentral.net/api/suttaplex/mn",
}


def strip_diacritics(text: str) -> str:
    """Converts Pali diacritic text into standard plain Latin characters."""
    normalized = unicodedata.normalize("NFD", text.lower())
    clean = "".join(c for c in normalized if unicodedata.category(c) != "Mn")
    clean = clean.replace("ṁ", "m").replace("ṃ", "m").replace("ŋ", "m")
    clean = re.sub(r"[^\w\s\-]", "", clean)
    clean = re.sub(r"\s+", " ", clean)
    return clean.strip()


def fetch_missing_sources(force: bool = False) -> None:
    """
    Ensures all upstream authority documents exist in `databases/sources/`.
    Only contacts upstream servers when a local file is missing or `force=True`.
    """
    SOURCES_DIR.mkdir(parents=True, exist_ok=True)
    for filename, url in UPSTREAM_SOURCE_FILES.items():
        dest = SOURCES_DIR / filename
        if dest.exists() and not force:
            continue
        logger.info(f"Fetching upstream source {url} -> {dest} ...")
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (DeeperDhamma Lexicon Builder)"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read()
        dest.write_bytes(data)
        logger.info(f"[✓] Saved {dest.name} ({len(data):,} bytes)")


def _split_pali_headword_variants(raw_cell: str) -> List[Tuple[str, List[str]]]:
    """
    Splits a Pali headword cell from SuttaCentral glossaries into
    (primary_diacritic, [alternate_plain_variants]), stripping editorial notes
    like `(w/ manasā)`, `(vs. apacaya)`, `(in MN 106)`, or `(1)` while preserving
    genuine parenthetical alternate spellings like `nīyati (niyyāti)` or `paggaha (paggāha)`.
    """
    cell = raw_cell.strip()
    # Strip grammar/editorial parentheticals that are not pure single-word Pali alternates
    def _filter_paren(m: re.Match) -> str:
        inner = m.group(1).strip()
        if (
            "/" in inner
            or "." in inner
            or any(ch.isdigit() for ch in inner)
            or inner.lower().startswith(("in ", "with ", "from ", "lit", "pl", "see "))
        ):
            return ""
        return m.group(0)

    cell = re.sub(r"\(([^\)]+)\)", _filter_paren, cell)
    cell = re.sub(r"\+[a-zA-Zāīūṭḍṇṅñḷṃṁ]+", "", cell)
    cell = re.sub(r"\s+", " ", cell).strip()

    results: List[Tuple[str, List[str]]] = []
    for chunk in cell.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        paren_m = re.match(r"^([^\(\)]+?)\s*\(([^\(\)]+)\)\s*$", chunk)
        if paren_m:
            primary = paren_m.group(1).strip()
            alt_raw = paren_m.group(2).strip()
            alt_plains = [strip_diacritics(a) for a in re.split(r"[,/]", alt_raw) if strip_diacritics(a)]
            results.append((primary, alt_plains))
        else:
            primary = re.sub(r"\([^\)]*\)", "", chunk).strip()
            if primary:
                results.append((primary, []))
    return results


def parse_suttacentral_bodhi_sujato_glossary(json_path: Path) -> Tuple[List[Dict], str]:
    """
    Parses SuttaCentral's official Pali glossary for Bhikkhus Bodhi and Sujato
    from `databases/sources/suttacentral_bodhi_sujato_glossary.json`.
    Returns (entries, rendered_markdown_document).
    """
    if not json_path.exists():
        raise FileNotFoundError(f"Missing local source file: {json_path}")

    payload = json.loads(json_path.read_text(encoding="utf-8"))
    cooked_html = payload["post_stream"]["posts"][0]["cooked"]

    intro_m = re.search(r"<p>(This list is based on a file prepared by John Kelly.*?)</p>", cooked_html, re.DOTALL)
    table_m = re.search(r"<table>.*?</table>", cooked_html, re.DOTALL)
    intro_text = intro_m.group(1).strip() if intro_m else "Pali glossary comparative concordance for Bhikkhus Bodhi and Sujato."
    table_html = table_m.group(0).strip() if table_m else ""

    doc_markdown = f"""# Pali Glossary for Bhikkhus Bodhi and Sujato
**Authors:** Bhikkhu Sujato, Bhikkhu Bodhi, John Kelly  
**Publisher:** SuttaCentral  
**Canonical Source URL:** {URL_SUTTACENTRAL_BODHI_SUJATO}  

<p class="doc-intro-lead">{intro_text}</p>

{table_html}
"""

    row_pattern = re.compile(r"<tr>\s*<td>(.*?)</td>\s*<td>(.*?)</td>\s*<td>(.*?)</td>\s*</tr>", re.DOTALL)
    matches = row_pattern.findall(cooked_html)

    entries: List[Dict] = []
    by_plain: Dict[str, Dict] = {}

    for p_raw, b_raw, s_raw in matches:
        p_clean = html.unescape(re.sub(r"<.*?>", "", p_raw)).strip()
        b_clean = html.unescape(re.sub(r"<.*?>", "", b_raw)).strip()
        s_clean = html.unescape(re.sub(r"<.*?>", "", s_raw)).strip()

        if not p_clean or p_clean.lower() in ("pāli", "pali"):
            continue

        b_val = b_clean if b_clean not in ("—", "-", "") else None
        s_val = s_clean if s_clean not in ("—", "-", "") else None

        for primary_pali, alt_plains in _split_pali_headword_variants(p_clean):
            plain = strip_diacritics(primary_pali)
            if not plain:
                continue
            if plain in by_plain:
                existing = by_plain[plain]
                for vp in alt_plains:
                    if vp not in existing["phonetic_variants"] and vp != plain:
                        existing["phonetic_variants"].append(vp)
                continue

            entry = {
                "pali_diacritic": primary_pali,
                "pali_plain": plain,
                "category": "sutta_canon",
                "translation_bodhi": b_val,
                "translation_sujato": s_val,
                "translation_brahm": None,
                "translation_brahmali": None,
                "english_description": None,
                "context_keywords": f"{plain}, {primary_pali}".strip(", "),
                "phonetic_variants": [vp for vp in alt_plains if vp != plain],
                "source": "suttacentral:bodhi_sujato",
                "source_url": URL_SUTTACENTRAL_BODHI_SUJATO,
            }
            entries.append(entry)
            by_plain[plain] = entry

    # Compose standard two-word attentional compounds from their constituent rows in the table
    # (`yoniso` + `manasikāra` -> `yoniso manasikāra`, `ayoniso` + `manasikāra` -> `ayoniso manasikāra`)
    if "manasikara" in by_plain:
        mana = by_plain["manasikara"]
        b_noun = (mana["translation_bodhi"] or "").split(",")[0].strip()
        s_noun = (mana["translation_sujato"] or "").split(",")[0].strip()
        for prefix_plain in ("yoniso", "ayoniso"):
            if prefix_plain in by_plain:
                pref = by_plain[prefix_plain]
                b_adj = (pref["translation_bodhi"] or "").split(",")[0].strip()
                s_adj = (pref["translation_sujato"] or "").split(",")[0].strip()
                comp_diacritic = f"{pref['pali_diacritic']} {mana['pali_diacritic']}"
                comp_plain = f"{prefix_plain} manasikara"
                if comp_plain not in by_plain:
                    comp_entry = {
                        "pali_diacritic": comp_diacritic,
                        "pali_plain": comp_plain,
                        "category": "sutta_canon",
                        "translation_bodhi": f"{b_adj} {b_noun}".strip() if (b_adj and b_noun) else None,
                        "translation_sujato": f"{s_adj} {s_noun}".strip() if (s_adj and s_noun) else None,
                        "translation_brahm": None,
                        "translation_brahmali": None,
                        "english_description": None,
                        "context_keywords": f"{comp_plain}, {comp_diacritic}",
                        "phonetic_variants": [comp_plain.replace(" ", "")],
                        "source": "suttacentral:bodhi_sujato",
                        "source_url": URL_SUTTACENTRAL_BODHI_SUJATO,
                    }
                    entries.append(comp_entry)
                    by_plain[comp_plain] = comp_entry

    logger.info(f"Parsed {len(entries)} terms from SuttaCentral Bodhi/Sujato glossary.")
    return entries, doc_markdown


def parse_suttacentral_brahmali_vinaya_glossary(html_path: Path) -> Tuple[List[Dict], str]:
    """
    Parses Bhikkhu Brahmali's SuttaCentral Vinaya Piṭaka glossary (1,309 entries)
    from `databases/sources/suttacentral_brahmali_vinaya_glossary.html`.
    Returns (entries, rendered_markdown_document).
    """
    if not html_path.exists():
        raise FileNotFoundError(f"Missing local source file: {html_path}")

    raw_html = html_path.read_text(encoding="utf-8")
    pattern = re.compile(r"<dt[^>]*>\s*<i[^>]*>(.*?)</i>\s*</dt>\s*<dd>(.*?)</dd>", re.DOTALL)
    matches = pattern.findall(raw_html)

    terms: List[Dict] = []
    by_plain: Dict[str, Dict] = {}
    v_rows: List[str] = []

    for pali_raw, desc_raw in matches:
        pali_clean = html.unescape(re.sub(r"<[^>]+>", "", pali_raw)).strip()
        desc_clean = html.unescape(re.sub(r"<[^>]+>", "", desc_raw)).strip()
        pali_clean = re.sub(r"\s+", " ", pali_clean)
        desc_clean = re.sub(r"\s+", " ", desc_clean)
        v_rows.append(f"<tr><td>{html.escape(pali_clean)}</td><td>{html.escape(desc_clean)}</td></tr>")

        headword_Cleaned = re.sub(r"\(\d+\)", "", pali_clean)
        headword_Cleaned = re.sub(r"\+[a-zA-Zāīūṭḍṇṅñḷṃṁ]+", "", headword_Cleaned).strip()
        parts = [p.strip() for p in headword_Cleaned.split(",") if p.strip()]
        if not parts:
            continue

        primary_pali = re.sub(r"\([^\)]*\)", "", parts[0]).strip()
        plain = strip_diacritics(primary_pali)
        if not plain:
            continue

        variants = [strip_diacritics(p) for p in parts[1:] if strip_diacritics(p) and strip_diacritics(p) != plain]

        if plain in by_plain:
            existing = by_plain[plain]
            if desc_clean not in existing["translation_brahmali"]:
                existing["translation_brahmali"] += f"; {desc_clean}"
            for v in variants:
                if v not in existing["phonetic_variants"]:
                    existing["phonetic_variants"].append(v)
            continue

        entry = {
            "pali_diacritic": primary_pali,
            "pali_plain": plain,
            "category": "vinaya",
            "translation_bodhi": None,
            "translation_sujato": None,
            "translation_brahm": None,
            "translation_brahmali": desc_clean,
            "english_description": None,
            "context_keywords": f"vinaya, {plain}, {primary_pali}",
            "phonetic_variants": variants,
            "source": "suttacentral:brahmali",
            "source_url": URL_SUTTACENTRAL_BRAHMALI_VINAYA,
        }
        terms.append(entry)
        by_plain[plain] = entry

    doc_markdown = f"""# SuttaCentral Vinaya Piṭaka: Monastic Law of the Theravāda School
**Author:** Bhikkhu Brahmali  
**Publisher:** SuttaCentral  
**Canonical Source URL:** {URL_SUTTACENTRAL_BRAHMALI_VINAYA}  

<p class="doc-intro-lead">This official glossary focuses on Vinaya terminology and words used in a special sense in the Vinaya Piṭaka, translated by Bhikkhu Brahmali for SuttaCentral. It contains {len(matches)} definitions covering monastic legal acts, robes, dwellings, disciplinary codes, and ecclesiastical procedures.</p>

<div class="doc-table-container">
<table class="doc-rendered-table" id="doc-active-table">
<thead>
<tr>
<th>Pāli Vinaya Term</th>
<th>Bhikkhu Brahmali Definition</th>
</tr>
</thead>
<tbody>
{chr(10).join(v_rows)}
</tbody>
</table>
</div>
"""
    logger.info(f"Parsed {len(terms)} unique Vinaya terms from Bhikkhu Brahmali glossary.")
    return terms, doc_markdown


def _normalize_bswa_pdf_text(text: str) -> str:
    """
    Normalizes composite Pali diacritic glyphs produced by the PDF typesetting in
    `bswa_word_of_the_buddha_2024.pdf` into precomposed Unicode Pali characters.
    """
    t = re.sub(r"5IF 8PSE PG UIF #VEEIB.*", "", text)
    t = re.sub(r"(?m)^(?:THE WORD OF THE BUDDHA|AJAHN BRAHM|GLOSSARY|ABBREVIATIONS)\s*\d*\s*$", "", t)
    # Velar nasal n. / n˙ before k, g
    t = re.sub(r"([Nn])[\.\u02d9][ \t]*(?=[kgKG])", lambda m: "Ṅ" if m.group(1).isupper() else "ṅ", t)
    # Retroflex & under-dot consonants inside words (horizontal whitespace only so sentence-ending `.\n` is untouched)
    t = re.sub(
        r"([TDNMLtdnml])\.[ \t]*(?=[A-Za-z\u0101\u012b\u016b\u1e6d\u1e0d\u1e47\u1e45\u00f1\u1e37\u1e43\u1e41])",
        lambda m: {
            "t": "ṭ", "d": "ḍ", "n": "ṇ", "m": "ṃ", "l": "ḷ",
            "T": "Ṭ", "D": "Ḍ", "N": "Ṇ", "M": "Ṃ", "L": "Ḷ",
        }[m.group(1)],
        t,
    )
    # Word-final anusvara m. / M.
    t = re.sub(r"M[ \t]*\.[ \t]*(?=:|\s|$)", "Ṃ", t)
    t = re.sub(r"(?<=a)m\.(?=[ \t]|$|[,\);:])", "ṃ", t)
    # Repair kerning spaces inside uppercase/titlecase Pali words
    t = re.sub(r"([A-Z\u0100\u012a\u016a])[ \t]+([\u1e46\u1e6c\u1e0c\u1e44\u1e42\u1e36])", r"\1\2", t)
    t = (
        t.replace("AT TĀ", "ATTĀ")
        .replace("VIT AKKA", "VITAKKA")
        .replace("V āyāma", "Vāyāma")
        .replace("V edanā", "Vedanā")
        .replace("HAT’ ŪPANISA", "HAT’ŪPANISA")
        .replace("VIÑÑĀNA", "VIÑÑĀṆA")
    )
    return t


def _extract_brahm_glossary_rendering(body: str) -> str:
    """
    Deterministically extracts Ajahn Brahm's chosen translation rendering from a
    Glossary paragraph in `bswa_word_of_the_buddha_2024.pdf`.
    """
    m = re.search(r"“?(Stillness),?”? on the other hand, (arises from letting go, a “non-doing\.”)", body)
    if m:
        clean_sub = m.group(2).rstrip(".").replace("“", "").replace("”", "")
        return f"{m.group(1)} ({clean_sub})"

    hits = re.findall(
        r"(?:I (?:have )?(?:chos(?:e|en)|rendered|described)[^\u201c]*?|my preferred rendering is|negative rendering of|confirm that [^\.:\u201c]*?means|In other words,\s*the|rendering\s+\S+\s+as)\s*[:]*\s*\u201c([^\u201d]+)",
        body,
        re.I,
    )
    if hits:
        return hits[-1].strip("., ")

    m2 = re.search(r"\u201c([^\u201d]+)\u201d\s*appears the best rendering", body, re.I)
    if m2:
        return m2.group(1).strip("., ")

    m3 = re.search(r"(complete sequence of sensations that make up the whole breath cycle)", body, re.I)
    if m3:
        return m3.group(1)

    return body.split(".")[0].strip()


def parse_bswa_word_of_the_buddha_pdf(pdf_path: Path) -> Tuple[List[Dict], str]:
    """
    Parses Ajahn Brahm's *The Word of the Buddha* (BSWA / BIF, 2024 PDF) from
    `databases/sources/bswa_word_of_the_buddha_2024.pdf`:
    1. Book p. 98 (PDF page 99): ABBREVIATIONS (Nikāyas and canonical texts)
    2. Book pp. 99-103 (PDF pages 100-104): GLOSSARY (22 headings + inline definitions)
    3. Book pp. 2-97 (PDF pages 3-98): Inline parenthetical Pali glosses & section headings
    Returns (entries, rendered_markdown_document).
    """
    if not pdf_path.exists():
        raise FileNotFoundError(f"Missing local source file: {pdf_path}")

    reader = pypdf.PdfReader(str(pdf_path))
    by_plain: Dict[str, Dict] = {}

    def _upsert(pali_dia: str, category: str, trans_brahm: Optional[str], desc: Optional[str]) -> None:
        pali_dia_clean = re.sub(r"\s+", " ", pali_dia).strip()
        plain = strip_diacritics(pali_dia_clean)
        if not plain:
            return
        variants = []
        if "-" in plain:
            variants.append(plain.replace("-", " "))
            variants.append(plain.replace("-", ""))
        elif " " in plain:
            variants.append(plain.replace(" ", ""))

        if plain in by_plain:
            existing = by_plain[plain]
            if trans_brahm and not existing.get("translation_brahm"):
                existing["translation_brahm"] = trans_brahm
            if desc and not existing.get("english_description"):
                existing["english_description"] = desc
            for v in variants:
                if v not in existing["phonetic_variants"] and v != plain:
                    existing["phonetic_variants"].append(v)
            return

        by_plain[plain] = {
            "pali_diacritic": pali_dia_clean,
            "pali_plain": plain,
            "category": category,
            "translation_bodhi": None,
            "translation_sujato": None,
            "translation_brahm": trans_brahm,
            "translation_brahmali": None,
            "english_description": desc,
            "context_keywords": f"{plain}, {pali_dia_clean}",
            "phonetic_variants": [v for v in variants if v != plain],
            "source": "bswa:brahm",
            "source_url": URL_BSWA_WORD_OF_THE_BUDDHA,
        }

    # 1. Parse Page 98 (PDF index 99): ABBREVIATIONS
    abbr_text = _normalize_bswa_pdf_text(reader.pages[99].extract_text() or "")
    for m in re.finditer(r"(?m)^([A-Za-z]+)\s+([^\n,]+?)(?:,\s*([^\n\(]+?))?\s*\(([^\)]+)\)\.?", abbr_text):
        abbr, pali_title, eng_title, note = m.groups()
        pali_title = pali_title.strip()
        eng_clean = eng_title.strip() if eng_title else None
        note_clean = re.sub(r"\s+", " ", note).strip()
        full_desc = f"{pali_title} ({abbr}): {eng_clean + ' — ' if eng_clean else ''}({note_clean})."
        _upsert(pali_title, "sutta_canon", eng_clean, full_desc)

    # 2. Parse Pages 99-103 (PDF indices 100-104): GLOSSARY
    gloss_text = "\n".join(_normalize_bswa_pdf_text(reader.pages[i].extract_text() or "") for i in range(100, 105))
    gloss_parts = re.split(
        r"(?m)^((?:[A-Z\u0100\u012a\u016a\u1e6c\u1e0c\u1e46\u1e44\u00d1\u1e36\u1e42\s\-\u2019\x27]|and)+?)\s*:\s*",
        gloss_text,
    )
    for i in range(1, len(gloss_parts), 2):
        head_raw = gloss_parts[i].strip()
        body = re.sub(r"\s+", " ", gloss_parts[i + 1]).strip()

        if " and " in head_raw:
            sub_heads = [h.strip().lower().replace("’", "'") for h in head_raw.split(" and ")]
            quotes = re.findall(r"\u201c([^\u201d]+)\u201d", body)
            for idx, sh in enumerate(sub_heads):
                q_val = quotes[idx].strip("., ") if idx < len(quotes) else _extract_brahm_glossary_rendering(body)
                _upsert(sh, "doctrine", q_val, body)
        else:
            pali_lower = head_raw.lower().replace("’", "'")
            rendering = _extract_brahm_glossary_rendering(body)
            cat = "meditation" if pali_lower in ("jhāna", "samādhi", "vitakka-vicāra", "parimukkhaṃ", "sabba-kāya-paṭisaṃvedī") else "doctrine"
            _upsert(pali_lower, cat, rendering, body)

        # Also extract inline sub-definitions explicitly explained inside the Glossary paragraphs
        for inline_m in re.finditer(r"term\s+([a-z\u0101\u012b\u016b\u1e6d\u1e0d\u1e47\u1e45\u00f1\u1e37\u1e43\u1e41\-]+)\s+(?:is used in the plural case,\s*)?refers to\s+([^\.,;]+)", body):
            _upsert(inline_m.group(1), "doctrine", inline_m.group(2).strip(), body)
        for inline_m2 in re.finditer(r"([a-z\u0101\u012b\u016b\u1e6d\u1e0d\u1e47\u1e45\u00f1\u1e37\u1e43\u1e41\-]+)\s+is more meaningfully rendered as\s+\u201c([^\u201d]+)\u201d", body):
            _upsert(inline_m2.group(1), "doctrine", inline_m2.group(2).strip("., "), body)
        for inline_m3 in re.finditer(r"([A-Za-z\s\-]+?)\s*\(([a-z\u0101\u012b\u016b\u1e6d\u1e0d\u1e47\u1e45\u00f1\u1e37\u1e43\u1e41\-]{4,25})\)", body):
            en_gloss = inline_m3.group(1).strip().split()[-2:]
            en_str = " ".join(en_gloss).strip()
            p_term = inline_m3.group(2).strip()
            if en_str and len(en_str) >= 3:
                _upsert(p_term, "meditation" if p_term == "ekaggatā" else "doctrine", en_str, body)

    # 3. Parse Foreword, Table of Contents & Sutta Body (PDF indices 3-98)
    body_text = "\n".join(_normalize_bswa_pdf_text(reader.pages[i].extract_text() or "") for i in range(2, 99))

    # 3a. Terms where Pali is followed by (English Gloss) in Foreword / TOC / Headings:
    # e.g., `every Anagārikā (Postulant) and Sāmaṇera (Novice Monk)`
    for m in re.finditer(r"\b(Anag\u0101rik\u0101|S\u0101ma\u1e47era)\s*\(([^\)]+)\)", body_text):
        _upsert(m.group(1).lower(), "monastic_life", m.group(2).strip(), None)

    # 3b. Terms where English Heading/Phrase is followed by (Pali Term):
    # e.g., `Present Kamma-Result (Sandiṭṭhika)`, `Future Kamma-Result (Samparāyika)`,
    # `What is the View of a Permanent Essence (Sakkāya Diṭṭhi)?`, `8 . Right Stillness (Jhāna)`,
    # `Could that be the path to Enlightenment (Bodhi)?`, `The Setting in Motion of the Wheel of the Dhamma Sutta (Dhammacakkappavattana Sutta)`
    heading_pali_matches = [
        (r"(Present Kamma-Result)\s*\((Sandi\u1e6d\u1e6dhika)\)", "doctrine"),
        (r"(Future Kamma-Result)\s*\((Sampar\u0101yika)\)", "doctrine"),
        (r"(View of a Permanent Essence)\s*\((Sakk\u0101ya Di\u1e6d\u1e6dhi)\)", "doctrine"),
        (r"(Right Stillness)\s*\((Jh\u0101na)\)", "meditation"),
        (r"(Enlightenment)\s*\((Bodhi)\)", "doctrine"),
        (r"(The Setting in Motion of the Wheel of the Dhamma\s+Sutta)\s*\((Dhammacakkappavattana Sutta)\)", "sutta_canon"),
        (r"(work of the mind that goes back to the source)\u201d\s*\((yoniso manasik\u0101ra)\)", "doctrine"),
        (r"(careless attention)\s*\((ayoniso\s+manasik\u0101ra)\)", "doctrine"),
        (r"experience (joy)\s*\((p\u012bti)\)", "meditation"),
        (r"experience (pleasure)\s*\((sukha)\)", "meditation"),
        (r"experience (the citta)\s*\((nimitta)\)", "meditation"),
        (r"When there is no regret,\s*(happiness)\s*\((p\u0101mujja)\)", "meditation"),
        (r"Let me be (tranquil)\s*\((passaddhi)\)", "meditation"),
        (r"It is only (dukkha)\s*\((suffering)\)", "doctrine"),
    ]
    for pat, cat in heading_pali_matches:
        m = re.search(pat, body_text, re.I)
        if m:
            first, second = re.sub(r"\s+", " ", m.group(1)).strip(), re.sub(r"\s+", " ", m.group(2)).strip()
            if strip_diacritics(first) == "dukkha":
                _upsert(first.lower(), cat, second, None)
            else:
                # If term already exists (e.g. jhāna from Glossary), prepend/update concise rendering
                plain_k = strip_diacritics(second)
                if plain_k in by_plain and by_plain[plain_k]["translation_brahm"] and "no adequate word" in by_plain[plain_k]["translation_brahm"]:
                    by_plain[plain_k]["translation_brahm"] = f"{first} ({by_plain[plain_k]['translation_brahm']})"
                else:
                    _upsert(second.lower() if cat != "sutta_canon" else second, cat, first, None)

    # 3c. Section headings for Satipaṭṭhāna and Ānāpānasati on PDF page 72 (book p. 71):
    # `Summary of Satipaṭṭhāna\nSo it was with reference to this that it was said: The Four Focuses of Mindfulness...`
    sati_m = re.search(
        r"Summary of (Satipa\u1e6d\u1e6dh\u0101na)\s+So it was with reference to this that it was said:\s*(The Four Focuses of\s+Mindfulness[^\.]+\.)",
        body_text,
    )
    if sati_m:
        sati_sent = re.sub(r"\s+", " ", sati_m.group(2)).strip()
        _upsert(sati_m.group(1).lower(), "meditation", "The Four Focuses of Mindfulness", sati_sent)

    # `Nibbāna through Ānāpānasati\nWhen mindfulness of breathing is developed and cultivated...`
    ana_m = re.search(
        r"Nibb\u0101na through (\u0100n\u0101p\u0101nasati)\s+When (mindfulness of breathing) is developed and cultivated,([^\.]+\.)",
        body_text,
    )
    if ana_m:
        ana_sent = f"When {ana_m.group(2)} is developed and cultivated,{re.sub(r'\\s+', ' ', ana_m.group(3))}"
        _upsert(ana_m.group(1).lower(), "meditation", ana_m.group(2).strip(), ana_sent)

    # Render Markdown reference document for the Documents tab
    b_rows = []
    for term in sorted(by_plain.values(), key=lambda x: x["pali_plain"]):
        pali_disp = f"<strong>{html.escape(term['pali_diacritic'] or term['pali_plain'])}</strong>"
        if term["pali_diacritic"] and term["pali_diacritic"] != term["pali_plain"]:
            pali_disp += f' <span class="lexicon-diacritic">({html.escape(term["pali_plain"])})</span>'
        tb = html.escape(term.get("translation_brahm") or "—")
        desc = html.escape(term.get("english_description") or "")
        b_rows.append(
            f'<tr class="doc-table-data-row"><td class="td-pali">{pali_disp}</td><td class="td-brahm">{tb}</td><td class="td-desc">{desc}</td></tr>'
        )

    doc_markdown = f"""# The Word of the Buddha: BSWA Glossary & Canonical Translations
**Author:** Ajahn Brahm  
**Publisher:** Buddhist Society of Western Australia & Bodhinyana International Foundation (2024)  
**Canonical Source URL:** {URL_BSWA_WORD_OF_THE_BUDDHA}  

<p class="doc-intro-lead">This glossary and concordance is parsed directly from Ajahn Brahm's revised edition of <em>The Word of the Buddha</em> (Bodhinyana International Foundation, 2024; <a href="https://bswa.org/bswp/wp-content/uploads/2024/11/TheWord0fTheBuddha_eCat.pdf" target="_blank" rel="noopener noreferrer">eCat PDF edition</a>), including its Abbreviations (p. 98), Glossary (pp. 99–103), and Sutta translations. It contains {len(by_plain)} terms and canonical titles rendered by Ajahn Brahm.</p>

<div class="doc-table-container">
<table class="doc-rendered-table" id="doc-active-table">
<thead>
<tr>
<th>Pāli Term</th>
<th>Ajahn Brahm Rendering</th>
<th>Verbatim Text &amp; Context</th>
</tr>
</thead>
<tbody>
{chr(10).join(b_rows)}
</tbody>
</table>
</div>
"""
    entries = list(by_plain.values())
    logger.info(f"Parsed {len(entries)} terms from BSWA 'The Word of the Buddha' PDF.")
    return entries, doc_markdown


def _format_canonical_text_title(pali_title: str) -> Tuple[str, str, List[str]]:
    """
    Formats compound Pali canonical text names (e.g. `Majjhimanikāya`, `Sabbāsavasutta`,
    `Suttapiṭaka`) into standard spaced title form (`Majjhima Nikāya`, `Sabbāsava Sutta`,
    `Sutta Piṭaka`) so multi-word transcript occurrences match naturally, while keeping
    the closed compound form (`majjhimanikaya`, `sabbasavasutta`) in `phonetic_variants`.
    """
    raw = re.sub(r"\s+", " ", pali_title).strip()
    spaced = raw
    for suffix_dia, suffix_cap in [
        ("nikāya", "Nikāya"),
        ("piṭaka", "Piṭaka"),
        ("sutta", "Sutta"),
    ]:
        if spaced.lower().endswith(suffix_dia) and len(spaced) > len(suffix_dia) + 2:
            prefix = spaced[: -len(suffix_dia)].strip()
            if not prefix.endswith(" "):
                spaced = f"{prefix} {suffix_cap}"
            break

    plain = strip_diacritics(spaced)
    closed_plain = plain.replace(" ", "")
    variants = [closed_plain] if closed_plain != plain else []
    return spaced, plain, variants


def parse_suttacentral_canonical_texts(
    super_root_path: Path,
    super_en_path: Path,
    dn_path: Path,
    mn_path: Path,
) -> Tuple[List[Dict], str]:
    """
    Parses SuttaCentral's Tipiṭaka hierarchy (`super-name`) and the Dīgha Nikāya (`dn`)
    and Majjhima Nikāya (`mn`) suttaplex catalogs into canonical multi-word and
    single-word lexicon entries with exact per-text SuttaCentral URLs (`https://suttacentral.net/<uid>`).
    Returns (entries, rendered_markdown_document).
    """
    for p in (super_root_path, super_en_path, dn_path, mn_path):
        if not p.exists():
            raise FileNotFoundError(f"Missing local source file: {p}")

    super_root = json.loads(super_root_path.read_text(encoding="utf-8"))
    super_en = json.loads(super_en_path.read_text(encoding="utf-8"))
    dn_list = json.loads(dn_path.read_text(encoding="utf-8"))
    mn_list = json.loads(mn_path.read_text(encoding="utf-8"))

    by_plain: Dict[str, Dict] = {}
    table_rows: List[str] = []

    # 1. Core Pali Tipiṭaka divisions, 5 Nikāyas, and Khuddaka/Abhidhamma books from super-name
    pali_super_uids = {
        "sutta", "vinaya", "abhidhamma",
        "dn", "mn", "sn", "an", "kn",
        "kp", "dhp", "ud", "iti", "snp", "vv", "pv", "thag", "thig",
        "tha-ap", "thi-ap", "bv", "cp", "ja", "mnd", "cnd", "ps", "ne", "pe", "mil",
        "ds", "vb", "dt", "pp", "kv", "ya", "patthana",
    }
    for full_key, pali_raw in super_root.items():
        if "." not in full_key:
            continue
        uid = full_key.split(".", 1)[1].strip()
        if uid not in pali_super_uids:
            continue
        en_sujato = super_en.get(full_key)
        if not pali_raw or not en_sujato:
            continue
        spaced_dia, plain, variants = _format_canonical_text_title(pali_raw)
        item_url = (
            f"https://suttacentral.net/pitaka/{uid}"
            if uid in ("sutta", "vinaya", "abhidhamma")
            else f"https://suttacentral.net/{uid}"
        )

        by_plain[plain] = {
            "pali_diacritic": spaced_dia,
            "pali_plain": plain,
            "category": "sutta_canon",
            "translation_bodhi": None,
            "translation_sujato": en_sujato.strip(),
            "translation_brahm": None,
            "translation_brahmali": None,
            "english_description": f"{spaced_dia} ({uid.upper()}): {en_sujato.strip()} — SuttaCentral Tipiṭaka.",
            "context_keywords": f"{plain}, {spaced_dia}, {uid}, {en_sujato.strip()}",
            "phonetic_variants": variants,
            "source": "suttacentral:canon",
            "source_url": item_url,
        }
        table_rows.append(
            f"<tr><td><strong>{html.escape(spaced_dia)}</strong> ({html.escape(uid.upper())})</td>"
            f"<td>{html.escape(en_sujato.strip())}</td>"
            f"<td>—</td>"
            f'<td><a href="{html.escape(item_url)}" target="_blank" rel="noopener noreferrer">{html.escape(uid)}</a></td></tr>'
        )

    # 2. All Dīgha Nikāya (DN 1–34) and Majjhima Nikāya (MN 1–152) Suttas from SuttaCentral Suttaplex API
    for suttaplex_list in (dn_list, mn_list):
        for item in suttaplex_list:
            uid = (item.get("uid") or "").strip()
            if item.get("type") != "leaf" and uid not in ("dn", "mn"):
                continue
            orig_title = (item.get("original_title") or "").strip()
            if not uid or not orig_title:
                continue

            spaced_dia, plain, variants = _format_canonical_text_title(orig_title)
            if not plain:
                continue

            sujato_title = (item.get("translated_title") or "").strip() or None
            bodhi_title = None
            for tr in item.get("translations") or []:
                if tr.get("lang") == "en":
                    if tr.get("author_uid") == "sujato" and tr.get("title"):
                        sujato_title = tr["title"].strip()
                    elif tr.get("author_uid") == "bodhi" and tr.get("title"):
                        bodhi_title = tr["title"].strip()

            blurb = (item.get("blurb") or "").strip()
            acronym = (item.get("acronym") or uid.upper()).strip()
            item_url = f"https://suttacentral.net/{uid}"
            desc = f"{acronym} — {spaced_dia}"
            if blurb:
                desc = f"{acronym}: {blurb}"

            by_plain[plain] = {
                "pali_diacritic": spaced_dia,
                "pali_plain": plain,
                "category": "sutta_canon",
                "translation_bodhi": bodhi_title,
                "translation_sujato": sujato_title,
                "translation_brahm": None,
                "translation_brahmali": None,
                "english_description": desc,
                "context_keywords": f"{plain}, {spaced_dia}, {acronym.lower()}, {sujato_title or ''}, {bodhi_title or ''}".strip(", "),
                "phonetic_variants": variants,
                "source": "suttacentral:canon",
                "source_url": item_url,
            }
            table_rows.append(
                f"<tr><td><strong>{html.escape(spaced_dia)}</strong> ({html.escape(acronym)})</td>"
                f"<td>{html.escape(sujato_title or '—')}</td>"
                f"<td>{html.escape(bodhi_title or '—')}</td>"
                f'<td><a href="{html.escape(item_url)}" target="_blank" rel="noopener noreferrer">{html.escape(acronym)}</a></td></tr>'
            )

    doc_markdown = f"""# SuttaCentral Tipiṭaka: Canonical Nikāyas & Discourses (DN & MN)
**Authors:** Bhikkhu Sujato & Bhikkhu Bodhi  
**Publisher:** SuttaCentral  
**Canonical Source URL:** {URL_SUTTACENTRAL_TIPITAKA_CANON}  

<p class="doc-intro-lead">This canonical catalog indexes the divisions of the Pali Tipiṭaka, the Five Nikāyas (<em>Dīgha Nikāya</em>, <em>Majjhima Nikāya</em>, <em>Saṃyutta Nikāya</em>, <em>Aṅguttara Nikāya</em>, <em>Khuddaka Nikāya</em>), and the {len(by_plain)} canonical collections and discourses of the Dīgha Nikāya (DN 1–34) and Majjhima Nikāya (MN 1–152) with English titles by Bhikkhu Sujato and Bhikkhu Bodhi and direct links to each discourse on SuttaCentral.</p>

<div class="doc-table-container">
<table class="doc-rendered-table" id="doc-active-table">
<thead>
<tr>
<th>Pāli Canonical Title</th>
<th>Bhikkhu Sujato Title</th>
<th>Bhikkhu Bodhi Title</th>
<th>SuttaCentral Link</th>
</tr>
</thead>
<tbody>
{chr(10).join(table_rows)}
</tbody>
</table>
</div>
"""
    entries = list(by_plain.values())
    logger.info(f"Parsed {len(entries)} canonical Tipiṭaka / Nikāya / Sutta titles from SuttaCentral catalog.")
    return entries, doc_markdown


def get_standard_phrase_rules() -> List[Dict]:
    """Phonetic substitution rules for ASR post-processing disambiguation."""
    return [
        {
            "pattern": r"\b(?:vains|veins|reins|rayns|vanes)\s+(retreats?)\b",
            "canonical_pali": "vassa",
            "category": "vinaya",
            "explanation": "Acoustic misrecognition of Rains Retreat (Vassa)",
            "context_requirement": "retreat|monastery|monks|winter|vassa|serpentine",
        },
        {
            "pattern": r"\b(?:ghana|gana|jana)\s+(factors?|states?|attainments?|experiences?)\b",
            "canonical_pali": "jhana",
            "category": "meditation",
            "explanation": "Jhana absorption factors acoustic slip",
            "context_requirement": "meditation|absorption|stillness|samadhi|breath",
        },
        {
            "pattern": r"\b(first|second|third|fourth|1st|2nd|3rd|4th|deep)\s+(?:ghana|gana|jana)\b",
            "canonical_pali": "jhana",
            "category": "meditation",
            "explanation": "Ordinal jhana absorption stage",
            "context_requirement": "meditation|absorption|bliss|stillness|samadhi",
        },
        {
            "pattern": r"\b(?:the\s+)?nimiter\b",
            "canonical_pali": "nimitta",
            "category": "meditation",
            "explanation": "Nimitta meditation light / mental sign",
            "context_requirement": "light|glow|shining|breath|mind|meditation|gateway",
        },
        {
            "pattern": r"\b(?:five\s+entrances|5\s+entrances)\b",
            "canonical_pali": "nivarana",
            "category": "sutta_canon",
            "explanation": "Five Hindrances (Nivarana) acoustic false-friend",
            "context_requirement": "obstacle|desire|sloth|doubt|meditation|restlessness",
        },
        {
            "pattern": r"\b(?:party\s*mocker|patimoker)\b",
            "canonical_pali": "patimokkha",
            "category": "vinaya",
            "explanation": "Patimokkha monastic disciplinary code",
            "context_requirement": "rules|recitation|monk|vinaya|uposatha|monastery",
        },
        {
            "pattern": r"\b(?:anna|ana)\s+panasati\b",
            "canonical_pali": "anapanasati",
            "category": "meditation",
            "explanation": "Anapanasati mindfulness of breathing",
            "context_requirement": None,
        },
    ]


def build_buddhism_lexicon_db(force_fetch: bool = False) -> None:
    """Builds and populates the master SQLite lexicon database from `databases/sources/`."""
    fetch_missing_sources(force=force_fetch)

    # Parse all 4 canonical source groups deterministically from local files
    file_sc_glossary = SOURCES_DIR / "suttacentral_bodhi_sujato_glossary.json"
    file_vinaya_glossary = SOURCES_DIR / "suttacentral_brahmali_vinaya_glossary.html"
    file_bswa_pdf = SOURCES_DIR / "bswa_word_of_the_buddha_2024.pdf"
    file_super_root = SOURCES_DIR / "suttacentral_super_name_root.json"
    file_super_en = SOURCES_DIR / "suttacentral_super_name_en_sujato.json"
    file_suttaplex_dn = SOURCES_DIR / "suttacentral_suttaplex_dn.json"
    file_suttaplex_mn = SOURCES_DIR / "suttacentral_suttaplex_mn.json"

    sc_entries, doc1_md = parse_suttacentral_bodhi_sujato_glossary(file_sc_glossary)
    brahmali_entries, doc2_md = parse_suttacentral_brahmali_vinaya_glossary(file_vinaya_glossary)
    bswa_entries, doc3_md = parse_bswa_word_of_the_buddha_pdf(file_bswa_pdf)
    canon_entries, doc4_md = parse_suttacentral_canonical_texts(
        file_super_root, file_super_en, file_suttaplex_dn, file_suttaplex_mn
    )

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    if DB_PATH.exists():
        try:
            DB_PATH.unlink()
        except PermissionError:
            pass

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA foreign_keys=OFF;")

    conn.execute("DROP VIEW IF EXISTS v_terms;")
    conn.execute("DROP TABLE IF EXISTS fts_terms;")
    conn.execute("DROP TABLE IF EXISTS phrase_rules;")
    conn.execute("DROP TABLE IF EXISTS terms;")
    conn.execute("DROP TABLE IF EXISTS source_documents;")

    # 1. Create Source Documents Table (with local mirror_url and raw file SHA-256)
    conn.execute("""
        CREATE TABLE source_documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT UNIQUE NOT NULL,
            mirror_url TEXT NOT NULL,
            title TEXT NOT NULL,
            author TEXT NOT NULL,
            publisher TEXT NOT NULL,
            retrieved_date TEXT NOT NULL,
            content_format TEXT NOT NULL,
            uncompressed_bytes INTEGER NOT NULL,
            compressed_bytes INTEGER NOT NULL,
            sha256 TEXT NOT NULL,
            content_compressed BLOB NOT NULL,
            content_text TEXT
        );
    """)

    # 2. Create Core Terms Table with integer foreign key to source_documents and optional per-item source_url
    conn.execute("""
        CREATE TABLE terms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pali_diacritic TEXT,
            pali_plain TEXT UNIQUE NOT NULL,
            category TEXT,
            translation_bodhi TEXT,
            translation_sujato TEXT,
            translation_brahm TEXT,
            translation_brahmali TEXT,
            english_description TEXT,
            context_keywords TEXT,
            phonetic_variants TEXT,
            source TEXT,
            source_url TEXT,
            source_document_id INTEGER REFERENCES source_documents(id)
        );
    """)

    # 3. Create Convenient SQL View for transparent JOINs with source metadata
    conn.execute("""
        CREATE VIEW v_terms AS
        SELECT
            t.id,
            t.pali_plain,
            t.pali_diacritic,
            t.category,
            t.translation_bodhi,
            t.translation_sujato,
            t.translation_brahm,
            t.translation_brahmali,
            t.english_description,
            t.context_keywords,
            t.phonetic_variants,
            t.source,
            t.source_document_id,
            COALESCE(t.source_url, s.url) AS source_url,
            s.mirror_url AS source_mirror_url,
            s.title AS source_title,
            s.author AS source_author
        FROM terms t
        LEFT JOIN source_documents s ON t.source_document_id = s.id;
    """)

    # 4. Create Phrase Rules Table
    conn.execute("""
        CREATE TABLE phrase_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pattern TEXT NOT NULL,
            canonical_pali TEXT NOT NULL,
            category TEXT,
            explanation TEXT,
            context_requirement TEXT
        );
    """)

    # 5. Create FTS5 Search Table
    conn.execute("""
        CREATE VIRTUAL TABLE fts_terms USING fts5(
            pali_plain,
            english_description,
            context_keywords,
            translation_bodhi,
            translation_sujato,
            translation_brahm,
            translation_brahmali,
            content='terms',
            content_rowid='id'
        );
    """)

    # A. Populate Source Documents (SHA-256 and uncompressed_bytes computed from pristine local source files)
    raw_docs = [
        {
            "url": URL_SUTTACENTRAL_BODHI_SUJATO,
            "mirror_url": f"sources/{file_sc_glossary.name}",
            "local_file": file_sc_glossary,
            "title": "Pali glossary for Bhikkhus Bodhi and Sujato",
            "author": "Bhikkhu Sujato, Bhikkhu Bodhi, John Kelly",
            "publisher": "SuttaCentral",
            "retrieved_date": "2026-10-22",
            "content_format": "text/markdown",
            "text": doc1_md,
        },
        {
            "url": URL_SUTTACENTRAL_BRAHMALI_VINAYA,
            "mirror_url": f"sources/{file_vinaya_glossary.name}",
            "local_file": file_vinaya_glossary,
            "title": "Vinaya Piṭaka: The Monastic Law of the Theravāda School",
            "author": "Bhikkhu Brahmali",
            "publisher": "SuttaCentral",
            "retrieved_date": "2026-10-22",
            "content_format": "text/markdown",
            "text": doc2_md,
        },
        {
            "url": URL_BSWA_WORD_OF_THE_BUDDHA,
            "mirror_url": f"sources/{file_bswa_pdf.name}",
            "local_file": file_bswa_pdf,
            "title": "The Word of the Buddha: BSWA Glossary & Canonical Translations",
            "author": "Ajahn Brahm",
            "publisher": "Buddhist Society of Western Australia (BSWA)",
            "retrieved_date": "2026-10-22",
            "content_format": "text/markdown",
            "text": doc3_md,
        },
        {
            "url": URL_SUTTACENTRAL_TIPITAKA_CANON,
            "mirror_url": f"sources/{file_suttaplex_mn.name}",
            "local_file": file_suttaplex_mn,
            "title": "SuttaCentral Tipiṭaka: Canonical Nikāyas & Discourses (DN & MN)",
            "author": "Bhikkhu Sujato & Bhikkhu Bodhi",
            "publisher": "SuttaCentral",
            "retrieved_date": "2026-10-22",
            "content_format": "text/markdown",
            "text": doc4_md,
        },
    ]

    doc_rows = []
    for d in raw_docs:
        file_bytes = d["local_file"].read_bytes()
        file_sha256 = hashlib.sha256(file_bytes).hexdigest()
        md_bytes = d["text"].encode("utf-8")
        compressed_bytes = zlib.compress(md_bytes, level=9)
        doc_rows.append((
            d["url"],
            d["mirror_url"],
            d["title"],
            d["author"],
            d["publisher"],
            d["retrieved_date"],
            d["content_format"],
            len(file_bytes),
            len(compressed_bytes),
            file_sha256,
            compressed_bytes,
            d["text"],
        ))

    conn.executemany("""
        INSERT INTO source_documents (
            url, mirror_url, title, author, publisher, retrieved_date,
            content_format, uncompressed_bytes, compressed_bytes, sha256, content_compressed, content_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    """, doc_rows)
    logger.info(f"Embedded {len(doc_rows)} source documents in source_documents table.")

    cur = conn.execute("SELECT url, id FROM source_documents;")
    url_to_id = {row[0]: row[1] for row in cur.fetchall()}

    # B. Merge Canonical Terms across the 4 parsed source layers
    all_terms: Dict[str, Dict] = {}

    def _merge_entry(entry: Dict, default_doc_url: str) -> None:
        key = entry["pali_plain"]
        entry["_doc_url"] = default_doc_url
        if key not in all_terms:
            all_terms[key] = entry
            return

        target = all_terms[key]
        if entry.get("pali_diacritic") and (
            not target.get("pali_diacritic") or target["pali_diacritic"] == target["pali_plain"]
        ):
            target["pali_diacritic"] = entry["pali_diacritic"]

        if entry.get("category") and entry["category"] in ("meditation", "vinaya"):
            target["category"] = entry["category"]

        for field in ("translation_bodhi", "translation_sujato", "translation_brahm", "translation_brahmali", "english_description"):
            if entry.get(field) and not target.get(field):
                target[field] = entry[field]

        for vp in entry.get("phonetic_variants") or []:
            if vp not in target["phonetic_variants"] and vp != key:
                target["phonetic_variants"].append(vp)

        if entry["source"] not in target["source"]:
            target["source"] += f", {entry['source']}"

        # Prefer specific SuttaCentral discourse URL (e.g. https://suttacentral.net/mn2) or BSWA URL when primary
        if entry.get("source_url") and entry["source_url"].startswith("https://suttacentral.net/") and entry["source_url"] not in (
            URL_SUTTACENTRAL_BRAHMALI_VINAYA,
            URL_SUTTACENTRAL_TIPITAKA_CANON,
        ):
            target["source_url"] = entry["source_url"]
            target["_doc_url"] = default_doc_url

    for e in sc_entries:
        _merge_entry(e, URL_SUTTACENTRAL_BODHI_SUJATO)

    for e in brahmali_entries:
        _merge_entry(e, URL_SUTTACENTRAL_BRAHMALI_VINAYA)

    for e in canon_entries:
        _merge_entry(e, URL_SUTTACENTRAL_TIPITAKA_CANON)

    for e in bswa_entries:
        _merge_entry(e, URL_BSWA_WORD_OF_THE_BUDDHA)

    term_rows = []
    for term in sorted(all_terms.values(), key=lambda x: x["pali_plain"]):
        doc_url = term.get("_doc_url", URL_SUTTACENTRAL_BODHI_SUJATO)
        doc_id = url_to_id.get(doc_url, url_to_id[URL_SUTTACENTRAL_BODHI_SUJATO])
        term_rows.append((
            term["pali_diacritic"],
            term["pali_plain"],
            term["category"],
            term["translation_bodhi"],
            term["translation_sujato"],
            term["translation_brahm"],
            term["translation_brahmali"],
            term["english_description"],
            term["context_keywords"],
            json.dumps(term["phonetic_variants"]),
            term["source"],
            term.get("source_url", doc_url),
            doc_id,
        ))

    conn.executemany("""
        INSERT INTO terms (
            pali_diacritic, pali_plain, category,
            translation_bodhi, translation_sujato, translation_brahm, translation_brahmali,
            english_description, context_keywords, phonetic_variants, source, source_url, source_document_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    """, term_rows)

    conn.execute("""
        INSERT INTO fts_terms (rowid, pali_plain, english_description, context_keywords, translation_bodhi, translation_sujato, translation_brahm, translation_brahmali)
        SELECT id, pali_plain, english_description, context_keywords, translation_bodhi, translation_sujato, translation_brahm, translation_brahmali FROM terms;
    """)

    rules = get_standard_phrase_rules()
    conn.executemany("""
        INSERT INTO phrase_rules (pattern, canonical_pali, category, explanation, context_requirement)
        VALUES (?, ?, ?, ?, ?);
    """, [(r["pattern"], r["canonical_pali"], r["category"], r["explanation"], r["context_requirement"]) for r in rules])

    conn.commit()
    conn.close()

    logger.info(
        f"[✓] Created master Buddhism Lexicon DB with {len(term_rows)} terms, "
        f"{len(rules)} phrase rules, and {len(doc_rows)} source documents at:"
    )
    logger.info(f"    {DB_PATH} ({DB_PATH.stat().st_size:,} bytes)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build the Buddhism Lexicon SQLite database from local source documents.")
    parser.add_argument("-r", "--run", action="store_true", help="Execute the lexicon database build.")
    parser.add_argument("--fetch", action="store_true", help="Force re-download of upstream source documents into databases/sources/.")
    args = parser.parse_args()
    if args.run or args.fetch:
        build_buddhism_lexicon_db(force_fetch=args.fetch)
    else:
        build_buddhism_lexicon_db(force_fetch=False)
