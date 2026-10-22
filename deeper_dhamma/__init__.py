"""
BSWA Deeper Dhamma: AI Speech Transcription, Diarization & Search Suite.
"""

from deeper_dhamma.config import (
    ARCHIVE_DIR,
    CATALOG_PATH,
    TRANSCRIPTS_DB_PATH,
    VOICEPRINTS_DB_PATH,
    BUDDHISM_LEXICON_DB_PATH,
    LEXICON_DB_PATH,
)
from deeper_dhamma.pipeline import TranscriptionPipeline
from deeper_dhamma.storage import TranscriptDatabase
from deeper_dhamma.voiceprints import VoiceprintDatabase
from deeper_dhamma.encoder import SpeakerEncoder
from deeper_dhamma.asr import Transcriber
from deeper_dhamma.lexicon import BuddhismLexiconDatabase
from deeper_dhamma.terminology import TerminologyEditor
from deeper_dhamma.catalog import determine_era, identify_primary_teacher, KNOWN_TEACHERS

__version__ = "1.0.0"

__all__ = [
    "TranscriptionPipeline",
    "TranscriptDatabase",
    "VoiceprintDatabase",
    "SpeakerEncoder",
    "Transcriber",
    "TerminologyEditor",
    "BuddhismLexiconDatabase",
    "determine_era",
    "identify_primary_teacher",
    "KNOWN_TEACHERS",
    "ARCHIVE_DIR",
    "CATALOG_PATH",
    "TRANSCRIPTS_DB_PATH",
    "VOICEPRINTS_DB_PATH",
    "BUDDHISM_LEXICON_DB_PATH",
    "LEXICON_DB_PATH",
]
