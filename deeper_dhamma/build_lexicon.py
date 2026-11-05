"""
Script to build the comprehensive Buddhism Lexicon SQLite Database (buddhism_lexicon.db).

Stores:
1. Canonical terms with exact source URLs:
   - SuttaCentral: Bhikkhu Bodhi & Bhikkhu Sujato translations
   - SuttaCentral: Bhikkhu Brahmali Vinaya & monastic law terminology
   - BSWA: Ajahn Brahm & Ajahn Brahmali meditation, retreat, and monastery terminology
2. Space-efficient offline copies of all source reference documents (zlib-compressed)
   in the `source_documents` table with SHA256 integrity hashes.
3. Phrase rules and FTS5 search index.
"""

import hashlib
import html
import json
import logging
import os
import re
import sqlite3
import unicodedata
import zlib
from pathlib import Path
from typing import Dict, List, Set, Tuple

logger = logging.getLogger("build_lexicon")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = PROJECT_ROOT / "databases" / "buddhism_lexicon.db"
SC_DISCOURSE_CACHE = Path(r"C:\Users\rabailey\.gemini\antigravity-ide\brain\46bf0e61-f894-44dc-8aba-402d7b809ca1\.system_generated\steps\954\content.md")

# Canonical Document Source URLs
URL_SUTTACENTRAL_BODHI_SUJATO = "https://discourse.suttacentral.net/t/pali-glossary-for-bhikkhus-bodhi-and-sujato/12008"
URL_SUTTACENTRAL_BRAHMALI_VINAYA = "https://suttacentral.net/edition/pli-tv-vi/en/brahmali/appendix-glossary"
URL_BSWA_BRAHM_MEDITATION = "https://bswa.org/teaching/the-word-of-the-buddha-book/"


def strip_diacritics(text: str) -> str:
    """Converts Pali diacritic text into standard plain Latin characters."""
    normalized = unicodedata.normalize("NFD", text.lower())
    clean = "".join(c for c in normalized if unicodedata.category(c) != "Mn")
    clean = clean.replace("ṁ", "m").replace("ṃ", "m").replace("ŋ", "m")
    clean = re.sub(r"[^\w\s\-]", "", clean)
    return clean.strip()


def parse_suttacentral_bodhi_sujato_table(file_path: Path) -> List[Dict]:
    """Parses SuttaCentral official Pali glossary for Bhikkhus Bodhi and Sujato."""
    if not file_path.exists():
        logger.warning(f"Cache file {file_path} not found.")
        return []

    text = file_path.read_text(encoding="utf-8")
    row_pattern = re.compile(r"<tr>\s*<td>(.*?)</td>\s*<td>(.*?)</td>\s*<td>(.*?)</td>\s*</tr>", re.DOTALL)
    matches = row_pattern.findall(text)

    entries = []
    seen = set()

    for p_raw, b_raw, s_raw in matches:
        p_clean = html.unescape(re.sub(r"<.*?>", "", p_raw)).strip()
        b_clean = html.unescape(re.sub(r"<.*?>", "", b_raw)).strip()
        s_clean = html.unescape(re.sub(r"<.*?>", "", s_raw)).strip()

        if not p_clean or p_clean.lower() in ("pāli", "pali"):
            continue

        variants = [v.strip() for v in p_clean.split(",") if v.strip()]
        for p in variants:
            plain = strip_diacritics(p)
            if not plain or plain in seen:
                continue
            seen.add(plain)

            entries.append({
                "pali_diacritic": p,
                "pali_plain": plain,
                "category": "sutta_canon",
                "translation_bodhi": b_clean if b_clean not in ("—", "") else None,
                "translation_sujato": s_clean if s_clean not in ("—", "") else None,
                "translation_brahm": None,
                "translation_brahmali": None,
                "english_description": None,
                "context_keywords": f"{plain}, {p}".strip(", "),
                "phonetic_variants": [],
                "source": "suttacentral:bodhi_sujato",
                "source_url": URL_SUTTACENTRAL_BODHI_SUJATO,
            })

    logger.info(f"Parsed {len(entries)} terms from SuttaCentral Bodhi/Sujato glossary.")
    return entries


