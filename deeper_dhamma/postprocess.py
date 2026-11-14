"""
Modular ASR Post-Processing & Non-Destructive Error Correction Engine.

Separates low-level acoustic/token cleanup from domain-specific Pali lexicon rules:
1. Sub-word token coalescing (`coalesce_subword_timings`)
2. 30-second seek-boundary & micro-loop stutter deduplication (`deduplicate_stutters`)
3. High-PMI collocation & homophone anchor completion (`apply_collocations`)
4. Confidence-gated phonetic lexicon matching (`apply_phonetic_lexicon`)
5. Curated Pali terminology normalization (`TerminologyEditor`)

Preserves `raw_text` on every segment so post-processing is non-destructive and
idempotently repeatable from the pristine ASR baseline.
"""

import difflib
import logging
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from deeper_dhamma.lexicon import BuddhismLexiconDatabase, strip_diacritics
from deeper_dhamma.terminology import TerminologyEditor

logger = logging.getLogger("postprocess")

# Words that legitimately repeat consecutively in natural spoken English / Dhamma talks
# Unless they sit at a segment edge or have a severe confidence drop, we preserve them.
VALID_ENGLISH_REDUPLICATIONS = frozenset({
    "very", "many", "had", "that", "so", "no", "yes", "ha", "haha",
    "bye", "one", "long", "far", "step", "day", "little", "more",
    "knock", "blah", "tut", "tsk", "now", "there", "well",
})

# High-frequency everyday English words that must never be replaced by single-word
# phonetic Pali guessing (even when spoken softly with low token probability).
COMMON_ENGLISH_PROTECTED_WORDS = frozenset({
    "there", "their", "where", "other", "water", "matter", "better", "under",
    "after", "never", "every", "again", "think", "thing", "world", "place",
    "state", "sense", "three", "through", "throw", "those", "these", "while",
    "which", "would", "could", "should", "about", "right", "light", "night",
    "might", "great", "first", "still", "peace", "heart", "sound", "found",
    "going", "doing", "being", "human", "woman", "money", "happy", "story",
    "sorry", "worry", "early", "carry", "marry", "party", "comma", "common",
    "person", "people", "father", "mother", "sister", "brother", "little",
    "middle", "simple", "single", "normal", "mental", "nature", "future",
})

# High-PMI spoken collocations & homophone anchors where British/Australian
# non-rhotic vowels or Whisper language priors produce predictable acoustic slips.
COLLOCATION_RULES: List[Dict] = [
    {
        "pattern": re.compile(
            r"\bsloth\s+and\s+(?:twelver|tulpa|topper|torpa|taller|talker|torture|torpor)\b",
            re.IGNORECASE,
        ),
        "replacement": "sloth and torpor",
        "category": "collocation",
        "explanation": "Five Hindrances collocation ('sloth and torpor' / thina-middha)",
        "context_requirement": None,
    },
    {
        "pattern": re.compile(
            r"\b(?:my|our|your|their|his|her|just)\s+ritual\s+thinking\b",
            re.IGNORECASE,
        ),
        "replacement_fn": lambda m: re.sub(r"ritual\s+thinking", "wishful thinking", m.group(0), flags=re.IGNORECASE),
        "canonical_label": "wishful thinking",
        "category": "collocation",
        "explanation": "Acoustic collocation correction ('ritual thinking' -> 'wishful thinking')",
        "context_requirement": None,
    },
    {
        "pattern": re.compile(
            r"\bbear\s+from\s+the\s+waist\b",
            re.IGNORECASE,
        ),
        "replacement": "bare from the waist",
        "category": "homophone",
        "explanation": "Homophone disambiguation ('bear from the waist' -> 'bare from the waist')",
        "context_requirement": None,
    },
    {
        "pattern": re.compile(
            r"\bajahn\s+(?:yanadam|yana\s+dhamma|jhana\s+dhamma|nyanadhammo|yanadhammo)\b",
            re.IGNORECASE,
        ),
        "replacement": "Ajahn Jhanadhammo",
        "category": "monastic_name",
        "explanation": "Forest Sangha monastic name ('Ajahn Jhanadhammo')",
        "context_requirement": None,
    },
]


