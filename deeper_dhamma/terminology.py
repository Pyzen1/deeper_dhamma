"""
Buddhist Terminology Editor & Context-Aware Disambiguation Engine.

Backed by the comprehensive SQLite database: databases/buddhism_lexicon.db
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
                    cleaned = re.sub(r"\b" + re.escape(matched_str) + r"\b", final_replacement, cleaned, count=1)

        changelog = list(applied_changes.values())
        return cleaned, changelog

    def edit_segments(self, segments: List[Dict]) -> Tuple[List[Dict], List[Dict]]:
        """
        Iterates across segment dictionaries with a sliding context window,
        applies context-aware corrections, keeps word-level timing arrays (`words`)
        synchronized when multi-word misrecognitions are merged, and aggregates an episode changelog.
        """
        aggregated_changes: Dict[str, Dict] = {}

        for i, seg in enumerate(segments):
            if "text" not in seg or not seg["text"]:
                continue

            # Build sliding context window from adjacent segments
            prev_text = segments[i - 1]["text"] if i > 0 else ""
            next_text = segments[i + 1]["text"] if i + 1 < len(segments) else ""
            surrounding = f"{prev_text} {next_text}".strip()

            orig_text = seg["text"]
            corrected, changes = self.edit_text(orig_text, surrounding_context=surrounding)
            seg["text"] = corrected

            if changes and seg.get("words"):
                seg["words"] = self._sync_word_timings(seg["words"], corrected, orig_text=orig_text)

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

    @staticmethod
    def _sync_word_timings(
        words: List[Dict],
        corrected_text: str,
        orig_text: Optional[str] = None,
    ) -> List[Dict]:
        """
        Reconciles the word timing list (`words`) when a multi-word phonetic slip
        (e.g. 'Yonis Omanis Ikara' -> 'yoniso manasikara' or 'party mocker' -> 'patimokkha')
        reduces the whitespace token count in `corrected_text`.
        """
        import difflib

        target_tokens = corrected_text.split()
        if not words or len(words) == len(target_tokens):
            return words

        orig_tokens = orig_text.split() if orig_text else [w.get("word", "").strip() for w in words]
        if len(orig_tokens) == len(words):
            matcher = difflib.SequenceMatcher(None, orig_tokens, target_tokens)
            synced: List[Dict] = []
            for tag, i1, i2, j1, j2 in matcher.get_opcodes():
                src_slice = words[i1:i2]
                m_len = i2 - i1
                k_len = j2 - j1
                if tag == "equal" or m_len == k_len:
                    synced.extend(src_slice)
                elif m_len > k_len and k_len >= 1:
                    if k_len == 1:
                        synced.append({
                            **src_slice[0],
                            "word": f" {target_tokens[j1]}",
                            "start": src_slice[0]["start"],
                            "end": src_slice[-1]["end"],
                        })
                    elif k_len == 2 and m_len == 3:
                        mid_clean = re.sub(r"[^\w]", "", orig_tokens[i1 + 1])
                        if len(mid_clean) <= 3:
                            synced.append({
                                **src_slice[0],
                                "word": f" {target_tokens[j1]}",
                                "start": src_slice[0]["start"],
                                "end": src_slice[1]["end"],
                            })
                            synced.append({
                                **src_slice[2],
                                "word": f" {target_tokens[j1 + 1]}",
                                "start": src_slice[2]["start"],
                                "end": src_slice[2]["end"],
                            })
                        else:
                            synced.append({
                                **src_slice[0],
                                "word": f" {target_tokens[j1]}",
                                "start": src_slice[0]["start"],
                                "end": src_slice[0]["end"],
                            })
                            synced.append({
                                **src_slice[1],
                                "word": f" {target_tokens[j1 + 1]}",
                                "start": src_slice[1]["start"],
                                "end": src_slice[2]["end"],
                            })
                    else:
                        synced.extend(src_slice[: k_len - 1])
                        synced.append({
                            **src_slice[k_len - 1],
                            "word": f" {target_tokens[j2 - 1]}",
                            "start": src_slice[k_len - 1]["start"],
                            "end": src_slice[-1]["end"],
                        })
                else:
                    synced.extend(src_slice)
            if len(synced) == len(target_tokens):
                return synced

        # Fallback pair-merge heuristic when orig_text token count differs from len(words)
        compound_merges = [
            ({"party", "mocker"}, "patimokkha"),
            ({"anna", "panasati"}, "anapanasati"),
            ({"ana", "panasati"}, "anapanasati"),
            ({"five", "entrances"}, "nivarana"),
            ({"5", "entrances"}, "nivarana"),
            ({"omanis", "ikara"}, "manasikara"),
            ({"yonis", "om"}, "yoniso"),
        ]
        synced_fb: List[Dict] = []
        idx = 0
        while idx < len(words):
            if idx + 1 < len(words):
                w1_clean = re.sub(r"[^\w]", "", words[idx].get("word", "").lower())
                w2_clean = re.sub(r"[^\w]", "", words[idx + 1].get("word", "").lower())
                merged_rep = None
                for pair_set, rep in compound_merges:
                    if {w1_clean, w2_clean} == pair_set:
                        merged_rep = rep
                        break
                if merged_rep and len(words) - 1 >= len(target_tokens):
                    synced_fb.append({
                        "word": f" {merged_rep}",
                        "start": words[idx]["start"],
                        "end": words[idx + 1]["end"],
                        "prob": min(words[idx].get("prob", 1.0), words[idx + 1].get("prob", 1.0)),
                    })
                    idx += 2
                    continue
            synced_fb.append(words[idx])
            idx += 1
        return synced_fb


_editor_instance: Optional[TerminologyEditor] = None


def get_terminology_editor(db_path: Optional[Path | str] = None) -> TerminologyEditor:
    """Returns a singleton or configured TerminologyEditor instance."""
    global _editor_instance
    if _editor_instance is None or db_path is not None:
        inst = TerminologyEditor(db_path)
        if db_path is None:
            _editor_instance = inst
        return inst
    return _editor_instance


class _LazyTerminologyEditorProxy:
    """Lazy proxy so legacy `from deeper_dhamma.terminology import terminology_editor` works without eager init."""

    def __getattr__(self, name: str):
        return getattr(get_terminology_editor(), name)


terminology_editor = _LazyTerminologyEditorProxy()
