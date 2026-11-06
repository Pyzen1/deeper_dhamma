"""
Unit Tests for Transcription Pipeline Integrity, Voiceprint Scoring,
Speaker Turn Smoothing, Terminology Editing, and WebVTT Formatting.
"""

from deeper_dhamma.aligner import SpeakerAligner
from deeper_dhamma.benchmark import calculate_token_metrics
from deeper_dhamma.catalog import extract_recording_year, parse_episode_metadata
from deeper_dhamma.storage import format_timestamp_vtt
from deeper_dhamma.terminology import TerminologyEditor
from deeper_dhamma.voiceprints import VoiceprintDatabase


def test_extract_recording_year_backfilled_and_standard():
    """Verify recording year extraction handles trailing DD_MM_YYYY dates without altering parse_episode_metadata stems."""
    fname = "2020_07_10_ajahn_brahm_happiness_expectations_and_self_worth_14_12_2003.mp3"
    assert extract_recording_year(fname, fallback_year=2020) == 2003

    fname_1997 = "2006_09_28_ajahn_brahm_1997_9_day_retreat_day_1_part_1.mp3"
    assert extract_recording_year(fname_1997, fallback_year=2006) == 1997

    fname_normal = "2020_05_01_ajahn_brahm_playful_perceptions.mp3"
    assert extract_recording_year(fname_normal, fallback_year=2020) == 2020

    # Ensure parse_episode_metadata preserves the exact upload-date stem
    year_str, _, stem = parse_episode_metadata(
        "Happiness, Expectations and Self Worth | Ajahn Brahm | 14-12-2003", "20200710"
    )
    assert year_str == "2020"
    assert stem.startswith("2020-07-10_")


def test_terminology_editor_non_destructive_replacements():
    """Ensure context words ('first', 'factors', 'the', 'retreat') are never deleted and word timings stay synced."""
    editor = TerminologyEditor()
    segments = [
        {
            "start": 0.0,
            "end": 10.0,
            "text": "Entering the first ghana in meditation and reviewing the ghana factors with the bright nimiter on a rains retreat.",
            "words": [
                {"word": w, "start": float(i), "end": float(i) + 0.5}
                for i, w in enumerate(
                    "Entering the first ghana in meditation and reviewing the ghana factors with the bright nimiter on a rains retreat.".split()
                )
            ],
        },
        {
            "start": 10.0,
            "end": 15.0,
            "text": "Recitation of the party mocker by a monk practicing anna panasati.",
            "words": [
                {"word": w, "start": 10.0 + float(i), "end": 10.5 + float(i)}
                for i, w in enumerate("Recitation of the party mocker by a monk practicing anna panasati.".split())
            ],
        },
    ]

    edited, changelog = editor.edit_segments(segments)
    text_0 = edited[0]["text"]
    assert "first jhana" in text_0
    assert "jhana factors" in text_0
    assert "bright nimitta" in text_0
    assert len(edited[0]["words"]) == len(text_0.split())

    text_1 = edited[1]["text"]
    assert "patimokkha" in text_1
    assert "anapanasati" in text_1
    # Multi-word misrecognitions ("party mocker" -> "patimokkha", "anna panasati" -> "anapanasati")
    # must synchronize the word timing array length with the token count
    assert len(edited[1]["words"]) == len(text_1.split())
    assert len(changelog) >= 4


def test_terminology_editor_yoniso_manasikara_and_noble_eightfold_path():
    """Verify Yonis Omanis Ikara -> yoniso manasikara and noble, aidful path -> noble eightfold path."""
    editor = TerminologyEditor()
    segments = [
        {
            "start": 0.0,
            "end": 20.0,
            "text": "And Samparjanya requires Yonis Omanis Ikara, otherwise it doesn't work. The real Visuddhimagga is the noble, aidful path. That is wise attention, not Ayonis Omanesikara.",
            "words": [
                {"word": w, "start": float(i), "end": float(i) + 0.5}
                for i, w in enumerate(
                    "And Samparjanya requires Yonis Omanis Ikara, otherwise it doesn't work. The real Visuddhimagga is the noble, aidful path. That is wise attention, not Ayonis Omanesikara.".split()
                )
            ],
        }
    ]

    edited, changelog = editor.edit_segments(segments)
    text = edited[0]["text"]
    assert "yoniso manasikara" in text
    assert "noble eightfold path" in text
    assert "ayoniso manasikara" in text
    assert "sampajanna" in text
    # Word timing count must remain 1:1 with token count
    assert len(edited[0]["words"]) == len(text.split())
    assert len(changelog) >= 4


def test_format_timestamp_vtt_millisecond_carry_over():
    """Verify VTT timestamps never emit .1000 when fractional seconds round up."""
    assert format_timestamp_vtt(10.9996) == "00:00:11.000"
    assert format_timestamp_vtt(59.9999) == "00:01:00.000"
    assert format_timestamp_vtt(3599.9999) == "01:00:00.000"
    assert format_timestamp_vtt(0.0) == "00:00:00.000"


def test_speaker_aligner_smooth_isolated_turns():
    """Verify isolated short speaker blips surrounded by the same speaker are smoothed while long turns remain."""
    segments = [
        {
            "start": 0.0,
            "end": 60.0,
            "speaker": "ajahn_brahm",
            "speaker_display": "Ajahn Brahm",
            "role": "monastic_primary",
            "text": "Opening talk segment.",
        },
        {
            "start": 60.2,
            "end": 62.5,
            "speaker": "unregistered_speaker",
            "speaker_display": "Unregistered Speaker",
            "role": "guest_or_qa",
            "text": "Short laugh blip.",
        },
        {
            "start": 62.8,
            "end": 120.0,
            "speaker": "ajahn_brahm",
            "speaker_display": "Ajahn Brahm",
            "role": "monastic_primary",
            "text": "Continuation of talk.",
        },
        {
            "start": 120.5,
            "end": 167.0,
            "speaker": "unregistered_speaker",
            "speaker_display": "Unregistered Speaker",
            "role": "guest_or_qa",
            "text": "Sustained 46.5s narrator introduction.",
        },
        {
            "start": 167.5,
            "end": 220.0,
            "speaker": "ajahn_brahm",
            "speaker_display": "Ajahn Brahm",
            "role": "monastic_primary",
            "text": "Main talk resumes.",
        },
    ]

    smoothed = SpeakerAligner._smooth_isolated_turns(segments, max_island_dur=4.0)
    # 2.3s island should be absorbed into ajahn_brahm
    assert smoothed[1]["speaker"] == "ajahn_brahm"
    # 46.5s narrator turn should remain unregistered_speaker
    assert smoothed[3]["speaker"] == "unregistered_speaker"


def test_calculate_token_metrics_sequence_wer():
    """Verify sequence-aligned WER detects word order inversions that bag-of-words misses."""
    metrics_identical = calculate_token_metrics("one two three four", "one two three four")
    assert metrics_identical["wer"] == 0.0
    assert metrics_identical["f1"] == 1.0

    # Reversed word order has bag-of-words overlap = 1.0, but true sequence WER > 0
    metrics_reversed = calculate_token_metrics("one two three four", "four three two one")
    assert metrics_reversed["f1"] == 1.0
    assert metrics_reversed["wer"] > 0.5


def test_voiceprint_legacy_slug_resolution():
    """Ensure legacy 'ajahn_sujato' slug resolves to canonical 'bhante_sujato'."""
    vp_db = VoiceprintDatabase()
    embeddings = vp_db.load_gallery()
    slugs = {e["teacher_slug"] for e in embeddings}
    assert "ajahn_sujato" not in slugs
    assert "bhante_sujato" in slugs