def phonetic_skeleton(word: str) -> str:
    """
    Computes an auditory consonant/vowel skeleton tailored for Pali and non-rhotic
    English ASR confusions (e.g. 'bh'/'b', 'dh'/'d', 'kh'/'k', 'th'/'t', 'ph'/'p',
    'ch'/'c', 'sh'/'s', 'v'/'w', 'j'/'y', non-rhotic 'ar'/'or'/'er' -> 'a').
    """
    w = strip_diacritics(word.lower())
    w = re.sub(r"[^a-z]", "", w)
    if not w:
        return ""

    # Normalize aspirated stops and common Pali/English phonetic equivalences
    replacements = [
        ("bh", "b"),
        ("dh", "d"),
        ("gh", "g"),
        ("jh", "j"),
        ("kh", "k"),
        ("ph", "p"),
        ("th", "t"),
        ("ch", "c"),
        ("sh", "s"),
        ("ck", "k"),
        ("qu", "k"),
        ("wh", "w"),
        ("v", "w"),
        ("y", "j"),
    ]
    for src, dst in replacements:
        w = w.replace(src, dst)

    # Collapse doubled letters (e.g. 'kamma' -> 'kama', 'sutta' -> 'suta')
    collapsed = [w[0]]
    for ch in w[1:]:
        if ch != collapsed[-1]:
            collapsed.append(ch)
    w = "".join(collapsed)

    # Normalize vowels to 'a' while preserving leading vowel and consonant skeleton
    out = []
    for idx, ch in enumerate(w):
        if ch in "aeiou":
            if idx == 0 or (out and out[-1] != "a"):
                out.append("a")
        elif ch == "h":
            continue
        else:
            out.append(ch)
    return "".join(out)


def coalesce_subword_timings(words: List[Dict]) -> List[Dict]:
    """
    Merges any sub-word continuation entries in `words` that do not begin with
    a leading space (e.g. hyphenated compounds like 'citta' + '-viveka,') into
    their preceding word entry so `words` aligns 1:1 with whitespace tokens.
    """
    if not words:
        return []
    has_leading_spaces = any(str(w.get("word", "")).startswith(" ") for w in words)
    merged: List[Dict] = []
    for idx, w in enumerate(words):
        raw_w = str(w.get("word", ""))
        should_coalesce = (
            idx > 0
            and raw_w
            and (
                (has_leading_spaces and not raw_w[0].isspace() and not str(merged[-1].get("word", ""))[-1:].isspace())
                or (not has_leading_spaces and (raw_w.startswith("-") or raw_w.startswith("—")))
            )
        )
        if should_coalesce:
            prev = merged[-1]
            merged[-1] = {
                **prev,
                "word": str(prev.get("word", "")) + raw_w,
                "end": max(float(prev["end"]), float(w["end"])),
                "prob": round(min(float(prev.get("prob", 1.0)), float(w.get("prob", 1.0))), 3),
            }
        else:
            merged.append(dict(w))
    return merged


def pack_words_blob(words: List[Dict], vbr_trailer: Optional[bytes] = None) -> bytes:
    """Serializes physical word timestamps (in sequential turn/token order) and optional VBR1 seek trailer into a compact binary BLOB."""
    import struct

    buf = bytearray()
    buf.extend(struct.pack("<I", len(words)))
    for w in words:
        st_ms = int(round(float(w["start"]) * 1000.0))
        en_ms = int(round(float(w["end"]) * 1000.0))
        dur_ms = max(1, min(65535, en_ms - st_ms))
        buf.extend(struct.pack("<IH", st_ms, dur_ms))
    if vbr_trailer:
        buf.extend(vbr_trailer)
    return bytes(buf)