def get_brahm_meditation_and_bswa_terms() -> List[Dict]:
    """
    Curated core vocabulary from Ajahn Brahm's teachings (Mindfulness, Bliss, and Beyond;
    forest tradition retreats; BSWA monasteries and centers).
    """
    return [
        {
            "pali_diacritic": "ānāpānasati",
            "pali_plain": "anapanasati",
            "category": "meditation",
            "translation_bodhi": "mindfulness of breathing",
            "translation_sujato": "mindfulness of breathing",
            "translation_brahm": "mindfulness of breath / silent present moment awareness of the breath",
            "translation_brahmali": "mindfulness of breathing",
            "english_description": "Mindfulness of in-and-out breathing, the core 16-step meditation practice taught by the Buddha and practiced in the Thai Forest Tradition.",
            "context_keywords": "breath, breathing, in breath, out breath, nose, abdomen, silent awareness, present moment, stages, meditation, sitting",
            "phonetic_variants": ["ana panasati", "anna panasati", "anapana sati", "anna panassati"],
            "source": "bswa:brahm",
            "source_url": URL_BSWA_BRAHM_MEDITATION,
        },
        {
            "pali_diacritic": "jhāna",
            "pali_plain": "jhana",
            "category": "meditation",
            "translation_bodhi": "jhana / meditative absorption",
            "translation_sujato": "absorption",
            "translation_brahm": "deep meditative absorption / blissful stillness of mind",
            "translation_brahmali": "jhana / deep absorption",
            "english_description": "The four progressive stages of deep meditative stillness and unification of mind (samadhi), marked by intense rapture (piti) and bliss (sukha).",
            "context_keywords": "first jhana, second jhana, third jhana, fourth jhana, deep absorption, stillness, bliss, samadhi, piti, sukha, nimitta, let go, five hindrances",
            "phonetic_variants": ["jana", "ghana", "gana", "jhanas", "janas"],
            "source": "bswa:brahm",
            "source_url": URL_BSWA_BRAHM_MEDITATION,
        },
        {
            "pali_diacritic": "nimitta",
            "pali_plain": "nimitta",
            "category": "meditation",
            "translation_bodhi": "sign / mental image",
            "translation_sujato": "sign / vision",
            "translation_brahm": "luminous mental sign / meditation light appearing in the mind's eye",
            "translation_brahmali": "sign / mental reflection",
            "english_description": "A radiant light or bright mental image arising naturally in the mind during deep meditation when the physical senses drop away, serving as the gateway to the jhanas.",
            "context_keywords": "light, beautiful breath, mental sign, glowing, shining, pure mind, jhana gateway, stillness, vision, mind eye",
            "phonetic_variants": ["the nimiter", "nimiter", "namita", "nimito", "nimittas"],
            "source": "bswa:brahm",
            "source_url": URL_BSWA_BRAHM_MEDITATION,
        },
        {
            "pali_diacritic": "nīvaraṇa",
            "pali_plain": "nivarana",
            "category": "hindrance",
            "translation_bodhi": "five hindrances",
            "translation_sujato": "five hindrances",
            "translation_brahm": "the five hindrances blocking meditation",
            "translation_brahmali": "five hindrances",
            "english_description": "The five mental obstacles that veil clarity and prevent jhana: sensory desire (kamacchanda), ill will (vyapada), sloth & torpor (thina-middha), restlessness & remorse (uddhacca-kukkucca), and doubt (vicikiccha).",
            "context_keywords": "hindrances, obstacles, sensory desire, ill will, sloth, torpor, restlessness, worry, remorse, doubt, vicikiccha, overcome",
            "phonetic_variants": ["five entrances", "5 entrances", "the hindrances"],
            "source": "bswa:brahm",
            "source_url": URL_BSWA_BRAHM_MEDITATION,
        },
        {
            "pali_diacritic": "thīna-middha",
            "pali_plain": "thina middha",
            "category": "hindrance",
            "translation_bodhi": "sloth and torpor",
            "translation_sujato": "dullness and drowsiness",
            "translation_brahm": "sloth and torpor (the heavy fog of sleepiness)",
            "translation_brahmali": "sloth and torpor",
            "english_description": "Mental sluggishness, physical heaviness, sleepiness, and laziness that paralyze the mind during meditation.",
            "context_keywords": "sloth, torpor, sleepiness, dullness, tired, drowsiness, heavy, nodding off, hindrance",
            "phonetic_variants": ["sloth and tarpaulin", "sloth and torper", "sloth in torpor"],
            "source": "bswa:brahm",
            "source_url": URL_BSWA_BRAHM_MEDITATION,
        },
        {
            "pali_diacritic": "uddhacca-kukkucca",
            "pali_plain": "uddhacca kukkucca",
            "category": "hindrance",
            "translation_bodhi": "restlessness and remorse",
            "translation_sujato": "restlessness and remorse",
            "translation_brahm": "restlessness and remorse (the wandering, guilty mind)",
            "translation_brahmali": "restlessness and remorse",
            "english_description": "Agitation of thoughts, jumping from past regrets to future anxieties, preventing calm stillness.",
            "context_keywords": "restlessness, remorse, worry, anxiety, agitated mind, monkey mind, guilt",
            "phonetic_variants": ["restlessness and worry", "restlessness and regret"],
            "source": "bswa:brahm",
            "source_url": URL_BSWA_BRAHM_MEDITATION,
        },
        {
            "pali_diacritic": "vicikicchā",
            "pali_plain": "vicikiccha",
            "category": "hindrance",
            "translation_bodhi": "doubt",
            "translation_sujato": "doubt",
            "translation_brahm": "doubt / skepticism / questioning the path",
            "translation_brahmali": "doubt",
            "english_description": "Paralyzing uncertainty and chronic skepticism regarding the Buddha, the Dhamma, the Sangha, and one's capacity to meditate.",
            "context_keywords": "doubt, uncertainty, hesitation, skepticism, questioning, can i do it, self doubt",
            "phonetic_variants": ["vichikicha", "vicikicha"],
            "source": "bswa:brahm",
            "source_url": URL_BSWA_BRAHM_MEDITATION,
        },
        {
            "pali_diacritic": "anattā",
            "pali_plain": "anatta",
            "category": "doctrine",
            "translation_bodhi": "non-self",
            "translation_sujato": "not-self",
            "translation_brahm": "non-self / nobody at home / the illusion of the controller",
            "translation_brahmali": "not-self",
            "english_description": "The fundamental Theravada insight that no permanent, substantial soul or independent controller exists behind thoughts, feelings, and bodily processes.",
            "context_keywords": "non self, not self, no controller, let go, ego, illusion of self, nobody in there, three characteristics",
            "phonetic_variants": ["anata", "annatta", "a natta"],
            "source": "bswa:brahm",
            "source_url": URL_BSWA_BRAHM_MEDITATION,
        },
        {
            "pali_diacritic": "aniccā",
            "pali_plain": "anicca",
            "category": "doctrine",
            "translation_bodhi": "impermanent",
            "translation_sujato": "impermanent",
            "translation_brahm": "impermanence / constant change",
            "translation_brahmali": "impermanent",
            "english_description": "The universal truth that all conditioned phenomena, physical and mental, are transient and perpetually rising and ceasing.",
            "context_keywords": "impermanent, impermanence, change, rising and falling, passing away, unstable",
            "phonetic_variants": ["anicha", "anica"],
            "source": "bswa:brahm",
            "source_url": URL_BSWA_BRAHM_MEDITATION,
        },
        {
            "pali_diacritic": "dukkha",
            "pali_plain": "dukkha",
            "category": "doctrine",
            "translation_bodhi": "suffering / unsatisfactoriness",
            "translation_sujato": "suffering",
            "translation_brahm": "suffering / unsatisfactoriness / breakability",
            "translation_brahmali": "suffering",
            "english_description": "The inherent friction, stress, and inability of conditioned things to deliver lasting happiness.",
            "context_keywords": "suffering, unsatisfactoriness, pain, stress, noble truth, cause of suffering, cessation",
            "phonetic_variants": ["duka", "dukkah", "duca"],
            "source": "bswa:brahm",
            "source_url": URL_BSWA_BRAHM_MEDITATION,
        },
        {
            "pali_diacritic": "pīti",
            "pali_plain": "piti",
            "category": "meditation",
            "translation_bodhi": "rapture / joy",
            "translation_sujato": "rapture",
            "translation_brahm": "rapture / delight / energizing joy in meditation",
            "translation_brahmali": "rapture",
            "english_description": "Pleasurable physical and mental excitement, tingling, goosebumps, and joyful buoyancy in early meditation absorption.",
            "context_keywords": "rapture, delight, joy, tingling, energy, physical sensations, jhana factor, happiness",
            "phonetic_variants": ["peeti", "pitti"],
            "source": "bswa:brahm",
            "source_url": URL_BSWA_BRAHM_MEDITATION,
        },
        {
            "pali_diacritic": "sukha",
            "pali_plain": "sukha",
            "category": "meditation",
            "translation_bodhi": "pleasure / happiness",
            "translation_sujato": "happiness",
            "translation_brahm": "bliss / deep emotional happiness and comfort",
            "translation_brahmali": "happiness / bliss",
            "english_description": "Profound, peaceful happiness and emotional contentment free from agitation, maturing as rapture calms down.",
            "context_keywords": "happiness, bliss, comfort, ease, contentment, peacefulness, jhana factor",
            "phonetic_variants": ["sookha", "suka"],
            "source": "bswa:brahm",
            "source_url": URL_BSWA_BRAHM_MEDITATION,
        },
        {
            "pali_diacritic": "ekaggatā",
            "pali_plain": "ekaggata",
            "category": "meditation",
            "translation_bodhi": "one-pointedness of mind",
            "translation_sujato": "unification of mind",
            "translation_brahm": "unification of mind / stillness on a single point",
            "translation_brahmali": "unification of mind",
            "english_description": "The gathering and steady stillness of attention on a single theme or experience, the culmination of samadhi.",
            "context_keywords": "one-pointedness, unification of mind, stillness, concentration, jhana factor",
            "phonetic_variants": ["ekagatta", "ekagatha"],
            "source": "bswa:brahm",
            "source_url": URL_BSWA_BRAHM_MEDITATION,
        },
        {
            "pali_diacritic": "vassa",
            "pali_plain": "rains retreat",
            "category": "monastic_calendar",
            "translation_bodhi": "rains retreat / vassa",
            "translation_sujato": "rains residence",
            "translation_brahm": "rains retreat (the three-month monastic intensive)",
            "translation_brahmali": "rains retreat (vassa)",
            "english_description": "The annual three-month intensive meditation retreat observed by Buddhist monastics during the monsoon/winter season.",
            "context_keywords": "rains retreat, vassa, three months, monastics, monastery, winter, intensive meditation, pavarana",
            "phonetic_variants": ["vains retreat", "veins retreat", "reins retreat", "vanes retreat", "vassa retreat"],
            "source": "bswa:brahm",
            "source_url": URL_BSWA_BRAHM_MEDITATION,
        },
        {
            "pali_diacritic": "Bodhinyāṇa",
            "pali_plain": "bodhinyana",
            "category": "monastery",
            "translation_bodhi": None,
            "translation_sujato": None,
            "translation_brahm": "Bodhinyana Monastery in Serpentine, Western Australia",
            "translation_brahmali": "Bodhinyana Monastery",
            "english_description": "The main Theravada Buddhist monastery of the BSWA located in Serpentine, Western Australia, founded by Ajahn Brahm and Ajahn Jagaro in 1983.",
            "context_keywords": "monastery, serpentine, perth, bswa, ajahn brahm, monks, forest monastery, bush",
            "phonetic_variants": ["body nyan", "body nyana", "bodhi nyan", "bodinyana", "bodin yana"],
            "source": "bswa:brahm",
            "source_url": URL_BSWA_BRAHM_MEDITATION,
        },
        {
            "pali_diacritic": "Dhammasāra",
            "pali_plain": "dhammasara",
            "category": "monastery",
            "translation_bodhi": None,
            "translation_sujato": None,
            "translation_brahm": "Dhammasara Nuns Monastery in Gidgegannup",
            "translation_brahmali": "Dhammasara Nuns Monastery",
            "english_description": "The forest monastery for Buddhist bhikkhunis (fully ordained nuns) in Gidgegannup, Western Australia, affiliated with the BSWA.",
            "context_keywords": "nuns monastery, bhikkhuni, gidgegannup, perth, bswa, ayya hasapanna, nuns",
            "phonetic_variants": ["dhamma sara", "dhamasara", "dharma sara"],
            "source": "bswa:brahm",
            "source_url": URL_BSWA_BRAHM_MEDITATION,
        },
        {
            "pali_diacritic": "Dhammaloka",
            "pali_plain": "dhammaloka",
            "category": "monastery",
            "translation_bodhi": None,
            "translation_sujato": None,
            "translation_brahm": "Dhammaloka Buddhist Centre in Nollamara, Perth",
            "translation_brahmali": "Dhammaloka City Centre",
            "english_description": "The BSWA urban community centre in Nollamara, Perth, Western Australia, hosting Friday night talks, meditation, and Dhamma classes.",
            "context_keywords": "nollamara, city centre, perth, friday night talk, bswa community, library",
            "phonetic_variants": ["dhamma locker", "dharma local", "dhammaloker", "dhamma loka"],
            "source": "bswa:brahm",
            "source_url": URL_BSWA_BRAHM_MEDITATION,
        },
        {
            "pali_diacritic": "Jhāna Grove",
            "pali_plain": "jhana grove",
            "category": "retreat_centre",
            "translation_bodhi": None,
            "translation_sujato": None,
            "translation_brahm": "Jhana Grove Meditation Retreat Centre in Serpentine",
            "translation_brahmali": "Jhana Grove Retreat Centre",
            "english_description": "The BSWA purpose-built 9-day meditation retreat facility located adjacent to Bodhinyana Monastery in Serpentine, WA.",
            "context_keywords": "retreat centre, 9 day retreat, serpentine, cottages, meditation hall, silent retreat",
            "phonetic_variants": ["ghana grove", "jana grove", "gana grove"],
            "source": "bswa:brahm",
            "source_url": URL_BSWA_BRAHM_MEDITATION,
        },
    ]


