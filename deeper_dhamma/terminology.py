"""
Buddhist Terminology Editor & Context-Aware Disambiguation Engine.

Backed by the comprehensive SQLite database: data/buddhism_lexicon.db
(sourced from SuttaCentral Bodhi/Sujato translations & BSWA Brahm/Brahmali teachings).
"""

import logging
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from deeper_dhamma.lexicon import BuddhismLexiconDatabase, strip_diacritics

logger = logging.getLogger("terminology_editor")


class TerminologyEditor:
    """
    Applies context-aware Buddhist terminology corrections to raw ASR outputs,
    verifying acoustic false-friends against English descriptions & context keywords,
    and recording a structured audit changelog.
    """

    def __init__(self, db_path: Optional[Path | str] = None):
        self.lexicon_db = BuddhismLexiconDatabase(db_path)
        self.phrase_rules = self.lexicon_db.get_phrase_rules()
        logger.info(f"Loaded {len(self.phrase_rules)} phonetic rules from {self.lexicon_db.db_path.name}")

    def edit_text(
        self,
        text: str,
        surrounding_context: str = "",
    ) -> Tuple[str, List[Dict]]:
        """
        Normalizes a single text string against the Buddhist lexicon rules,
        using surrounding context to verify ambiguous phonetic candidates.
        """
        applied_changes: Dict[str, Dict] = {}
        cleaned = text
        context_window = f"{surrounding_context} {text}".strip()

        for rule in self.phrase_rules:
            pattern = rule["pattern"]
            canonical_target = rule["canonical_pali"]
            category = rule["category"]
            explanation = rule["explanation"]
            context_req = rule["context_requirement"]

            matches = list(pattern.finditer(cleaned))
            if not matches:
                continue

            for m in matches:
                matched_str = m.group(0)
                # Run context-aware disambiguation
                final_replacement, confirmed, reason = self.lexicon_db.disambiguate_phrase(
                    matched_str=matched_str,
                    canonical_target=canonical_target,
                    surrounding_text=context_window,
                    context_requirement=context_req,
                )

                if confirmed and final_replacement != matched_str:
                    key = f"{matched_str} -> {final_replacement}"
                    if key not in applied_changes:
                        applied_changes[key] = {
                            "original": matched_str,
                            "replacement": pattern.sub(final_replacement, matched_str),
                            "category": category,
                            "explanation": explanation,
                            "rationale": reason,
                            "count": 0,
                        }
                    applied_changes[key]["count"] += 1
                    cleaned = pattern.sub(final_replacement, cleaned)

        changelog = list(applied_changes.values())
        return cleaned, changelog

    def edit_segments(self, segments: List[Dict]) -> Tuple[List[Dict], List[Dict]]:
        """
        Iterates across segment dictionaries with a sliding context window,
        applies context-aware corrections, and aggregates an episode changelog.
        """
        aggregated_changes: Dict[str, Dict] = {}

        for i, seg in enumerate(segments):
            if "text" not in seg or not seg["text"]:
                continue

            # Build sliding context window from adjacent segments
            prev_text = segments[i - 1]["text"] if i > 0 else ""
            next_text = segments[i + 1]["text"] if i + 1 < len(segments) else ""
            surrounding = f"{prev_text} {next_text}".strip()

            corrected, changes = self.edit_text(seg["text"], surrounding_context=surrounding)
            seg["text"] = corrected

            for change in changes:
                key = f"{change['original']} -> {change['replacement']}"
                if key not in aggregated_changes:
                    aggregated_changes[key] = {
                        "original": change["original"],
                        "replacement": change["replacement"],
                        "category": change["category"],
                        "explanation": change.get("explanation", ""),
                        "rationale": change.get("rationale", ""),
                        "count": 0,
                    }
                aggregated_changes[key]["count"] += change["count"]

        total_changelog = list(aggregated_changes.values())
        return segments, total_changelog


# Singleton instance
terminology_editor = TerminologyEditor()