def extract_vbr_trailer(words_blob: Optional[bytes]) -> bytes:
    """Extracts the trailing VBR1 seek trailer (if present) from an existing `words_blob`."""
    import struct

    if not words_blob or len(words_blob) < 4:
        return b""
    word_count = struct.unpack_from("<I", words_blob, 0)[0]
    offset = 4 + word_count * 6
    if len(words_blob) > offset:
        return bytes(words_blob[offset:])
    return b""


def count_words_in_blob(words_blob: Optional[bytes]) -> int:
    """Returns the indexed word count stored in a packed word-timing binary BLOB header."""
    import struct

    if not words_blob or len(words_blob) < 4:
        return 0
    return int(struct.unpack_from("<I", words_blob, 0)[0])


def unpack_words_blob_to_segments(words_blob: Optional[bytes], segments: List[Dict]) -> bool:
    """
    Reconstructs per-segment `words` lists from a compact `words_blob` when segments
    do not already carry word-level timing dicts (e.g. legacy episodes in SQLite).
    Returns True if `words_blob` matched the total whitespace token count across `segments`.
    """
    import struct

    if not words_blob or len(words_blob) < 4 or not segments:
        return False

    word_count = struct.unpack_from("<I", words_blob, 0)[0]
    if len(words_blob) < 4 + word_count * 6:
        return False

    seg_token_lists = [(seg.get("text") or "").split() for seg in segments]
    total_tokens = sum(len(t) for t in seg_token_lists)
    if total_tokens != word_count:
        return False

    cursor = 0
    for seg, toks in zip(segments, seg_token_lists):
        seg_words: List[Dict] = []
        for tok in toks:
            st_ms, dur_ms = struct.unpack_from("<IH", words_blob, 4 + cursor * 6)
            st_s = round(st_ms / 1000.0, 3)
            en_s = round((st_ms + dur_ms) / 1000.0, 3)
            seg_words.append({
                "word": f" {tok}",
                "start": st_s,
                "end": en_s,
                "prob": 0.90,
            })
            cursor += 1
        seg["words"] = seg_words
        seg["raw_words"] = [dict(w) for w in seg_words]
    return True


def clean_word_token(raw_word: str) -> str:
    """Strips punctuation and whitespace for case-insensitive token comparison."""
    return re.sub(r"[^\w']", "", raw_word.strip().lower())