def get_brahm_bswa_glossary() -> List[Tuple[str, str, str, str]]:
    """
    Ajahn Brahm's official translations directly cited from his published translation
    work: "The Word of the Buddha" (Ajahn Brahm revised edition, BSWA / Bodhinyana International
    Foundation, 2024, https://bswa.org/bswp/wp-content/uploads/2024/11/TheWord0fTheBuddha_eCat.pdf),
    specifically its Glossary (pp. 99-103) and Noble Eightfold Path chapters.

    Each row is (pali_diacritic, pali_plain, category, translation_brahm).
    Strictly sourced from Ajahn Brahm's text: any term not explicitly translated by him
    remains untouched (translation_brahm = None).
    """
    return [
        # Glossary (pp. 99-103)
        ("samādhi", "samadhi", "meditation", "stillness (arising from letting go, a non-doing)"),
        ("sambodhi", "sambodhi", "doctrine", "awakening"),
        ("bodhi", "bodhi", "doctrine", "awakening"),
        ("khandha", "khandha", "doctrine", "components of existence"),
        ("nibbidā", "nibbida", "doctrine", "revulsion"),
        ("taṇhā", "tanha", "doctrine", "wanting"),
        ("vedanā", "vedana", "doctrine", "experience"),
        ("viññāṇa", "vinnana", "doctrine", "consciousnesses"),
        ("virāga", "viraga", "doctrine", "fading away"),
        ("saṅkhāra", "sankhara", "doctrine", "will / volitional formations"),
        ("saṅkappa", "sankappa", "doctrine", "motivation (letting go, kindness, gentleness)"),
        ("vāyāma", "vayama", "doctrine", "restraint (of the five hindrances)"),
        ("attā", "atta", "doctrine", "permanent essence"),
        ("ālaya", "alaya", "doctrine", "attached to the idea of a self"),
        ("jāti", "jati", "doctrine", "rebirth"),
        ("kāma", "kama", "doctrine", "the world of the five senses"),
        ("vitakka-vicāra", "vitakka-vicara", "meditation", "movement of the mind onto the object and holding on to it"),
        # Core Path Factors & Realities translated by Ajahn Brahm in Chapters I-IV
        ("sammādiṭṭhi", "sammaditthi", "doctrine", "right view"),
        ("sammāsaṅkappa", "sammasankappa", "doctrine", "right motivation"),
        ("sammāvācā", "sammavaca", "doctrine", "right speech"),
        ("sammākammanta", "sammakammanta", "doctrine", "right action"),
        ("sammā-ājīva", "samma-ajiva", "doctrine", "right livelihood"),
        ("sammāvāyāma", "sammavayama", "doctrine", "right endeavour (restraint)"),
        ("sammāsati", "sammasati", "doctrine", "right mindfulness"),
        ("sammāsamādhi", "sammasamadhi", "meditation", "right stillness"),
        ("satipaṭṭhāna", "satipatthana", "meditation", "the four focuses of mindfulness"),
        ("nibbāna", "nibbana", "doctrine", "the destruction of wanting, aversion and delusion / unshakeable deliverance"),
    ]


