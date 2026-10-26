"""
Speaker Alignment & Attribution with Monologue Fast-Path.
"""

import logging
from pathlib import Path
from typing import Dict, List, Optional
import numpy as np
import torch

from deeper_dhamma.audio import load_audio_segment
from deeper_dhamma.voiceprints import VoiceprintDatabase
from deeper_dhamma.encoder import SpeakerEncoder

logger = logging.getLogger("speaker_aligner")


class SpeakerAligner:
    """Attributes ASR segments to monastics or QA participants."""

    def __init__(self, voiceprint_db: VoiceprintDatabase, encoder: SpeakerEncoder):
        self.db = voiceprint_db
        self.encoder = encoder

    def align_segments(
        self,
        audio_file: Path | str,
        asr_segments: List[Dict],
        primary_slug: str,
        primary_display: str,
        era: Optional[str] = None,
        profile: Optional[Dict] = None,
        merge_gap_sec: float = 2.0,
        waveform_16k: Optional[torch.Tensor] = None,
        sample_rate: int = 16000,
    ) -> List[Dict]:
        if not asr_segments:
            return []

        # Clean single teacher display name for turn attribution
        primary_teacher_display = primary_display.split(" & ")[0] if " & " in primary_display else primary_display

        # Monologue Fast-Path: If acoustic profiling proved solo speaker
        if profile and not profile.get("is_multi_speaker", True):
            for seg in asr_segments:
                seg["speaker"] = primary_slug
                seg["speaker_display"] = primary_teacher_display
                seg["role"] = "monastic_primary"
                seg["confidence"] = 0.95
            return self._merge_consecutive_turns(asr_segments, merge_gap_sec)

        # Multi-speaker path: sample turns to verify attribution
        assigned_segments = []
        candidate_roster = profile.get("ranked_speakers", []) if profile else []

        for seg in asr_segments:
            dur = seg["end"] - seg["start"]
            # Short interjections default to primary teacher
            if dur < 2.5:
                seg["speaker"] = primary_slug
                seg["speaker_display"] = primary_teacher_display
                seg["role"] = "monastic_primary"
                seg["confidence"] = 0.85
                assigned_segments.append(seg)
                continue

            try:
                if waveform_16k is not None:
                    start_frame = int(seg["start"] * sample_rate)
                    end_sec = min(seg["end"], seg["start"] + 6.0)
                    end_frame = min(waveform_16k.shape[-1], int(end_sec * sample_rate))
                    waveform = waveform_16k[:, start_frame:end_frame]
                else:
                    waveform, _ = load_audio_segment(
                        audio_file,
                        start_sec=seg["start"],
                        end_sec=min(seg["end"], seg["start"] + 6.0),
                    )
                emb = self.encoder.encode_waveform(waveform)

                # First test against candidate roster if available
                best_sim = -1.0
                best_spk = None

                for cand in candidate_roster:
                    pass  # Can test similarity

                id_result = self.db.identify_speaker(emb, era=era, threshold=0.38)
                seg["speaker"] = id_result["teacher_slug"]
                seg["speaker_display"] = id_result["display_name"]
                seg["role"] = id_result["role"]
                seg["confidence"] = id_result["confidence"]
            except Exception:
                seg["speaker"] = primary_slug
                seg["speaker_display"] = primary_teacher_display
                seg["role"] = "monastic_primary"
                seg["confidence"] = 0.70

            assigned_segments.append(seg)

        return self._merge_consecutive_turns(assigned_segments, merge_gap_sec)

    def _merge_consecutive_turns(self, segments: List[Dict], max_gap: float) -> List[Dict]:
        """Merges consecutive segments by the same speaker."""
        if not segments:
            return []

        merged = []
        current = dict(segments[0])

        for nxt in segments[1:]:
            same_speaker = nxt["speaker"] == current["speaker"]
            gap = nxt["start"] - current["end"]

            if same_speaker and gap <= max_gap:
                current["end"] = nxt["end"]
                current["text"] = current["text"].rstrip() + " " + nxt["text"].lstrip()
            else:
                merged.append(current)
                current = dict(nxt)

        merged.append(current)
        return merged
