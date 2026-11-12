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


def test_storage_non_destructive_raw_asr_and_reprocess_episodes(tmp_path):
    """
    Verifies Phase 2 non-destructive storage and offline re-processing:
    1. `save_episode` stores pristine `raw_text` and `raw_words` in `pipeline_state.db`.
    2. `reprocess_episodes(dry_run=True)` previews updates without modifying `dhamma_transcripts.db`.
    3. `reprocess_episodes(dry_run=False)` updates `speech_segments.text`, `terminology_changelog`,
       FTS5 search index, and `episode_words` binary BLOB while preserving any VBR1 seek trailer.
    """
    from deeper_dhamma.postprocess import extract_vbr_trailer, pack_words_blob
    from deeper_dhamma.storage import TranscriptDatabase

    db_path = tmp_path / "test_transcripts.db"
    db = TranscriptDatabase(db_path=db_path)

    raw_text = (
        "Watch the left foot foot when sloth and twelver arises, "
        "or that's my ritual thinking."
    )
    tokens = raw_text.split()
    words = [
        {"word": f" {tok}", "start": float(i) * 0.25, "end": float(i) * 0.25 + 0.20, "prob": 0.50}
        for i, tok in enumerate(tokens)
    ]

    # Simulate an episode saved before post-processing ran (or with older rules)
    meta = {
        "id": "pb_test_01",
        "title": "Test Retreat Q&A | Ajahn Brahm",
        "primary_teacher": "ajahn_brahm",
        "primary_display": "Ajahn Brahm",
        "media_url": "https://example.com/audio.mp3",
        "permalink": "https://example.com/post",
        "upload_date": "20061102",
        "is_multi_speaker": False,
        "speaker_shares": {"ajahn_brahm": 1.0},
    }
    segs = [
        {
            "start": 0.0,
            "end": 5.0,
            "speaker": "ajahn_brahm",
            "speaker_display": "Ajahn Brahm",
            "raw_text": raw_text,
            "text": raw_text,
            "raw_words": words,
            "words": words,
        }
    ]
    db.save_episode(
        episode_metadata=meta,
        attributed_segments=segs,
        duration_sec=300.0,
        year="2006",
        filename_stem="2006-11-02_test",
        terminology_changelog=[],
    )

    fake_vbr_trailer = b"VBR1\x01\x00\x00\x00\x10\x27\x00\x00"
    initial_blob = pack_words_blob(words, vbr_trailer=fake_vbr_trailer)
    db.save_episode_words("pb_test_01", initial_blob)

    # Verify pristine raw ASR was saved in pipeline_state.db
    stored_raw = db.pipeline_db.get_raw_asr("pb_test_01")
    assert stored_raw is not None
    assert stored_raw[0]["raw_text"] == raw_text
    assert len(stored_raw[0]["raw_words"]) == len(tokens)

    # Dry-run reprocess should detect modifications without mutating the DB
    dry_res = db.reprocess_episodes(episode_ids=["pb_test_01"], dry_run=True)
    assert dry_res["episodes_scanned"] == 1
    assert dry_res["episodes_updated"] == 1
    assert dry_res["segments_modified"] == 1
    ep_before = db.get_episode("pb_test_01")
    assert ep_before["segments"][0]["text"] == raw_text

    # Live reprocess should update text, FTS5, changelog, and words_blob (preserving VBR1 trailer)
    live_res = db.reprocess_episodes(episode_ids=["pb_test_01"], dry_run=False)
    assert live_res["episodes_updated"] == 1
    ep_after = db.get_episode("pb_test_01")
    updated_text = ep_after["segments"][0]["text"]
    assert "left foot when sloth and torpor arises" in updated_text
    assert "my wishful thinking" in updated_text
    assert len(ep_after["terminology_changelog"]) >= 3

    # FTS5 index must reflect the updated text ("torpor" and "wishful")
    fts_hits = db.search_fts("torpor wishful")
    assert len(fts_hits) == 1
    assert fts_hits[0]["episode_id"] == "pb_test_01"

    # VBR1 seek trailer must remain intact in re-packed words_blob
    updated_blob = db.get_episode_words("pb_test_01")
    assert extract_vbr_trailer(updated_blob) == fake_vbr_trailer

    # Second live reprocess with same rules should report 0 changes (idempotent)
    second_res = db.reprocess_episodes(episode_ids=["pb_test_01"], dry_run=False)
    assert second_res["episodes_updated"] == 0
    assert second_res["segments_modified"] == 0


def test_cli_postprocess_help_and_execution(tmp_path):
    """
    Verifies CLI design compliance for `postprocess` subcommand:
    1. Running `postprocess` without `--run` prints deterministic help without executing.
    2. Running `postprocess --run --dry-run` previews changes without altering DB.
    3. Running `postprocess --run --id pb_cli_01` applies post-processing via CLI.
    """
    from io import StringIO
    from unittest.mock import patch
    from deeper_dhamma.cli import main
    from deeper_dhamma.storage import TranscriptDatabase

    db_path = tmp_path / "cli_postprocess.db"
    db = TranscriptDatabase(db_path=db_path)

    raw_text = "On retreat sloth and tulpa fades away."
    db.save_episode(
        episode_metadata={
            "id": "pb_cli_01",
            "title": "CLI Postprocess Talk | Ajahn Brahm",
            "primary_teacher": "ajahn_brahm",
            "primary_display": "Ajahn Brahm",
            "upload_date": "20100501",
        },
        attributed_segments=[
            {
                "start": 0.0,
                "end": 4.0,
                "speaker": "ajahn_brahm",
                "speaker_display": "Ajahn Brahm",
                "raw_text": raw_text,
                "text": raw_text,
            }
        ],
        duration_sec=120.0,
        year="2010",
        filename_stem="2010-05-01_cli_postprocess",
        terminology_changelog=[],
    )

    # 1. Incomplete input (no --run) -> prints help, does not mutate DB
    with patch("sys.stdout", new_callable=StringIO) as mock_out:
        main(["postprocess", "--db", str(db_path)])
        help_out = mock_out.getvalue()
        assert "--run" in help_out
    assert db.get_episode("pb_cli_01")["segments"][0]["text"] == raw_text

    # 2. Dry run (--run --dry-run) -> previews update, does not mutate DB
    with patch("sys.stdout", new_callable=StringIO) as mock_out:
        main(["postprocess", "--run", "--dry-run", "--db", str(db_path)])
        dry_out = mock_out.getvalue()
        assert "DRY RUN" in dry_out
        assert "sloth and torpor" in dry_out
    assert db.get_episode("pb_cli_01")["segments"][0]["text"] == raw_text

    # 3. Live run (--run --id pb_cli_01) -> applies update
    with patch("sys.stdout", new_callable=StringIO) as mock_out:
        main(["postprocess", "--run", "--id", "pb_cli_01", "--db", str(db_path)])
        live_out = mock_out.getvalue()
        assert "LIVE UPDATE" in live_out
    assert "sloth and torpor" in db.get_episode("pb_cli_01")["segments"][0]["text"]


