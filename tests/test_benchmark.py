"""
Unit tests for Pipeline Benchmark and Accuracy Evaluator.
"""

from pathlib import Path
import pytest

from deeper_dhamma.benchmark import (
    calculate_token_metrics,
    discover_active_benchmarks,
    find_matching_audio,
    normalize_text,
)


def test_normalize_text_strips_punctuation_and_lowercases():
    """Verifies normalize_text produces clean lowercased tokens."""
    raw = "The Buddha said: 'Meditation, Jhana, and Peace!' (1997)"
    tokens = normalize_text(raw)
    assert tokens == ["the", "buddha", "said", "meditation", "jhana", "and", "peace", "1997"]


def test_calculate_token_metrics_identical_sequences():
    """Verifies identical reference and hypothesis give 100% precision/recall and 0% WER."""
    tokens = ["mindfulness", "of", "breathing", "leads", "to", "stillness"]
    metrics = calculate_token_metrics(tokens, tokens)

    assert metrics["precision"] == 1.0
    assert metrics["recall"] == 1.0
    assert metrics["f1"] == 1.0
    assert metrics["wer"] == 0.0
    assert metrics["vocab_overlap_count"] == 6


def test_calculate_token_metrics_empty_inputs():
    """Verifies empty hypothesis or reference returns safe defaults."""
    empty_hyp = calculate_token_metrics(["some", "text"], [])
    assert empty_hyp["wer"] == 1.0
    assert empty_hyp["precision"] == 0.0

    empty_ref = calculate_token_metrics([], ["some", "text"])
    assert empty_ref["wer"] == 1.0
    assert empty_ref["recall"] == 0.0


def test_calculate_token_metrics_substitutions_and_deletions():
    """Verifies edit distance counts errors accurately."""
    ref = ["the", "noble", "eightfold", "path"]
    hyp = ["the", "eight", "fold", "path"]
    metrics = calculate_token_metrics(ref, hyp)

    assert metrics["precision"] < 1.0
    assert metrics["recall"] < 1.0
    assert metrics["wer"] > 0.0
    assert metrics["vocab_overlap_count"] >= 2


def test_calculate_token_metrics_prefix_alignment():
    """Verifies sliced hypothesis aligns to matching prefix window of a long reference."""
    ref = ["word" + str(i) for i in range(100)]
    hyp = ["word" + str(i) for i in range(20)]  # first 20 tokens
    metrics = calculate_token_metrics(ref, hyp)

    # Hypothesis perfectly matches the first 20 tokens of the prefix window
    assert metrics["precision"] == 1.0
    assert metrics["vocab_overlap_count"] == 20
    assert metrics["wer"] < 0.20


def test_find_matching_audio_by_date_and_tokens(tmp_path: Path):
    """Verifies find_matching_audio locates audio matching date and token overlap."""
    archive_dir = tmp_path / "archive"
    year_dir = archive_dir / "2001"
    year_dir.mkdir(parents=True)

    target_audio = year_dir / "2001-08-15_the_five_hindrances_ajahn_brahm.mp3"
    target_audio.touch()

    other_audio = year_dir / "2001-09-20_different_talk_ajahn_brahm.mp3"
    other_audio.touch()

    ref_doc = tmp_path / "2001-08-15_the_five_hindrances_ajahn_brahm.txt"
    ref_doc.touch()

    matched = find_matching_audio(ref_doc, archive_dir=archive_dir)
    assert matched is not None
    assert matched.name == target_audio.name


def test_discover_active_benchmarks_ignores_candidates(tmp_path: Path, monkeypatch):
    """Verifies discover_active_benchmarks ignores *_candidate.txt drafts."""
    ref_dir = tmp_path / "reference_transcripts"
    ref_dir.mkdir()

    # Create a draft candidate that should be ignored
    draft = ref_dir / "2026-01-01_sample_talk_candidate.txt"
    draft.write_text("draft transcript", encoding="utf-8")

    monkeypatch.setattr("deeper_dhamma.benchmark.REF_DIR", ref_dir)
    benchmarks = discover_active_benchmarks()
    assert len(benchmarks) == 0