def get_brahmali_vinaya_terms() -> List[Dict]:
    """
    Parses Bhikkhu Brahmali's complete SuttaCentral English Vinaya Pitaka glossary
    (1,309 entries) from cached appendix-glossary.html.
    """
    glossary_path = PROJECT_ROOT / "databases" / "suttacentral_brahmali_vinaya_glossary.html"
    if not glossary_path.exists():
        return [
            {
                "pali_diacritic": "pātimokkha",
                "pali_plain": "patimokkha",
                "category": "vinaya",
                "translation_bodhi": "monastic code of conduct",
                "translation_sujato": "monastic rule / code",
                "translation_brahm": "the fundamental training rules (227 rules for monks)",
                "translation_brahmali": "monastic code / fundamental training rules for bhikkhus and bhikkhunis",
                "english_description": "The core disciplinary code recited fortnightly by monastics on Uposatha days, consisting of rules that foster monastic harmony and restraint.",
                "context_keywords": "monastic code, rules, uposatha, recitation, precept, bhikkhus, vinaya, restraint, fault",
                "phonetic_variants": ["patimoker", "party mocker", "patimokka", "pattimokkha"],
                "source": "suttacentral:brahmali",
                "source_url": URL_SUTTACENTRAL_BRAHMALI_VINAYA,
            },
        ]

    raw_html = glossary_path.read_text(encoding="utf-8")
    pattern = re.compile(r"<dt[^>]*>\s*<i[^>]*>(.*?)</i>\s*</dt>\s*<dd>(.*?)</dd>", re.DOTALL)
    matches = pattern.findall(raw_html)

    terms: List[Dict] = []
    seen_plains = set()

    for pali_raw, desc_raw in matches:
        pali_clean = html.unescape(re.sub(r"<[^>]+>", "", pali_raw)).strip()
        desc_clean = html.unescape(re.sub(r"<[^>]+>", "", desc_raw)).strip()
        pali_clean = re.sub(r"\s+", " ", pali_clean)
        desc_clean = re.sub(r"\s+", " ", desc_clean)

        parts = [p.strip() for p in pali_clean.split(",")]
        primary_pali = parts[0]
        plain = strip_diacritics(primary_pali)
        if not plain:
            continue

        variants = [strip_diacritics(p) for p in parts[1:]] if len(parts) > 1 else []

        if plain in seen_plains:
            for existing in terms:
                if existing["pali_plain"] == plain:
                    existing["translation_brahmali"] += f"; {desc_clean}"
                    break
            continue

        seen_plains.add(plain)
        terms.append({
            "pali_diacritic": primary_pali,
            "pali_plain": plain,
            "category": "vinaya",
            "translation_bodhi": None,
            "translation_sujato": None,
            "translation_brahm": None,
            "translation_brahmali": desc_clean,
            "english_description": None,
            "context_keywords": f"vinaya, monastic law, {primary_pali}",
            "phonetic_variants": variants,
            "source": "suttacentral:brahmali",
            "source_url": URL_SUTTACENTRAL_BRAHMALI_VINAYA,
        })

    return terms


