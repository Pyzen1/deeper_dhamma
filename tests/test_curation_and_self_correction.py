"""
Unit tests for Gold-Standard Reference Curation, Discrepancy Inspection, and Self-Correction Guardrails.
"""

from pathlib import Path
import pytest

from deeper_dhamma.curation import (
    get_curation_slug,
    inspect_lexicon_discrepancies,
    list_curated_references,
)
from deeper_dhamma.self_correction import SelfCorrectionEngine


def test_get_curation_slug():
    """Verifies curation slug generation strips duplicate date patterns and trailing counters."""
    p1 = Path("2026-03-28_2026_march_9_day_sutta_retreat_07_26_ajahn_brahmali.mp3")
    slug1 = get_curation_slug(p1)
    assert slug1 == "2026-03-28_2026_march_9_day_sutta_retreat_07_26_ajahn_brahmali"

    # Trailing month and year duplicate removed
    p2 = Path("2001-08-15_the_five_hindrances_ajahn_brahm_15_august_2001.mp3")
    slug2 = get_curation_slug(p2)
    assert slug2 == "2001-08-15_the_five_hindrances_ajahn_brahm"


def test_inspect_lexicon_discrepancies():
    """Verifies that acoustic false-friends and suspected Pali misrecognitions are flagged."""
    sample_text = (
        "Entering the first ghana in meditation. The monk was practicing with the bright "
        "nimiter during the vains retreat. Recitation of the party mocker and overcoming tarpaulin."
    )
    result = inspect_lexicon_discrepancies(sample_text)

    assert "flagged_candidates" in result
    assert "found_canonical" in result

    # Suspicious phonetic candidates detected
    flagged_reasons = [f["reason"] for f in result["flagged_candidates"]]
    assert any("jhana" in r.lower() for r in flagged_reasons)
    assert any("patimokkha" in r.lower() for r in flagged_reasons)
    assert any("torpor" in r.lower() for r in flagged_reasons)
    assert any("nimitta" in r.lower() for r in flagged_reasons)

    # Found canonical term
    assert "meditation" in result["found_canonical"] or len(result["found_canonical"]) > 0


def test_self_correction_anti_drift_guardrail():
    """Verifies _build_synthetic_reference retains high-confidence segments and rejects noisy ones."""
    # Test helper creating an unbound instance or testing _build_synthetic_reference directly
    engine = SelfCorrectionEngine.__new__(SelfCorrectionEngine)
    engine.min_confidence_logprob = -0.35
    engine.max_no_speech_prob = 0.10

    test_segments = [
        {
            "text": "When the mind is peaceful and still.",
            "avg_logprob": -0.15,  # High confidence -> Keep
            "no_speech_prob": 0.02,
        },
        {
            "text": "[indistinct background rustling noise]",
            "avg_logprob": -0.85,  # Low confidence -> Reject
            "no_speech_prob": 0.05,
        },
        {
            "text": "[silence]",
            "avg_logprob": -0.20,
            "no_speech_prob": 0.45,  # High no speech prob -> Reject
        },
        {
            "text": "The jhanas arise with profound stillness.",
            "avg_logprob": -0.22,  # High confidence -> Keep
            "no_speech_prob": 0.01,
        },
    ]

    synth_text, vetted_count, total_count = engine._build_synthetic_reference(test_segments)
    assert vetted_count == 2
    assert total_count == 4
    assert "When the mind is peaceful and still." in synth_text
    assert "The jhanas arise with profound stillness." in synth_text
    assert "[indistinct background rustling noise]" not in synth_text
    assert "[silence]" not in synth_text
