"""
Buddhism Lexicon Database Interface (buddhism_lexicon.db).

Provides high-speed queries, context-aware disambiguation, and FTS5 search
over canonical Pali terms and English descriptions from:
- SuttaCentral: Bhikkhu Bodhi & Bhikkhu Sujato translations
- SuttaCentral & BSWA: Bhikkhu Brahmali Vinaya & monastic terms
- BSWA: Ajahn Brahm & Ajahn Brahmali meditation, retreat, and monastery terminology
"""

import json
import logging
import re
import sqlite3
import unicodedata
from pathlib import Path
from typing import Dict, List, Optional, Tuple

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
    Single master database: data/buddhism_lexicon.db
    """

    def __init__(self, db_path: Optional[Path | str] = None):
        self.db_path = Path(db_path) if db_path else BUDDHISM_LEXICON_DB_PATH
        self._ensure_db()

    def _ensure_db(self):
        if not self.db_path.exists():
            logger.info(f"Lexicon database {self.db_path} not found. Building now...")
            from deeper_dhamma.build_lexicon import build_buddhism_lexicon_db
            build_buddhism_lexicon_db()

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def lookup_term(self, term: str) -> Optional[Dict]:
        """Look up a term by plain Latin or diacritic form, including source document details."""
        plain = strip_diacritics(term)
        with self._get_connection() as conn:
            cur = conn.execute(
                "SELECT * FROM v_terms WHERE pali_plain = ? OR pali_diacritic = ? COLLATE NOCASE LIMIT 1;",
                (plain, term),
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
                SELECT url, title, author, publisher, retrieved_date,
                       content_format, uncompressed_bytes, compressed_bytes, sha256
                FROM source_documents
                ORDER BY author, title;
                """
            )
            return [dict(r) for r in cur.fetchall()]

    def get_source_document(self, query: str) -> Optional[Dict]:
        """
        Retrieves and decompresses an embedded source document by exact URL,
        URL substring, or title match.
        """
        import zlib
        with self._get_connection() as conn:
            cur = conn.execute(
                """
                SELECT * FROM source_documents
                WHERE url = ? OR url LIKE ? OR title LIKE ?
                LIMIT 1;
                """,
                (query, f"%{query}%", f"%{query}%"),
            )
            row = cur.fetchone()
            if not row:
                return None
            d = dict(row)
            if d.get("content_compressed"):
                d["content"] = zlib.decompress(d["content_compressed"]).decode("utf-8")
            else:
                d["content"] = ""
            return d

    def get_prompt_steering_terms(self, limit: int = 35) -> str:
        """
        Generates a concise, high-signal comma-separated prompt string for Whisper's
        `initial_prompt` to bias first-pass decoding toward correct Pali and monastic terminology.
        """
        high_priority = [
            "Ajahn Brahm", "Ajahn Brahmali", "Bodhinyana", "Dhammasara", "Jhana Grove",
            "Dhammaloka", "Rains Retreat", "anapanasati", "jhana", "samadhi", "nimitta",
            "piti", "sukha", "ekaggata", "anatta", "anicca", "dukkha", "kamma", "Dhamma",
            "Sangha", "patimokkha", "vinaya", "sutta", "thina middha", "uddhacca kukkucca",
            "vicikiccha", "kamacchanda", "vyapada", "five hindrances", "letting go",
        ]
        return ", ".join(high_priority[:limit])

