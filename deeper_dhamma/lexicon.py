"""
Buddhism Lexicon Database Interface (buddhism_lexicon.db).

Provides high-speed queries, context-aware disambiguation, and FTS5 search
over canonical Pali terms and English descriptions from:
- SuttaCentral: Bhikkhu Bodhi & Bhikkhu Sujato translations
- SuttaCentral & BSWA: Bhikkhu Brahmali Vinaya & monastic terms
- BSWA: Ajahn Brahm & Ajahn Brahmali meditation, retreat, and monastery terminology
"""

from contextlib import contextmanager
import json
import logging
import math
import re
import sqlite3
import unicodedata
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Tuple

from deeper_dhamma.config import BUDDHISM_LEXICON_DB_PATH

logger = logging.getLogger("buddhism_lexicon")


def strip_diacritics(text: str) -> str:
    """Strips Pali diacritics to standard Latin."""
    normalized = unicodedata.normalize("NFD", text.lower())
    clean = "".join(c for c in normalized if unicodedata.category(c) != "Mn")
    clean = clean.replace("ṁ", "m").replace("ṃ", "m").replace("ŋ", "m")
    clean = re.sub(r"[^\w\s\-]", "", clean)
    return clean.strip()


class BuddhismLexiconDatabase:
    """
    SQLite-backed Buddhist lexicon providing contextual lookups and disambiguation
    for transcribing and self-correcting Buddhist Dhamma talks.
    Single master database: databases/buddhism_lexicon.db
    """

    def __init__(self, db_path: Optional[Path | str] = None):
        self.db_path = Path(db_path) if db_path else BUDDHISM_LEXICON_DB_PATH
        self._ensure_db()

    def _ensure_db(self):
        if not self.db_path.exists():
            logger.info(f"Lexicon database {self.db_path} not found. Building now...")
            from deeper_dhamma.build_lexicon import build_buddhism_lexicon_db
            build_buddhism_lexicon_db()
        else:
            with self._get_connection() as conn:
                conn.execute("""
                    CREATE VIEW IF NOT EXISTS v_terms AS
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

    @contextmanager
    def _get_connection(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    connection = _get_connection

    def get_all_terms(self) -> List[Dict]:
        """
        Returns all canonical Pali terms with definitions, teacher glosses,
        and source provenance for high-speed client-side companion index and
        live audio phrase synchronization.
        """
        with self._get_connection() as conn:
            cur = conn.execute("""
                SELECT id, pali_plain, pali_diacritic, category,
                       translation_bodhi, translation_sujato, translation_brahm, translation_brahmali,
                       english_description, phonetic_variants,
                       source_document_id, source_url, source_mirror_url, source_title
                FROM v_terms
                ORDER BY pali_plain ASC;
            """)
            items = []
            for r in cur.fetchall():
                d = dict(r)
                d["phonetic_variants"] = json.loads(d.get("phonetic_variants") or "[]")
                items.append(d)
            return items

    def lookup_term(self, term: str) -> Optional[Dict]:
        """Look up a term by plain Latin, diacritic, or hyphenated compound form, including source document details."""
        plain = strip_diacritics(term)
        condensed = plain.replace("-", "").replace(" ", "")
        with self._get_connection() as conn:
            cur = conn.execute(
                """
                SELECT * FROM v_terms 
                WHERE pali_plain = ? 
                   OR pali_diacritic = ? COLLATE NOCASE
                   OR pali_plain = ?
                   OR phonetic_variants LIKE ?
                LIMIT 1;
                """,
                (plain, term, condensed, f'%"{plain}"%'),
            )
            row = cur.fetchone()
            if row:
                d = dict(row)
                d["phonetic_variants"] = json.loads(d.get("phonetic_variants") or "[]")
                return d
            return None

    def search_context(self, context_query: str, limit: int = 5) -> List[Dict]:
        """
        Uses FTS5 to find terms conceptually related to the context query.
        Useful for analyzing the surrounding speech context.
        """
        # Clean query for FTS5 syntax
        clean_words = re.findall(r"\w+", context_query.lower())
        if not clean_words:
            return []
        fts_query = " OR ".join(clean_words[:10])

        with self._get_connection() as conn:
            cur = conn.execute(
                """
                SELECT t.*
                FROM fts_terms
                JOIN v_terms t ON fts_terms.rowid = t.id
                WHERE fts_terms MATCH ?
                ORDER BY rank
                LIMIT ?;
                """,
                (fts_query, limit),
            )
            results = []
            for r in cur.fetchall():
                d = dict(r)
                d["phonetic_variants"] = json.loads(d.get("phonetic_variants") or "[]")
                results.append(d)
            return results

    def get_paged_terms(
        self,
        mode: str = "core",
        category: Optional[str] = None,
        letter: Optional[str] = None,
        sort: str = "pali_asc",
        page: int = 1,
        limit: int = 25,
    ) -> Dict:
        """
        Retrieves paginated terms with optional filtering by mode (core/all),
        category, and starting letter.
        """
        CORE_CANONICAL_TERMS = [
            "samadhi", "sati", "kamma", "nibbana", "panna", "sila", "bhavana", "sangha",
            "dhamma", "buddha", "metta", "brahmavihara", "vipassana", "samatha",
            "paticcasamuppada", "tilakkhana", "khandha", "tanha", "avijja", "ariya"
        ]
        where_clauses = ["1=1"]
        params = []

        if mode == "core":
            placeholders = ", ".join(["?"] * len(CORE_CANONICAL_TERMS))
            where_clauses.append(
                f"(translation_brahm IS NOT NULL OR category IN ('meditation', 'hindrance', 'monastery', 'retreat_centre', 'monastic_calendar') OR pali_plain IN ({placeholders}))"
            )
            params.extend(CORE_CANONICAL_TERMS)

        if category and category != "all":
            where_clauses.append("category = ?")
            params.append(category)

        if letter and letter != "all":
            where_clauses.append("pali_plain LIKE ?")
            params.append(f"{letter.lower()}%")

        where_sql = " AND ".join(where_clauses)

        order_sql = "pali_plain ASC"
        if sort == "teacher_first":
            order_sql = "(translation_brahm IS NOT NULL) DESC, pali_plain ASC"

        p = max(1, int(page))
        lim = max(1, int(limit))
        offset = (p - 1) * lim

        with self._get_connection() as conn:
            cur = conn.execute(f"SELECT COUNT(*) FROM v_terms WHERE {where_sql};", params)
            total = cur.fetchone()[0]

            cur = conn.execute(
                f"SELECT * FROM v_terms WHERE {where_sql} ORDER BY {order_sql} LIMIT ? OFFSET ?;",
                [*params, lim, offset],
            )
            items = []
            for r in cur.fetchall():
                d = dict(r)
                d["phonetic_variants"] = json.loads(d.get("phonetic_variants") or "[]")
                items.append(d)

        return {
            "items": items,
            "total": total,
            "page": p,
            "limit": lim,
            "total_pages": math.ceil(total / lim) if total > 0 else 1,
        }

    def get_phrase_rules(self) -> List[Dict]:
        """Returns all compiled phonetic phrase rules."""
        with self._get_connection() as conn:
            rows = conn.execute("SELECT * FROM phrase_rules ORDER BY id ASC;").fetchall()
            rules = []
            for r in rows:
                rules.append({
                    "id": r["id"],
                    "pattern": re.compile(r["pattern"], re.IGNORECASE),
                    "raw_pattern": r["pattern"],
                    "canonical_pali": r["canonical_pali"],
                    "category": r["category"],
                    "explanation": r["explanation"],
                    "context_requirement": (
                        re.compile(r["context_requirement"], re.IGNORECASE)
                        if r["context_requirement"]
                        else None
                    ),
                    "raw_context": r["context_requirement"],
                })
            return rules

    def disambiguate_phrase(
        self,
        matched_str: str,
        canonical_target: str,
        surrounding_text: str,
        context_requirement: Optional[re.Pattern] = None,
    ) -> Tuple[str, bool, str]:
        """
        Context-aware disambiguation: verifies whether a candidate replacement
        is supported by surrounding context keywords or descriptions.
        """
        # If no specific context is required, accept standard substitution
        if not context_requirement:
            return canonical_target, True, "Standard canonical replacement"

        # Check if surrounding text matches the contextual requirement
        if context_requirement.search(surrounding_text):
            return (
                canonical_target,
                True,
                f"Context confirmed by nearby keywords matching '{context_requirement.pattern}'",
            )

        # Also check against the term's context keywords in DB
        term_info = self.lookup_term(canonical_target)
        if term_info and term_info.get("context_keywords"):
            keywords = [k.strip().lower() for k in term_info["context_keywords"].split(",") if k.strip()]
            for kw in keywords:
                if kw in surrounding_text.lower():
                    return (
                        canonical_target,
                        True,
                        f"Context confirmed by lexicon keyword '{kw}'",
                    )

        # Context missing or ambiguous: do NOT replace to avoid error propagation
        return matched_str, False, f"Context requirement '{context_requirement.pattern}' not found in surrounding speech"

    def list_source_documents(self) -> List[Dict]:
        """Returns metadata for all embedded offline source documents."""
        with self._get_connection() as conn:
            cur = conn.execute(
                """
                SELECT id, url, mirror_url, title, author, publisher, retrieved_date,
                       content_format, uncompressed_bytes, compressed_bytes, sha256
                FROM source_documents
                ORDER BY id ASC;
                """
            )
            return [dict(r) for r in cur.fetchall()]

    def get_source_document(self, query: str | int) -> Optional[Dict]:
        """
        Retrieves and decompresses an embedded source document by integer id,
        exact URL, URL substring, or title match.
        """
        import zlib
        q_str = str(query).strip()
        is_num = q_str.isdigit()

        with self._get_connection() as conn:
            if is_num:
                cur = conn.execute(
                    "SELECT * FROM source_documents WHERE id = ? LIMIT 1;",
                    (int(q_str),),
                )
            else:
                cur = conn.execute(
                    """
                    SELECT * FROM source_documents
                    WHERE url = ? OR url LIKE ? OR title LIKE ?
                    LIMIT 1;
                    """,
                    (q_str, f"%{q_str}%", f"%{q_str}%"),
                )
            row = cur.fetchone()
            if not row:
                return None
            d = dict(row)
            if d.get("content_text"):
                d["content"] = d["content_text"]
            elif d.get("content_compressed"):
                d["content"] = zlib.decompress(d["content_compressed"]).decode("utf-8")
            else:
                d["content"] = ""
            # Omit raw binary blob from returned dict to keep serializable
            d.pop("content_compressed", None)
            return d

    def get_prompt_steering_terms(
        self,
        teacher_slugs: Optional[List[str] | str] = None,
        limit: int = 35,
    ) -> str:
        """
        Generates a tailored comma-separated prompt string for Whisper's `initial_prompt`,
        customizing doctrinal vocabulary to the identified speaker(s).
        """
        if isinstance(teacher_slugs, str):
            slugs = [teacher_slugs.lower()]
        elif teacher_slugs:
            slugs = [s.lower() for s in teacher_slugs]
        else:
            slugs = []

        # Shared BSWA monastic baseline
        terms = [
            "Ajahn Brahm", "Ajahn Brahmali", "Bodhinyana", "Dhammaloka", "Dhammasara",
            "Jhana Grove", "Rains Retreat", "Dhamma", "Sangha", "Buddha", "kamma", "sila", "panna",
        ]

        is_brahm = any("brahm" in s and "brahmali" not in s for s in slugs) or not slugs
        is_brahmali = any("brahmali" in s for s in slugs)
        is_nun = any("vayama" in s or "hasapanna" in s or "nun" in s for s in slugs)

        if is_brahm:
            terms.extend([
                "jhana", "samadhi", "anapanasati", "nimitta", "piti", "sukha",
                "ekaggata", "anatta", "anicca", "dukkha", "letting go", "stillness",
                "kamacchanda", "byapada", "thina middha", "uddhacca kukkucca",
                "vicikiccha", "five hindrances", "peaceful", "mindfulness", "bhavana",
            ])

        if is_brahmali:
            terms.extend([
                "vinaya", "patimokkha", "parajika", "sanghadisesa", "suttas",
                "Majjhima Nikaya", "Digha Nikaya", "Samyutta Nikaya", "Anguttara Nikaya",
                "bhikkhu", "bhikkhuni", "Theravada", "SuttaCentral", "pali", "vassa",
                "pavarana", "uposatha", "ariya sacca", "paticcasamuppada",
            ])

        if is_nun:
            terms.extend([
                "bhikkhuni", "upasika", "Dhammasara", "ordination", "Therigatha",
                "siladhara", "garudhamma", "Ayya Vayama", "Ajahn Hasapanna",
            ])

        # Deduplicate while preserving order
        seen = set()
        deduped = []
        for t in terms:
            tl = t.lower()
            if tl not in seen:
                seen.add(tl)
                deduped.append(t)

        return ", ".join(deduped[:limit])

    def get_hotwords_for_teachers(
        self,
        teacher_slugs: Optional[List[str] | str] = None,
        limit: int = 50,
    ) -> str:
        """
        Generates a space-separated hotword string for CTranslate2 beam search logit biasing,
        boosting recognition of specialized Pali vocabulary continuously across the talk.
        """
        prompt_str = self.get_prompt_steering_terms(teacher_slugs=teacher_slugs, limit=limit)
        # Hotwords format: space-delimited words or multi-word tokens
        clean_words = []
        for chunk in prompt_str.split(","):
            chunk = chunk.strip()
            if chunk:
                clean_words.append(chunk)
        return " ".join(clean_words[:limit])