def deduplicate_stutters(
    text: str,
    words: Optional[List[Dict]] = None,
    max_pause_sec: float = 0.25,
    confidence_ceiling: float = 0.82,
) -> Tuple[str, Optional[List[Dict]], List[Dict]]:
    """
    Detects and removes 30-second seek-boundary word duplications and decoder micro-loops
    (e.g. 'left foot foot', 'from the beginning beginning', 'anything thing', 'thinking thinking').

    Uses word-level timestamps and probabilities when available:
    - Non-whitelisted exact consecutive duplicate words (`w1 == w2` with no terminal punctuation
      separating two sentences) are collapsed if they have no intentional pause (`gap <= max_pause_sec`).
    - Whitelisted words (e.g. 'very', 'that', 'well') are only collapsed if one of the copies
      has low ASR confidence (`prob < confidence_ceiling` and `gap <= 0.12s`) or repeats >= 3 times.
    """
    changes: List[Dict] = []

    if words:
        coalesced = coalesce_subword_timings(words)
        text_tokens = text.split()
        if len(coalesced) == len(text_tokens) and len(coalesced) >= 2:
            out_words: List[Dict] = []
            out_tokens: List[str] = []
            i = 0
            n = len(coalesced)
            while i < n:
                w_curr = coalesced[i]
                tok_curr = text_tokens[i]
                clean_curr = clean_word_token(tok_curr)

                # Check for 2-word phrase stutter (e.g. "ritual thinking thinking" or "you know you know")
                if i + 1 < n:
                    w_next = coalesced[i + 1]
                    tok_next = text_tokens[i + 1]
                    clean_next = clean_word_token(tok_next)

                    # Sentence boundary punctuation on the first word means intentional repetition
                    has_sentence_break = bool(re.search(r"[.!?;:—]$", tok_curr.strip()))
                    has_comma_break = tok_curr.strip().endswith(",")

                    if clean_curr and clean_curr == clean_next and len(clean_curr) >= 2 and not has_sentence_break:
                        gap = max(0.0, float(w_next.get("start", 0.0)) - float(w_curr.get("end", 0.0)))
                        prob_curr = float(w_curr.get("prob", 1.0))
                        prob_next = float(w_next.get("prob", 1.0))
                        min_prob = min(prob_curr, prob_next)

                        # Check if it's a triple repetition (always a stutter)
                        is_triple = (
                            i + 2 < n
                            and clean_word_token(text_tokens[i + 2]) == clean_curr
                        )

                        is_whitelisted = clean_curr in VALID_ENGLISH_REDUPLICATIONS
                        should_dedup = False

                        if is_triple and not has_comma_break and not is_whitelisted:
                            should_dedup = True
                        elif not is_whitelisted and not has_comma_break:
                            # Non-reduplicating word (e.g. "foot foot", "beginning beginning", "thing thing")
                            if gap <= max_pause_sec or min_prob < confidence_ceiling:
                                should_dedup = True
                        elif is_whitelisted and not has_comma_break:
                            # Whitelisted word only deduplicated when clearly a low-confidence boundary artifact
                            if gap <= 0.12 and min_prob < 0.65:
                                should_dedup = True

                        if should_dedup:
                            # Preserve trailing punctuation from the second token if any
                            trailing_punct = re.search(r"[^\w']+$", tok_next.strip())
                            merged_tok = tok_curr.rstrip(",;:")
                            if trailing_punct and not merged_tok.endswith(trailing_punct.group(0)):
                                base_tok = re.sub(r"[^\w']+$", "", tok_curr.strip())
                                merged_tok = base_tok + trailing_punct.group(0)

                            merged_word = {
                                **w_curr,
                                "word": f" {merged_tok}" if str(w_curr.get("word", "")).startswith(" ") else merged_tok,
                                "end": max(float(w_curr["end"]), float(w_next["end"])),
                                "prob": round(max(prob_curr, prob_next), 3),
                            }
                            out_words.append(merged_word)
                            out_tokens.append(merged_tok)
                            changes.append({
                                "original": f"{tok_curr} {tok_next}",
                                "replacement": merged_tok,
                                "category": "stutter_dedup",
                                "explanation": "Removed Whisper 30s seek-boundary word duplication",
                                "rationale": f"gap={gap:.2f}s, min_prob={min_prob:.2f}",
                                "count": 1,
                            })
                            i += 2
                            continue

                out_words.append(w_curr)
                out_tokens.append(tok_curr)
                i += 1

            return " ".join(out_tokens), out_words, changes

    # Text-only fallback when `words` is absent or misaligned
    tokens = text.split()
    if len(tokens) < 2:
        return text, words, changes

    out_tokens = []
    i = 0
    while i < len(tokens):
        t_curr = tokens[i]
        c_curr = clean_word_token(t_curr)
        if i + 1 < len(tokens):
            t_next = tokens[i + 1]
            c_next = clean_word_token(t_next)
            has_punct = bool(re.search(r"[.!?;:,—]$", t_curr.strip()))
            if (
                c_curr
                and c_curr == c_next
                and len(c_curr) >= 3
                and not has_punct
                and c_curr not in VALID_ENGLISH_REDUPLICATIONS
            ):
                base_tok = re.sub(r"[^\w']+$", "", t_curr.strip())
                trailing = re.search(r"[^\w']+$", t_next.strip())
                merged_tok = base_tok + (trailing.group(0) if trailing else "")
                out_tokens.append(merged_tok)
                changes.append({
                    "original": f"{t_curr} {t_next}",
                    "replacement": merged_tok,
                    "category": "stutter_dedup",
                    "explanation": "Removed consecutive non-reduplicating word stutter",
                    "rationale": "text-level duplicate token",
                    "count": 1,
                })
                i += 2
                continue
        out_tokens.append(t_curr)
        i += 1

    new_text = " ".join(out_tokens)
    if words and changes:
        words = TerminologyEditor._sync_word_timings(words, new_text, orig_text=text)
    return new_text, words, changes


