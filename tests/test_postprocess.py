"""
Unit tests for modular ASR post-processing (`deeper_dhamma/postprocess.py`).
"""

from deeper_dhamma.postprocess import (
    TranscriptPostProcessor,
    coalesce_subword_timings,
    deduplicate_stutters,
    phonetic_skeleton,
)


def test_phonetic_skeleton_pali_and_accent_equivalences():
    """Verifies that phonetic_skeleton normalizes aspirated stops, doubled consonants, and v/w/y/j."""
    assert phonetic_skeleton("dhamma") == phonetic_skeleton("dama")
    assert phonetic_skeleton("bhikkhu") == phonetic_skeleton("biku")
    assert phonetic_skeleton("jhana") == phonetic_skeleton("yana")
    assert phonetic_skeleton("samadhi") == phonetic_skeleton("samadi")
    assert phonetic_skeleton("vipassana") == phonetic_skeleton("wipasana")


def test_deduplicate_stutters_removes_seek_boundary_duplications_and_preserves_valid_reduplications():
    """
    Verifies that 30-second seek-boundary word duplications ('foot foot', 'beginning beginning')
    are collapsed while valid high-confidence English reduplications ('many many') are kept,
    and word timing arrays remain 1:1 synchronized.
    """
    text = "Watch the left foot foot from the beginning beginning and many many times."
    tokens = text.split()
    words = []
    t = 0.0
    for tok in tokens:
        prob = 0.95
        if tok in ("foot", "beginning"):
            prob = 0.55
        words.append({"word": f" {tok}", "start": t, "end": t + 0.25, "prob": prob})
        t += 0.30  # gap = 0.05s

    cleaned_text, cleaned_words, changes = deduplicate_stutters(text, words)
    assert cleaned_text == "Watch the left foot from the beginning and many many times."
    assert len(cleaned_words) == len(cleaned_text.split())
    assert len(changes) == 2
    assert any(c["original"] == "foot foot" and c["replacement"] == "foot" for c in changes)
    assert any(c["original"] == "beginning beginning" and c["replacement"] == "beginning" for c in changes)


def test_deduplicate_stutters_collapses_low_confidence_whitelisted_boundary_stutter():
    """
    Verifies that even a whitelisted word like 'well' or 'that' is deduplicated when it occurs
    as a zero-pause, low-confidence seek-boundary artifact ('as well well').
    """
    text = "Put in effort as well well being able to let go."
    tokens = text.split()
    words = []
    t = 10.0
    for idx, tok in enumerate(tokens):
        prob = 0.42 if (tok == "well" and idx == 5) else 0.92
        words.append({"word": f" {tok}", "start": t, "end": t + 0.20, "prob": prob})
        t += 0.22  # gap = 0.02s

    cleaned_text, cleaned_words, changes = deduplicate_stutters(text, words)
    assert cleaned_text == "Put in effort as well being able to let go."
    assert len(cleaned_words) == len(cleaned_text.split())
    assert len(changes) == 1


def test_collocation_and_homophone_anchor_corrections():
    """
    Verifies high-PMI spoken collocation rules fixed from benchmark errors:
    - 'sloth and twelver' / 'sloth and tulpa' -> 'sloth and torpor'
    - 'my ritual thinking' -> 'my wishful thinking'
    - 'bear from the waist' -> 'bare from the waist'
    - 'ajahn yanadam' -> 'Ajahn Jhanadhammo'
    """
    processor = TranscriptPostProcessor()
    raw = (
        "On retreat sloth and twelver starts to disappear, or sloth and tulpa fades. "
        "However that's my ritual thinking. We were bear from the waist upwards, "
        "and ajahn yanadam told a story."
    )
    corrected, changes = processor.apply_collocations(raw)
    assert "sloth and torpor starts" in corrected
    assert "sloth and torpor fades" in corrected
    assert "my wishful thinking" in corrected
    assert "bare from the waist" in corrected
    assert "Ajahn Jhanadhammo" in corrected
    assert len(changes) >= 4


def test_confidence_gated_phonetic_lexicon_locks_high_confidence_and_fixes_low_confidence():
    """
    Verifies that confidence-gated phonetic matching never alters high-confidence words,
    but corrects low-confidence phonetic slips when context keywords are present.
    """
    processor = TranscriptPostProcessor(confidence_threshold=0.72)

    # 1. Low confidence 'samadi' (prob=0.45) with meditation stillness context -> corrected to 'samadhi'
    text_low = "When the mind settles into deep stillness and peace in samadi during meditation."
    toks_low = text_low.split()
    words_low = [
        {
            "word": f" {w}",
            "start": float(i),
            "end": float(i) + 0.4,
            "prob": 0.45 if "samadi" in w else 0.96,
        }
        for i, w in enumerate(toks_low)
    ]
    fixed_text, fixed_words, changes = processor.apply_phonetic_lexicon(text_low, words_low)
    assert "samadhi" in fixed_text
    assert len(fixed_words) == len(fixed_text.split())
    assert len(changes) == 1

    # 2. High confidence token (prob=0.95) -> locked and untouched
    words_high = [
        {
            "word": f" {w}",
            "start": float(i),
            "end": float(i) + 0.4,
            "prob": 0.95,
        }
        for i, w in enumerate(toks_low)
    ]
    locked_text, _, locked_changes = processor.apply_phonetic_lexicon(text_low, words_high)
    assert locked_text == text_low
    assert len(locked_changes) == 0


def test_postprocessor_process_segments_preserves_raw_text_and_is_idempotent():
    """
    Verifies that TranscriptPostProcessor.process_segments:
    1. Preserves pristine `raw_text` on every segment.
    2. Applies stutter deduplication, collocation anchors, and Pali terminology rules.
    3. Produces identical output when re-run with `reset_from_raw=True`.
    """
    processor = TranscriptPostProcessor()
    raw_input = (
        "However that's my ritual thinking thinking on retreat when sloth and twelver "
        "arises before deep samadhi and kaya viveka in solitude in the forest."
    )
    tokens = raw_input.split()
    words = []
    t = 0.0
    for tok in tokens:
        prob = 0.50 if tok in ("thinking", "twelver", "kaya", "viveka") else 0.94
        words.append({"word": f" {tok}", "start": t, "end": t + 0.25, "prob": prob})
        t += 0.28

    segments = [
        {
            "start": 0.0,
            "end": t,
            "speaker": "ajahn_brahm",
            "speaker_display": "Ajahn Brahm",
            "text": raw_input,
            "words": words,
        }
    ]

    processed, changelog = processor.process_segments(segments)
    seg = processed[0]

    # raw_text must remain untouched
    assert seg["raw_text"] == raw_input
    assert "my wishful thinking on retreat" in seg["text"]
    assert "thinking thinking" not in seg["text"]
    assert "sloth and torpor" in seg["text"]
    assert "kayaviveka" in seg["text"]
    assert len(seg["words"]) == len(seg["text"].split())
    assert len(changelog) >= 3

    # Re-running with reset_from_raw=True must be idempotent
    first_pass_text = seg["text"]
    reprocessed, changelog2 = processor.process_segments(processed, reset_from_raw=True)
    assert reprocessed[0]["raw_text"] == raw_input
    assert reprocessed[0]["text"] == first_pass_text
    assert len(changelog2) == len(changelog)