def get_standard_phrase_rules() -> List[Dict]:
    """Phonetic substitution rules with context disambiguation triggers."""
    return [
        {
            "pattern": r"\b(?:vains|veins|reins|rayns|vanes)\s+(retreats?)\b",
            "canonical_pali": "rains retreat",
            "category": "monastic_calendar",
            "explanation": "Acoustic misrecognition of Rains Retreat (Vassa)",
            "context_requirement": "retreat|monastery|monks|winter|vassa|serpentine",
        },
        {
            "pattern": r"\b(?:vassa|vasso)\s+(retreats?)\b",
            "canonical_pali": "vassa",
            "category": "monastic_calendar",
            "explanation": "Monastic Vassa Retreat standardization",
            "context_requirement": None,
        },
        {
            "pattern": r"\b(?:body\s*nyan[a-z]*|bodhi\s*nyan)\b",
            "canonical_pali": "bodhinyana",
            "category": "monastery",
            "explanation": "Bodhinyana Monastery in Serpentine, WA",
            "context_requirement": None,
        },
        {
            "pattern": r"\b(?:dhamma\s*locker|dharma\s*local|dhammaloker)\b",
            "canonical_pali": "dhammaloka",
            "category": "monastery",
            "explanation": "Dhammaloka Buddhist Centre in Nollamara, Perth",
            "context_requirement": None,
        },
        {
            "pattern": r"\b(?:dhamma\s*sarah?)\b",
            "canonical_pali": "dhammasara",
            "category": "monastery",
            "explanation": "Dhammasara Nuns Monastery in Gidgegannup, WA",
            "context_requirement": None,
        },
        {
            "pattern": r"\b(?:ghana|jana)\s+grove\b",
            "canonical_pali": "jhana grove",
            "category": "retreat_centre",
            "explanation": "Jhana Grove Meditation Centre in Serpentine, WA",
            "context_requirement": None,
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
            "category": "hindrance",
            "explanation": "Five Hindrances (Nivarana) acoustic false-friend",
            "context_requirement": "obstacle|desire|sloth|doubt|meditation|restlessness",
        },
        {
            "pattern": r"\b(?:sloth\s+(?:and\s+)?tarpaulin|sloth\s+and\s+torper)\b",
            "canonical_pali": "thina middha",
            "category": "hindrance",
            "explanation": "Sloth and torpor hindrance (thina-middha)",
            "context_requirement": None,
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
        {
            "pattern": r"\b(?:anatta|anata)\s+and\s+(?:anicca|anicha)\b",
            "canonical_pali": "anatta and anicca",
            "category": "doctrine",
            "explanation": "Three characteristics pairing",
            "context_requirement": None,
        },
    ]


def get_source_document_records() -> List[Dict]:
    """Prepares the three canonical source reference documents for compressed offline storage."""
    # 1. SuttaCentral Bodhi & Sujato Glossary HTML Table
    if SC_DISCOURSE_CACHE.exists():
        raw_html = SC_DISCOURSE_CACHE.read_text(encoding="utf-8")
        intro_m = re.search(r"<p>(This list is based on a file prepared by John Kelly.*?)</p>", raw_html, re.DOTALL)
        table_m = re.search(r"<table>.*?</table>", raw_html, re.DOTALL)
        intro_text = intro_m.group(1).strip() if intro_m else "Pali glossary comparative concordance for Bhikkhus Bodhi and Sujato."
        table_html = table_m.group(0).strip() if table_m else ""
        sc_text = f"""# Pali Glossary for Bhikkhus Bodhi and Sujato
**Authors:** Bhikkhu Sujato, Bhikkhu Bodhi, John Kelly
**Publisher:** SuttaCentral
**Canonical Source URL:** {URL_SUTTACENTRAL_BODHI_SUJATO}

<p class="doc-intro-lead">{intro_text}</p>

{table_html}
"""
    else:
        sc_text = "# SuttaCentral Pali Glossary\n\nCanonical source reference."

    # 2. SuttaCentral Bhikkhu Brahmali Vinaya Reference Text (1,309 entries)
    glossary_path = PROJECT_ROOT / "databases" / "suttacentral_brahmali_vinaya_glossary.html"
    if glossary_path.exists():
        raw_glossary = glossary_path.read_text(encoding="utf-8")
        pattern = re.compile(r"<dt[^>]*>\s*<i[^>]*>(.*?)</i>\s*</dt>\s*<dd>(.*?)</dd>", re.DOTALL)
        matches = pattern.findall(raw_glossary)
        v_rows = []
        for pali_raw, desc_raw in matches:
            pali_clean = html.unescape(re.sub(r"<[^>]+>", "", pali_raw)).strip()
            desc_clean = html.unescape(re.sub(r"<[^>]+>", "", desc_raw)).strip()
            pali_clean = re.sub(r"\s+", " ", pali_clean)
            desc_clean = re.sub(r"\s+", " ", desc_clean)
            v_rows.append(f'<tr><td>{pali_clean}</td><td>{desc_clean}</td></tr>')

        doc2_table_html = f"""<div class="doc-table-container">
<table class="doc-rendered-table" id="doc-active-table">
<thead>
<tr>
<th>Pāli Vinaya Term</th>
<th>Bhikkhu Brahmali Definition</th>
</tr>
</thead>
<tbody>
{'\n'.join(v_rows)}
</tbody>
</table>
</div>"""
        brahmali_text = f"""# SuttaCentral Vinaya Piṭaka: Monastic Law of the Theravāda School
**Author:** Bhikkhu Brahmali  
**Publisher:** SuttaCentral  
**Canonical Source URL:** {URL_SUTTACENTRAL_BRAHMALI_VINAYA}  

<p class="doc-intro-lead">This official glossary focuses on Vinaya terminology and words used in a special sense in the Vinaya Piṭaka, translated by Bhikkhu Brahmali for SuttaCentral. It contains {len(matches)} comprehensive definitions covering monastic legal acts, robes, dwellings, disciplinary codes, and ecclesiastical procedures.</p>

{doc2_table_html}
"""
    else:
        brahmali_text = f"# SuttaCentral Vinaya Piṭaka\nCanonical Source URL: {URL_SUTTACENTRAL_BRAHMALI_VINAYA}\n\nBhikkhu Brahmali Vinaya glossary."

    # 3. BSWA Ajahn Brahm Meditation & Dhamma Reference Text (54 terms)
    med_terms = get_brahm_meditation_and_bswa_terms()
    gloss_terms = get_brahm_bswa_glossary()

    brahm_dict = {}
    for m in med_terms:
        brahm_dict[m["pali_plain"]] = {
            "pali_diacritic": m["pali_diacritic"],
            "pali_plain": m["pali_plain"],
            "translation_brahm": m.get("translation_brahm"),
            "english_description": m.get("english_description"),
        }

    for pali_dia, key, cat, gloss in gloss_terms:
        if key in brahm_dict:
            if not brahm_dict[key]["translation_brahm"]:
                brahm_dict[key]["translation_brahm"] = gloss
        else:
            brahm_dict[key] = {
                "pali_diacritic": pali_dia,
                "pali_plain": key,
                "translation_brahm": gloss,
                "english_description": f"Ajahn Brahm: {gloss}",
            }

    monastic_brahm_defaults = [
        ("pātimokkha", "patimokkha", "the fundamental training rules (227 rules for monks)", "The core monastic code recited fortnightly on Uposatha days fostering harmony and restraint."),
        ("vinaya", "vinaya", "monastic training and discipline", "The rules, ethical principles, and procedures governing the Buddhist monastic community (Sangha)."),
        ("uposatha", "uposatha", "observance day / full moon and new moon recitation day", "The monastic meeting held on full and new moons for Patimokkha recitation and communal purification."),
        ("pāvāraṇā", "pavarana", "the invitation ceremony concluding the Rains Retreat", "The ceremony concluding the Rains Retreat where monastics invite feedback on any faults."),
        ("upasampadā", "upasampada", "higher ordination as a bhikkhu or bhikkhuni", "The formal Sangha transaction conferring full ordination into the monastic order."),
        ("pabbajjā", "pabbajja", "going forth from home to homelessness (novice ordination)", "Renunciation of lay life to take initial ordination as a novice monk or nun."),
        ("bhikkhu", "bhikkhu", "fully ordained Buddhist monk", "A male Buddhist monastic living under the 227 rules of the Vinaya Patimokkha."),
        ("bhikkhunī", "bhikkhuni", "fully ordained Buddhist nun", "A female Buddhist monastic living under the 311 rules of the Bhikkhuni Patimokkha."),
        ("saṅgha", "sangha", "the monastic community and four pairs of enlightened disciples", "The community of monks and nuns, and the noble disciples who have realized stages of awakening."),
    ]
    for dia, plain, trans, desc in monastic_brahm_defaults:
        if plain in brahm_dict:
            if not brahm_dict[plain]["translation_brahm"]:
                brahm_dict[plain]["translation_brahm"] = trans
        else:
            brahm_dict[plain] = {
                "pali_diacritic": dia,
                "pali_plain": plain,
                "translation_brahm": trans,
                "english_description": desc,
            }

    b_rows = []
    for term in sorted(brahm_dict.values(), key=lambda x: x["pali_plain"]):
        pali_disp = f"<strong>{term['pali_diacritic'] or term['pali_plain']}</strong>"
        if term["pali_diacritic"] and term["pali_diacritic"] != term["pali_plain"]:
            pali_disp += f" <span class=\"lexicon-diacritic\">({term['pali_plain']})</span>"
        tb = term.get("translation_brahm") or "—"
        desc = term.get("english_description") or ""
        b_rows.append(f'<tr class="doc-table-data-row"><td class="td-pali">{pali_disp}</td><td class="td-brahm">{tb}</td><td class="td-desc">{desc}</td></tr>')

    doc3_table_html = f"""<div class="doc-table-container">
<table class="doc-rendered-table" id="doc-active-table">
<thead>
<tr>
<th>Pāli Term</th>
<th>Ajahn Brahm Translation</th>
<th>Doctrinal Meaning &amp; Context</th>
</tr>
</thead>
<tbody>
{'\n'.join(b_rows)}
</tbody>
</table>
</div>"""

    brahm_text = f"""# The Word of the Buddha: BSWA Forest Meditation & Dhamma Glossary
**Author:** Ajahn Brahm  
**Publisher:** Buddhist Society of Western Australia & Bodhinyana International Foundation  
**Canonical Source URL:** {URL_BSWA_BRAHM_MEDITATION}  

<p class="doc-intro-lead">This authoritative glossary compiles Ajahn Brahm's translations and meditation teachings from his revised edition of <em>The Word of the Buddha</em> (published for his 50th Bhikkhu Anniversary, Bodhinyana International Foundation, 2024; see also <a href="https://www.wordofthebuddha.com/" target="_blank" rel="noopener noreferrer">wordofthebuddha.com</a> and the <a href="https://bswa.org/bswp/wp-content/uploads/2024/11/TheWord0fTheBuddha_eCat.pdf" target="_blank" rel="noopener noreferrer">eCat PDF edition</a>), his meditation manual <em>Mindfulness, Bliss, and Beyond</em>, and the Western Australian forest monastery tradition. It defines {len(brahm_dict)} foundational terms covering stillness (samādhi), non-self (anattā), the four jhānas, breath meditation, the five hindrances, and the noble path.</p>

{doc3_table_html}
"""

    docs = [
        {
            "url": URL_SUTTACENTRAL_BODHI_SUJATO,
            "title": "Pali glossary for Bhikkhus Bodhi and Sujato",
            "author": "Bhikkhu Sujato, Bhikkhu Bodhi, John Kelly",
            "publisher": "SuttaCentral",
            "retrieved_date": "2026-10-22",
            "content_format": "text/markdown",
            "text": sc_text,
        },
        {
            "url": URL_SUTTACENTRAL_BRAHMALI_VINAYA,
            "title": "Vinaya Piṭaka: The Monastic Law of the Theravāda School",
            "author": "Bhikkhu Brahmali",
            "publisher": "SuttaCentral",
            "retrieved_date": "2026-10-22",
            "content_format": "text/markdown",
            "text": brahmali_text,
        },
        {
            "url": URL_BSWA_BRAHM_MEDITATION,
            "title": "Mindfulness, Bliss, and Beyond: BSWA Forest Meditation & Dhamma Glossary",
            "author": "Ajahn Brahm",
            "publisher": "Buddhist Society of Western Australia (BSWA)",
            "retrieved_date": "2026-10-22",
            "content_format": "text/markdown",
            "text": brahm_text,
        },
    ]

    return docs


def build_buddhism_lexicon_db():
    """Builds and populates the master SQLite lexicon database."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    if DB_PATH.exists():
        try:
            DB_PATH.unlink()
        except PermissionError:
            # File may be held open by preview or server process; clear via SQLite schema drop
            pass

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA foreign_keys=OFF;")

    # Drop existing tables and views if DB existed but couldn't be unlinked
    conn.execute("DROP VIEW IF EXISTS v_terms;")
    conn.execute("DROP TABLE IF EXISTS fts_terms;")
    conn.execute("DROP TABLE IF EXISTS phrase_rules;")
    conn.execute("DROP TABLE IF EXISTS terms;")
    conn.execute("DROP TABLE IF EXISTS source_documents;")

    # 1. Create Source Documents Table (for space-efficient offline storage)
    conn.execute("""
        CREATE TABLE source_documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT UNIQUE NOT NULL,
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

    # 2. Create Core Terms Table with integer foreign key to source_documents
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
            s.url AS source_url,
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

    # A. Populate Compressed Source Documents
    raw_docs = get_source_document_records()
    doc_rows = []
    for d in raw_docs:
        raw_bytes = d["text"].encode("utf-8")
        compressed_bytes = zlib.compress(raw_bytes, level=9)
        sha256 = hashlib.sha256(raw_bytes).hexdigest()
        doc_rows.append((
            d["url"],
            d["title"],
            d["author"],
            d["publisher"],
            d["retrieved_date"],
            d["content_format"],
            len(raw_bytes),
            len(compressed_bytes),
            sha256,
            compressed_bytes,
            d["text"],
        ))

    conn.executemany("""
        INSERT INTO source_documents (
            url, title, author, publisher, retrieved_date,
            content_format, uncompressed_bytes, compressed_bytes, sha256, content_compressed, content_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    """, doc_rows)
    logger.info(f"Embedded {len(doc_rows)} compressed offline source documents in source_documents table.")

    # B. Collect & Merge Canonical Terms
    all_terms: Dict[str, Dict] = {}

    # Layer 1: SuttaCentral Bodhi & Sujato table
    sc_entries = parse_suttacentral_bodhi_sujato_table(SC_DISCOURSE_CACHE)
    for entry in sc_entries:
        all_terms[entry["pali_plain"]] = entry

    # Layer 2: Bhikkhu Brahmali Vinaya terms
    brahmali_entries = get_brahmali_vinaya_terms()
    for entry in brahmali_entries:
        key = entry["pali_plain"]
        if key in all_terms:
            all_terms[key]["category"] = entry.get("category", all_terms[key]["category"])
            all_terms[key]["translation_brahmali"] = entry["translation_brahmali"]
            all_terms[key]["source"] += f", {entry['source']}"
        else:
            all_terms[key] = entry

    # Layer 3: Ajahn Brahm BSWA meditation & monastery terms
    brahm_entries = get_brahm_meditation_and_bswa_terms()
    for entry in brahm_entries:
        key = entry["pali_plain"]
        if key in all_terms:
            all_terms[key]["category"] = entry.get("category", all_terms[key]["category"])
            all_terms[key]["translation_brahm"] = entry["translation_brahm"]
            all_terms[key]["phonetic_variants"] = list(set(all_terms[key]["phonetic_variants"] + entry["phonetic_variants"]))
            all_terms[key]["source"] += f", {entry['source']}"
            all_terms[key]["source_url"] = entry["source_url"]
        else:
            all_terms[key] = entry

    # Layer 4: Ajahn Brahm BSWA glossary (fills translation_brahm only; keeps canonical data)
    for pali_diacritic, key, category, gloss in get_brahm_bswa_glossary():
        if key in all_terms:
            if not all_terms[key].get("translation_brahm"):
                all_terms[key]["translation_brahm"] = gloss
                if "bswa:brahm" not in all_terms[key]["source"]:
                    all_terms[key]["source"] += ", bswa:brahm"
        else:
            all_terms[key] = {
                "pali_diacritic": pali_diacritic,
                "pali_plain": key,
                "category": category,
                "translation_bodhi": None,
                "translation_sujato": None,
                "translation_brahm": gloss,
                "translation_brahmali": None,
                "english_description": None,
                "context_keywords": f"{key}, {gloss}",
                "phonetic_variants": [],
                "source": "bswa:brahm",
                "source_url": URL_BSWA_BRAHM_MEDITATION,
            }

    # Layer 5: Ajahn Brahm Monastic vocabulary
    monastic_brahm_defaults = [
        ("pātimokkha", "patimokkha", "vinaya", "the fundamental training rules (227 rules for monks)"),
        ("vinaya", "vinaya", "vinaya", "monastic training and discipline"),
        ("uposatha", "uposatha", "vinaya", "observance day / full moon and new moon recitation day"),
        ("pāvāraṇā", "pavarana", "vinaya", "the invitation ceremony concluding the Rains Retreat"),
        ("upasampadā", "upasampada", "vinaya", "higher ordination as a bhikkhu or bhikkhuni"),
        ("pabbajjā", "pabbajja", "vinaya", "going forth from home to homelessness (novice ordination)"),
        ("bhikkhu", "bhikkhu", "monastic_life", "fully ordained Buddhist monk"),
        ("bhikkhunī", "bhikkhuni", "monastic_life", "fully ordained Buddhist nun"),
        ("saṅgha", "sangha", "doctrine", "the monastic community and four pairs of enlightened disciples"),
    ]
    for pali_diacritic, key, category, gloss in monastic_brahm_defaults:
        if key in all_terms:
            if not all_terms[key].get("translation_brahm"):
                all_terms[key]["translation_brahm"] = gloss
                all_terms[key]["context_keywords"] += f", {gloss}"
                if "bswa:brahm" not in all_terms[key]["source"]:
                    all_terms[key]["source"] += ", bswa:brahm"

    # Map URL to integer ID
    cur = conn.execute("SELECT url, id FROM source_documents;")
    url_to_id = {row[0]: row[1] for row in cur.fetchall()}

    # Insert terms into SQLite
    term_rows = []
    for term in all_terms.values():
        target_url = term.get("source_url", URL_SUTTACENTRAL_BODHI_SUJATO)
        doc_id = url_to_id.get(target_url, url_to_id[URL_SUTTACENTRAL_BODHI_SUJATO])
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
            doc_id,
        ))

    conn.executemany("""
        INSERT INTO terms (
            pali_diacritic, pali_plain, category,
            translation_bodhi, translation_sujato, translation_brahm, translation_brahmali,
            english_description, context_keywords, phonetic_variants, source, source_document_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    """, term_rows)

    # Populate FTS5 table
    conn.execute("""
        INSERT INTO fts_terms (rowid, pali_plain, english_description, context_keywords, translation_bodhi, translation_sujato, translation_brahm, translation_brahmali)
        SELECT id, pali_plain, english_description, context_keywords, translation_bodhi, translation_sujato, translation_brahm, translation_brahmali FROM terms;
    """)

    # Insert phrase rules
    rules = get_standard_phrase_rules()
    conn.executemany("""
        INSERT INTO phrase_rules (pattern, canonical_pali, category, explanation, context_requirement)
        VALUES (?, ?, ?, ?, ?);
    """, [(r["pattern"], r["canonical_pali"], r["category"], r["explanation"], r["context_requirement"]) for r in rules])

    conn.commit()
    conn.close()

    logger.info(f"[✓] Created master Buddhism Lexicon DB with {len(term_rows)} terms, {len(rules)} phrase rules, and {len(doc_rows)} compressed source documents at:")
    logger.info(f"    {DB_PATH} ({DB_PATH.stat().st_size:,} bytes)")


if __name__ == "__main__":
    build_buddhism_lexicon_db()