class TranscriptPostProcessor:
    """
    Coordinates multi-stage, non-destructive ASR post-processing across transcript segments:
    1. Preserves `raw_text` on every segment before mutation.
    2. Coalesces sub-word BPE continuations.
    3. Deduplicates 30s seek-boundary word stutters (`deduplicate_stutters`).
    4. Applies high-PMI collocation & homophone anchors (`apply_collocations`).
    5. Applies confidence-gated phonetic lexicon matching (`apply_phonetic_lexicon`).
    6. Runs curated Pali terminology normalization (`TerminologyEditor`).
    """

    def __init__(
        self,
        lexicon_db_path: Optional[Path | str] = None,
        terminology_editor: Optional[TerminologyEditor] = None,
        confidence_threshold: float = 0.72,
    ):
        self.terminology_editor = terminology_editor or TerminologyEditor(lexicon_db_path)
        self.lexicon_db: BuddhismLexiconDatabase = self.terminology_editor.lexicon_db
        self.confidence_threshold = confidence_threshold
        self._phonetic_index: Optional[Dict[str, List[Dict]]] = None

    def _ensure_phonetic_index(self) -> Dict[str, List[Dict]]:
        """Builds an in-memory phonetic skeleton index over canonical Pali terms with context keywords."""
        if self._phonetic_index is not None:
            return self._phonetic_index

        index: Dict[str, List[Dict]] = {}
        stop_words = {
            "the", "and", "for", "with", "that", "this", "from", "into", "not", "are",
            "was", "were", "one", "does", "something", "other", "hand", "moreover",
            "word", "worth", "noting", "had", "his", "first", "while", "under", "young",
        }
        try:
            with self.lexicon_db.connection() as conn:
                rows = conn.execute(
                    """
                    SELECT pali_plain, category, context_keywords,
                           translation_brahm, translation_sujato, translation_bodhi,
                           translation_brahmali, english_description
                    FROM v_terms
                    WHERE LENGTH(pali_plain) >= 5 AND pali_plain NOT LIKE '% %';
                    """
                ).fetchall()
            for r in rows:
                plain = r["pali_plain"]
                skel = phonetic_skeleton(plain)
                if len(skel) < 4:
                    continue
                kw_set = {
                    k.strip().lower()
                    for k in (r["context_keywords"] or "").split(",")
                    if k.strip() and k.strip().lower() != plain
                }
                for col in ("category", "translation_brahm", "translation_sujato", "translation_bodhi", "translation_brahmali", "english_description"):
                    val = r[col] or ""
                    for w_match in re.findall(r"[a-zA-Z]{4,}", val.lower()):
                        if w_match not in stop_words and w_match != plain:
                            kw_set.add(w_match)
                entry = {
                    "pali_plain": plain,
                    "skeleton": skel,
                    "category": r["category"] or "pali_term",
                    "context_keywords": sorted(kw_set),
                    "explanation": r["english_description"] or f"Canonical Pali term '{plain}'",
                }
                index.setdefault(skel, []).append(entry)
        except Exception as e:
            logger.debug(f"Could not build phonetic index: {e}")

        self._phonetic_index = index
        return index

    def apply_collocations(
        self,
        text: str,
        surrounding_context: str = "",
    ) -> Tuple[str, List[Dict]]:
        """Applies high-PMI spoken collocation & homophone anchor corrections."""
        cleaned = text
        changes: Dict[str, Dict] = {}
        context_window = f"{surrounding_context} {text}".strip()

        for rule in COLLOCATION_RULES:
            pattern: re.Pattern = rule["pattern"]
            ctx_req: Optional[re.Pattern] = rule.get("context_requirement")
            if ctx_req and not ctx_req.search(context_window):
                continue

            matches = list(pattern.finditer(cleaned))
            if not matches:
                continue

            for m in matches:
                orig_span = m.group(0)
                if "replacement_fn" in rule:
                    rep_span = rule["replacement_fn"](m)
                else:
                    rep_span = rule["replacement"]

                if rep_span.lower() == orig_span.lower():
                    continue

                key = f"{orig_span} -> {rep_span}"
                if key not in changes:
                    changes[key] = {
                        "original": orig_span,
                        "replacement": rep_span,
                        "category": rule["category"],
                        "explanation": rule["explanation"],
                        "rationale": "High-PMI spoken collocation anchor",
                        "count": 0,
                    }
                changes[key]["count"] += 1
                cleaned = re.sub(re.escape(orig_span), rep_span, cleaned, count=1)

        return cleaned, list(changes.values())

    def apply_phonetic_lexicon(
        self,
        text: str,
        words: Optional[List[Dict]],
        surrounding_context: str = "",
    ) -> Tuple[str, Optional[List[Dict]], List[Dict]]:
        """
        Confidence-gated phonetic lexicon matching:
        - Locks all high-confidence words (`prob >= self.confidence_threshold`) so valid
          English words are never over-corrected.
        - When a single token has low ASR confidence (`prob < self.confidence_threshold`)
          and matches the exact phonetic skeleton of a canonical Pali term whose
          `context_keywords` appear in the surrounding text, replaces the token.
        """
        if not words:
            return text, words, []

        coalesced = coalesce_subword_timings(words)
        tokens = text.split()
        if len(coalesced) != len(tokens):
            return text, words, []

        p_index = self._ensure_phonetic_index()
        if not p_index:
            return text, words, []

        ctx_lower = f"{surrounding_context} {text}".lower()
        changes: List[Dict] = []
        new_tokens = list(tokens)
        new_words = [dict(w) for w in coalesced]

        for idx, (tok, w_obj) in enumerate(zip(tokens, coalesced)):
            prob = float(w_obj.get("prob", 1.0))
            if prob >= self.confidence_threshold:
                continue  # Locked: high-confidence word

            clean_tok = clean_word_token(tok)
            if len(clean_tok) < 5 or clean_tok in COMMON_ENGLISH_PROTECTED_WORDS:
                continue

            skel = phonetic_skeleton(clean_tok)
            candidates = p_index.get(skel)
            if not candidates:
                continue

            for cand in candidates:
                target = cand["pali_plain"]
                if clean_tok == target:
                    break
                # Require at least one context keyword match in surrounding speech
                kws = cand["context_keywords"]
                matched_kw = next((kw for kw in kws if kw and kw in ctx_lower), None)
                if not matched_kw:
                    continue

                # Check character similarity isn't an unrelated English word
                ratio = difflib.SequenceMatcher(None, clean_tok, target).ratio()
                if ratio < 0.75:
                    continue

                # Preserve leading/trailing punctuation
                lead_m = re.match(r"^[^\w']+", tok)
                trail_m = re.search(r"[^\w']+$", tok)
                lead = lead_m.group(0) if lead_m else ""
                trail = trail_m.group(0) if trail_m else ""
                rep_tok = f"{lead}{target}{trail}"

                new_tokens[idx] = rep_tok
                has_space = str(w_obj.get("word", "")).startswith(" ")
                new_words[idx]["word"] = f" {rep_tok}" if has_space else rep_tok
                changes.append({
                    "original": tok,
                    "replacement": rep_tok,
                    "category": cand["category"],
                    "explanation": cand["explanation"],
                    "rationale": f"Low ASR confidence (prob={prob:.2f} < {self.confidence_threshold}) + phonetic skeleton '{skel}' + context keyword '{matched_kw}'",
                    "count": 1,
                })
                break

        return " ".join(new_tokens), new_words, changes

    def process_segments(
        self,
        segments: List[Dict],
        reset_from_raw: bool = False,
    ) -> Tuple[List[Dict], List[Dict]]:
        """
        Runs the complete multi-stage post-processing pipeline across `segments`.
        - Preserves `seg["raw_text"]` before applying any transformations.
        - If `reset_from_raw=True`, restores `seg["text"] = seg["raw_text"]` first so
          re-processing is 100% idempotent and starts from the pristine ASR baseline.
        """
        aggregated_changes: Dict[str, Dict] = {}

        def _record_changes(change_list: List[Dict]) -> None:
            for ch in change_list:
                key = f"{ch['original']} -> {ch['replacement']}"
                if key not in aggregated_changes:
                    aggregated_changes[key] = {
                        "original": ch["original"],
                        "replacement": ch["replacement"],
                        "category": ch.get("category", "postprocess"),
                        "explanation": ch.get("explanation", ""),
                        "rationale": ch.get("rationale", ""),
                        "count": 0,
                    }
                aggregated_changes[key]["count"] += ch.get("count", 1)

        # Stage 0: Preserve or restore raw_text and raw_words baseline
        for seg in segments:
            if not seg.get("raw_text") and seg.get("text"):
                seg["raw_text"] = seg["text"]
            elif reset_from_raw and seg.get("raw_text"):
                seg["text"] = seg["raw_text"]

            if seg.get("words") and not seg.get("raw_words"):
                seg["raw_words"] = [dict(w) for w in coalesce_subword_timings(seg["words"])]
            elif reset_from_raw and seg.get("raw_words"):
                seg["words"] = [dict(w) for w in seg["raw_words"]]

            if seg.get("words"):
                seg["words"] = coalesce_subword_timings(seg["words"])

        # Stages 1-3: Stutter deduplication, Collocations, and Confidence-Gated Phonetic Lexicon
        for i, seg in enumerate(segments):
            text = seg.get("text") or ""
            if not text:
                continue

            prev_text = (segments[i - 1].get("raw_text") or segments[i - 1].get("text") or "") if i > 0 else ""
            next_text = (segments[i + 1].get("raw_text") or segments[i + 1].get("text") or "") if i + 1 < len(segments) else ""
            surrounding = f"{prev_text} {next_text}".strip()

            words = seg.get("words")

            # Stage 1: Seek-boundary & micro-loop stutter deduplication
            text_dedup, words, dedup_changes = deduplicate_stutters(text, words)
            _record_changes(dedup_changes)

            # Stage 2: High-PMI Collocation & Homophone anchors
            text_colloc, colloc_changes = self.apply_collocations(text_dedup, surrounding_context=surrounding)
            if colloc_changes and words:
                words = TerminologyEditor._sync_word_timings(words, text_colloc, orig_text=text_dedup)
            _record_changes(colloc_changes)

            # Stage 3: Confidence-Gated Phonetic Lexicon matching
            text_phon, words, phon_changes = self.apply_phonetic_lexicon(
                text_colloc,
                words,
                surrounding_context=surrounding,
            )
            _record_changes(phon_changes)

            seg["text"] = text_phon
            if words is not None:
                seg["words"] = words

        # Stage 4: Curated Pali terminology normalization & audit pass
        segments, term_changes = self.terminology_editor.edit_segments(segments)
        _record_changes(term_changes)

        # Stage 5: Clamp any stranded unpunctuated lead-in Word 0 (gap >= 2.5s) created by turn splitting/merging
        for seg in segments:
            words = seg.get("words")
            toks = (seg.get("text") or "").split()
            if words and len(words) >= 2 and len(words) == len(toks):
                lead_gap = float(words[1]["start"]) - float(words[0]["end"])
                w0_tok = toks[0]
                if lead_gap >= 2.5 and w0_tok and w0_tok[-1] not in ".?!,:;":
                    dur0 = min(max(0.25, float(words[0]["end"]) - float(words[0]["start"])), 0.60)
                    words[0]["end"] = round(float(words[1]["start"]), 3)
                    words[0]["start"] = round(max(0.0, float(words[1]["start"]) - dur0), 3)
                    seg["start"] = words[0]["start"]

        return segments, list(aggregated_changes.values())
