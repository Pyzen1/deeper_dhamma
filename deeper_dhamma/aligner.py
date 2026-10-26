"""
Speaker Alignment, Word-Level Change-Point Diarization & Attribution.
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
    """Attributes ASR segments to monastics or QA participants with word-level change-point refinement."""

    def __init__(self, voiceprint_db: VoiceprintDatabase, encoder: SpeakerEncoder):
        self.db = voiceprint_db
        self.encoder = encoder

    def refine_turns_by_word_boundaries(
        self,
        audio_file: Path | str,
        asr_segments: List[Dict],
        era: Optional[str] = None,
        waveform_16k: Optional[torch.Tensor] = None,
        sample_rate: int = 16000,
        min_pause_gap: float = 0.45,
    ) -> List[Dict]:
        """
        Splits merged ASR segments at conversational pauses where bilateral acoustic
        divergence indicates a genuine speaker change-point.
        """
        refined_segments = []

        def get_slice(st: float, en: float) -> torch.Tensor:
            if waveform_16k is not None:
                start_f = max(0, int(st * sample_rate))
                end_f = min(waveform_16k.shape[-1], int(en * sample_rate))
                return waveform_16k[:, start_f:end_f]
            w, _ = load_audio_segment(audio_file, start_sec=st, end_sec=en)
            return w

        for seg in asr_segments:
            words = seg.get("words", [])
            if len(words) < 2:
                refined_segments.append(seg)
                continue

            turn_start_idx = 0
            for i in range(len(words) - 1):
                gap = words[i + 1]["start"] - words[i]["end"]
                if gap < min_pause_gap:
                    continue

                left_words = words[turn_start_idx : i + 1]
                right_words = words[i + 1 :]

                left_st = left_words[0]["start"]
                left_en = left_words[-1]["end"]
                right_st = right_words[0]["start"]
                right_en = min(right_words[-1]["end"], right_st + 5.0)

                dur_l = left_en - left_st
                dur_r = right_en - right_st
                if dur_l < 0.35 and gap < 0.80:
                    continue

                try:
                    w_l = get_slice(left_st, min(left_en, left_st + 5.0))
                    w_r = get_slice(right_st, right_en)

                    emb_l = self.encoder.encode_waveform(w_l)
                    emb_r = self.encoder.encode_waveform(w_r)

                    id_l = self.db.identify_speaker(emb_l, era=era, threshold=0.40)
                    id_r = self.db.identify_speaker(emb_r, era=era, threshold=0.40)

                    sim = float(np.dot(emb_l / np.linalg.norm(emb_l), emb_r / np.linalg.norm(emb_r)))
                    delta = 1.0 - sim

                    is_left_indep = (dur_l >= 1.2) or (id_l["confidence"] >= 0.45)
                    is_right_indep = (dur_r >= 1.2) or (id_r["confidence"] >= 0.45)

                    is_change = False
                    if id_l["teacher_slug"] != id_r["teacher_slug"] and is_left_indep and is_right_indep:
                        is_change = True
                    elif delta >= 0.55 and is_left_indep and is_right_indep:
                        is_change = True

                    if is_change:
                        sub_text = " ".join(w["word"].strip() for w in left_words)
                        refined_segments.append({
                            "start": left_st,
                            "end": left_en,
                            "text": sub_text,
                            "words": left_words,
                            "avg_logprob": seg.get("avg_logprob", 0.0),
                            "no_speech_prob": seg.get("no_speech_prob", 0.0),
                        })
                        turn_start_idx = i + 1
                except Exception as e:
                    logger.debug(f"Bilateral pause refinement skip at t={left_en}: {e}")

            rem_words = words[turn_start_idx:]
            if rem_words:
                sub_text = " ".join(w["word"].strip() for w in rem_words)
                refined_segments.append({
                    "start": rem_words[0]["start"],
                    "end": rem_words[-1]["end"],
                    "text": sub_text,
                    "words": rem_words,
                    "avg_logprob": seg.get("avg_logprob", 0.0),
                    "no_speech_prob": seg.get("no_speech_prob", 0.0),
                })

        return refined_segments

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
        candidate_monastics: Optional[List[str]] = None,
    ) -> List[Dict]:
        if not asr_segments:
            return []

        # Clean single teacher display name for turn attribution
        primary_teacher_display = primary_display.split(" & ")[0] if " & " in primary_display else primary_display

        # 1. Word-level conversational pause refinement & change-point detection
        asr_segments = self.refine_turns_by_word_boundaries(
            audio_file=audio_file,
            asr_segments=asr_segments,
            era=era,
            waveform_16k=waveform_16k,
            sample_rate=sample_rate,
        )

        # 2. Turn-level acoustic evaluation & identity attribution
        assigned_segments = []
        candidate_roster = profile.get("ranked_speakers", []) if profile else []
        active_candidate_slugs = {c["slug"] for c in candidate_roster if not c["slug"].startswith("unregistered")}
        if candidate_monastics:
            active_candidate_slugs.update(candidate_monastics)

        current_speaker = primary_slug
        current_display = primary_teacher_display

        for seg in asr_segments:
            dur = seg["end"] - seg["start"]
            # Utterances under 0.35s (isolated non-speech or breath clicks) inherit active speaker
            if dur < 0.35:
                seg["speaker"] = current_speaker
                seg["speaker_display"] = current_display
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

                id_result = self.db.identify_speaker(emb, era=era, threshold=0.38)
                new_slug = id_result["teacher_slug"]
                new_display = id_result["display_name"]
                new_conf = id_result["confidence"]

                # If candidate monastics were established in pre-profiling,
                # reject un-profiled third-party monastics unless voiceprint match is strongly discriminative (>= 0.48)
                if active_candidate_slugs and new_slug not in active_candidate_slugs and not new_slug.startswith("unregistered"):
                    if new_conf < 0.48:
                        new_slug = current_speaker
                        new_display = current_display

                # Hysteresis: switch speaker based on role-appropriate confidence
                if new_slug != current_speaker:
                    if new_slug.startswith("unregistered"):
                        # Unregistered questioner switch allowed if acoustic match to active monastic is low (< 0.40)
                        if new_conf < 0.40:
                            current_speaker = new_slug
                            current_display = new_display
                        else:
                            new_slug = current_speaker
                            new_display = current_display
                    else:
                        # Candidate monastics require >= 0.42, third-party monastics require >= 0.48
                        monastic_thresh = 0.42 if (active_candidate_slugs and new_slug in active_candidate_slugs) else 0.48
                        if new_conf >= monastic_thresh:
                            current_speaker = new_slug
                            current_display = new_display
                        else:
                            new_slug = current_speaker
                            new_display = current_display

                seg["speaker"] = new_slug
                seg["speaker_display"] = new_display
                seg["role"] = id_result["role"]
                seg["confidence"] = new_conf
            except Exception:
                seg["speaker"] = current_speaker
                seg["speaker_display"] = current_display
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
                if "words" in current and "words" in nxt:
                    current["words"] = current["words"] + nxt["words"]
            else:
                merged.append(current)
                current = dict(nxt)

        merged.append(current)
        return merged
