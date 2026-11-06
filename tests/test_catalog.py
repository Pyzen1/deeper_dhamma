"""
Unit tests for Monastic Teacher Catalog, Era Determination, and Episode Metadata Parsing.
"""

from deeper_dhamma.catalog import (
    ERA_ANALOG,
    ERA_EARLY_DIGITAL,
    ERA_HIGH_DEF,
    clean_slug,
    determine_era,
    extract_recording_year,
    extract_year_and_date,
    identify_all_teachers,
    identify_primary_teacher,
    is_english_talk,
    parse_episode_metadata,
    to_ascii_slug,
)


def test_determine_era_boundaries():
    """Verifies acoustic era classifications based on recording year boundaries."""
    assert determine_era(1994) == ERA_ANALOG
    assert determine_era(2003) == ERA_ANALOG
    assert determine_era(2004) == ERA_EARLY_DIGITAL
    assert determine_era(2014) == ERA_EARLY_DIGITAL
    assert determine_era(2015) == ERA_HIGH_DEF
    assert determine_era(2026) == ERA_HIGH_DEF


def test_identify_primary_teacher():
    """Verifies primary teacher recognition from titles and filenames."""
    slug, name = identify_primary_teacher("2026-03-28_sutta_retreat_ajahn_brahmali.mp3")
    assert slug == "ajahn_brahmali"
    assert name == "Ajahn Brahmali"

    # Brahmavamso resolves to Ajahn Brahm
    slug, name = identify_primary_teacher("1997-05-23_jhana_ajahn_brahmavamso.mp3")
    assert slug == "ajahn_brahm"
    assert name == "Ajahn Brahm"

    # Brahm (not ali) resolves to Ajahn Brahm
    slug, name = identify_primary_teacher("Happiness and Peace - Ajahn Brahm")
    assert slug == "ajahn_brahm"

    # Ayya Vayama
    slug, name = identify_primary_teacher("The Four Noble Truths | Ayya Vayama")
    assert slug == "ayya_vayama"
    assert name == "Ayya Vayama"

    # Bhante Sujato
    slug, name = identify_primary_teacher("Early Buddhism Seminar - Bhante Sujato")
    assert slug == "bhante_sujato"
    assert name == "Bhante Sujato"

    # Unknown fallback
    slug, name = identify_primary_teacher("A Chanting Session by Visitors")
    assert slug == "unknown_teacher"
    assert name == "Unknown Teacher"


def test_identify_all_teachers_multi_speaker():
    """Verifies identification and deduplication of multiple teachers in titles."""
    title = "Guided Meditation Q&A - Ajahn Brahmali and Ayya Karunika (with Ajahn Brahmali)"
    teachers = identify_all_teachers(title)
    slugs = [t[0] for t in teachers]
    assert "ajahn_brahmali" in slugs
    assert "ayya_karunika" in slugs
    # Must be deduplicated (Brahmali only once)
    assert len(slugs) == 2


def test_is_english_talk_filter():
    """Verifies language filtering for English talks vs non-English translations."""
    assert is_english_talk("The Four Foundations of Mindfulness | Ajahn Brahm")
    assert is_english_talk("Meditation & Stillness 2026")

    # Non-English detection
    assert not is_english_talk("Meditation Workshop in Thai Language")
    assert not is_english_talk("Dhamma Talk with Sinhalese Translation")
    assert not is_english_talk("Retreat Talk in Sinhala")
    assert not is_english_talk("Introduction to Buddhism (Mandarin)")
    assert not is_english_talk("Chanting in Burmese")
    assert not is_english_talk("คำสอนเรื่องสมาธิ")  # Thai script
    assert not is_english_talk("禪修開示")  # Chinese script


def test_clean_slug_and_pali_normalization():
    """Verifies clean lowercase underscore-separated slug conversion and Pali diacritic stripping."""
    assert clean_slug("ānāpānasati") == "anapanasati"
    assert clean_slug("Jhāna Factors & Samādhi") == "jhana_factors_samadhi"
    assert clean_slug("Paṭiccasamuppāda: Dependent Origination") == "paticcasamuppada_dependent_origination"
    assert clean_slug("Special --- Characters &*! 123") == "special_characters_123"
    assert to_ascii_slug("Mettā Bhāvanā") == "metta_bhavana"


def test_extract_year_and_date_variants():
    """Verifies extraction of true recording date from title across backfilled release patterns."""
    # 1. Full date in title
    yr, d_str = extract_year_and_date("The Five Hindrances | 15 August 2001", "20200815")
    assert yr == "2001"
    assert d_str == "2001-08-15"

    yr, d_str = extract_year_and_date("Mindfulness of Mind - 26th April 2003", "20180426")
    assert yr == "2003"
    assert d_str == "2003-04-26"

    # 2. Month + Year
    yr, d_str = extract_year_and_date("Bodhinyana Retreat - November 2011", "20201101")
    assert yr == "2011"
    assert d_str == "2011-11-01"

    # 3. Year at title start
    yr, d_str = extract_year_and_date("2017 Rains Retreat Day 01", "20170710")
    assert yr == "2017"
    assert d_str == "2017-07-10"

    # 4. Fallback to upload_date
    yr, d_str = extract_year_and_date("Friday Night Talk", "20240510")
    assert yr == "2024"
    assert d_str == "2024-05-10"


def test_parse_episode_metadata_clean_output():
    """Verifies episode metadata parsing into year, series folder, and filename."""
    year, series, stem = parse_episode_metadata(
        "1994 Rains Retreat (01/12) Foundations of Jhana | Ajahn Brahm",
        "19940506",
    )
    assert year == "1994"
    assert "rains_retreat" in series
    assert stem.startswith("1994-05-06_")
    assert "foundations_of_jhana" in stem
