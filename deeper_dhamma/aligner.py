"""
Speaker Alignment, Word-Level Change-Point Diarization & Attribution.
"""

import logging
from pathlib import Path
from typing import Dict, List, Optional, Tuple
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

    @staticmethod
    def _reconstruct_text_from_words(words: List[Dict]) -> str:
        """
        Reconstructs text from word tokens preserving leading spaces and punctuation adhesion
        without injecting spurious spaces before periods, hyphens, or commas.
        """
        parts = []
        for w in words:
            raw = w.get("word", "")
            if not parts:
                parts.append(raw.lstrip())
            elif raw.startswith(" ") or raw.startswith((".", ",", "!", "?", ":", ";", "-", "’", "'")):
                parts.append(raw)
            elif parts[-1].endswith(" "):
                parts.append(raw)
            else:
                parts.append(" " + raw)
        return "".join(parts).strip()

    def refine_turns_by_word_boundaries(
        self,
        audio_file: Path | str,
        asr_segments: List[Dict],
        era: Optional[str] = None,
        waveform_16k: Optional[torch.Tensor] = None,
        sample_rate: int = 16000,
        min_pause_gap: float = 0.45,
        _slice_cache: Optional[Dict[Tuple[int, int], np.ndarray]] = None,
    ) -> List[Dict]:
        """
        Splits merged ASR segments at conversational pauses where bilateral acoustic
        divergence indicates a genuine speaker change-point.
        """
        refined_segments = []
        slice_cache: Dict[Tuple[int, int], np.ndarray] = _slice_cache if _slice_cache is not None else {}
        use_batch = (
            waveform_16k is not None
            and type(self.encoder).__name__ == "SpeakerEncoder"
            and hasattr(self.encoder, "encode_waveforms_batch")
        )

        if use_batch and waveform_16k is not None:
            total_frames = waveform_16k.shape[-1]
            cand_keys: List[Tuple[int, int]] = []
            cand_seen = set(slice_cache.keys())
            for seg in asr_segments:
                words = seg.get("words", [])
                if len(words) < 2:
                    continue
                for i in range(len(words) - 1):
                    if (words[i + 1]["start"] - words[i]["end"]) < min_pause_gap:
                        continue
                    left_st = words[0]["start"]
                    left_en = words[i]["end"]
                    right_st = words[i + 1]["start"]
                    right_en = min(words[-1]["end"], right_st + 5.0)
                    if (left_en - left_st) < 1.5 or (right_en - right_st) < 1.5:
                        continue
                    k_l = (max(0, int(left_st * sample_rate)), min(total_frames, int(min(left_en, left_st + 6.0) * sample_rate)))
                    k_r = (max(0, int(right_st * sample_rate)), min(total_frames, int(right_en * sample_rate)))
                    for k in (k_l, k_r):
                        if k not in cand_seen and k[1] > k[0]:
                            cand_seen.add(k)
                            cand_keys.append(k)
            if cand_keys:
                cand_wavs = [waveform_16k[:, st_f:en_f] for st_f, en_f in cand_keys]
                for k, emb in zip(cand_keys, self.encoder.encode_waveforms_batch(cand_wavs)):
                    slice_cache[k] = emb

        def get_slice_emb(st: float, en: float) -> np.ndarray:
            if waveform_16k is not None:
                start_f = max(0, int(st * sample_rate))
                end_f = min(waveform_16k.shape[-1], int(en * sample_rate))
                key = (start_f, end_f)
                cached = slice_cache.get(key)
                if cached is not None:
                    return cached
                emb = self.encoder.encode_waveform(waveform_16k[:, start_f:end_f])
                slice_cache[key] = emb
                return emb
            w, _ = load_audio_segment(audio_file, start_sec=st, end_sec=en)
            return self.encoder.encode_waveform(w)

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
                if dur_l < 1.5 or dur_r < 1.5:
                    continue

                try:
                    emb_l = get_slice_emb(left_st, min(left_en, left_st + 6.0))
                    emb_r = get_slice_emb(right_st, right_en)

                    id_l = self.db.identify_speaker(emb_l, era=era, threshold=0.42)
                    id_r = self.db.identify_speaker(emb_r, era=era, threshold=0.42)

                    sim = float(np.dot(emb_l / np.linalg.norm(emb_l), emb_r / np.linalg.norm(emb_r)))
                    delta = 1.0 - sim

                    both_known_different = (
                        id_l["identified"]
                        and id_r["identified"]
                        and id_l["teacher_slug"] != id_r["teacher_slug"]
                        and id_l["confidence"] >= 0.44
                        and id_r["confidence"] >= 0.44
                    )
                    strong_acoustic_break = (dur_l >= 2.0 and dur_r >= 2.0 and delta >= 0.60)

                    is_change = both_known_different or strong_acoustic_break

                    if is_change:
                        sub_text = self._reconstruct_text_from_words(left_words)
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

            if turn_start_idx == 0:
                # Segment was never split: preserve pristine original text from Whisper
                refined_segments.append(seg)
            else:
                rem_words = words[turn_start_idx:]
                if rem_words:
                    sub_text = self._reconstruct_text_from_words(rem_words)
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
        slice_cache: Dict[Tuple[int, int], np.ndarray] = {}

        # 1. Word-level conversational pause refinement & change-point detection
        asr_segments = self.refine_turns_by_word_boundaries(
            audio_file=audio_file,
            asr_segments=asr_segments,
            era=era,
            waveform_16k=waveform_16k,
            sample_rate=sample_rate,
            _slice_cache=slice_cache,
        )

        # Pre-batch turn slice embeddings on GPU when in-memory waveform is available
        if (
            waveform_16k is not None
            and type(self.encoder).__name__ == "SpeakerEncoder"
            and hasattr(self.encoder, "encode_waveforms_batch")
        ):
            total_frames = waveform_16k.shape[-1]
            pending_keys: List[Tuple[int, int]] = []
            seen_keys = set(slice_cache.keys())
            for seg in asr_segments:
                if (seg["end"] - seg["start"]) < 1.20:
                    continue
                st_f = int(seg["start"] * sample_rate)
                en_f = min(total_frames, int(min(seg["end"], seg["start"] + 8.0) * sample_rate))
                key = (st_f, en_f)
                if key not in seen_keys and en_f > st_f:
                    seen_keys.add(key)
                    pending_keys.append(key)
            if pending_keys:
                pending_wavs = [waveform_16k[:, st_f:en_f] for st_f, en_f in pending_keys]
                for key, emb in zip(pending_keys, self.encoder.encode_waveforms_batch(pending_wavs)):
                    slice_cache[key] = emb

        # 2. Turn-level acoustic evaluation & identity attribution
        assigned_segments = []
        candidate_roster = profile.get("ranked_speakers", []) if profile else []
        active_candidate_slugs = {
            c["slug"]
            for c in candidate_roster
            if not c["slug"].startswith("unregistered") and (c.get("share", 0) >= 0.05 or c.get("confidence", 0) >= 0.46)
        }
        if candidate_monastics:
            active_candidate_slugs.update(candidate_monastics)
        if primary_slug and primary_slug != "unknown_teacher":
            active_candidate_slugs.add(primary_slug)

        # Map candidate slugs to display names
        slug_to_display = {primary_slug: primary_teacher_display}
        for c in candidate_roster:
            if c.get("slug") and c.get("display_name"):
                slug_to_display[c["slug"]] = c["display_name"]

        is_multi_speaker = bool(profile.get("is_multi_speaker", False)) if profile else (len(active_candidate_slugs) > 1)
        lower_fname = str(audio_file).lower()
        has_qa_indicator = any(k in lower_fname for k in ("_q_a", "q&a", "_qa_", "question"))

        current_speaker = primary_slug
        current_display = primary_teacher_display

        for seg in asr_segments:
            dur = seg["end"] - seg["start"]
            # Utterances under 1.2s lack sufficient phonetic span for reliable ECAPA speaker switches
            if dur < 1.20:
                seg["speaker"] = current_speaker
                seg["speaker_display"] = current_display
                seg["role"] = "guest_or_qa" if current_speaker.startswith("unregistered") else "monastic_primary"
                seg["confidence"] = 0.85
                assigned_segments.append(seg)
                continue

            try:
                if waveform_16k is not None:
                    start_frame = int(seg["start"] * sample_rate)
                    end_sec = min(seg["end"], seg["start"] + 8.0)
                    end_frame = min(waveform_16k.shape[-1], int(end_sec * sample_rate))
                    key = (start_frame, end_frame)
                    emb = slice_cache.get(key)
                    if emb is None:
                        emb = self.encoder.encode_waveform(waveform_16k[:, start_frame:end_frame])
                        slice_cache[key] = emb
                else:
                    waveform, _ = load_audio_segment(
                        audio_file,
                        start_sec=seg["start"],
                        end_sec=min(seg["end"], seg["start"] + 8.0),
                    )
                    emb = self.encoder.encode_waveform(waveform)

                id_result = self.db.identify_speaker(emb, era=era, threshold=0.38)
                new_slug = id_result["teacher_slug"]
                new_display = id_result["display_name"]
                new_conf = id_result["confidence"]

                seg_scores: Dict[str, float] = {}

                def _score(slug: str) -> float:
                    if slug not in seg_scores:
                        seg_scores[slug] = self.db.score_speaker(emb, slug, era=era)
                    return seg_scores[slug]

                # Measure direct acoustic agreement with the active and primary speakers
                active_sim = (
                    _score(current_speaker)
                    if not current_speaker.startswith("unregistered")
                    else 0.0
                )
                primary_sim = (
                    _score(primary_slug)
                    if primary_slug and primary_slug != "unknown_teacher"
                    else 0.0
                )
                best_candidate_sim = max([active_sim, primary_sim] + [
                    _score(c_slug) for c_slug in active_candidate_slugs
                ])

                # Reject un-profiled third-party monastics unless match is strongly discriminative (>= 0.52)
                if active_candidate_slugs and new_slug not in active_candidate_slugs and not new_slug.startswith("unregistered"):
                    if new_conf < 0.52 or dur < 3.0 or (new_conf - best_candidate_sim) < 0.12:
                        if best_candidate_sim >= 0.28 or (not is_multi_speaker and not has_qa_indicator):
                            # Assign to best matching candidate monastic
                            best_cand = max(
                                active_candidate_slugs,
                                key=_score,
                            )
                            new_slug = best_cand
                            new_display = slug_to_display.get(best_cand, best_cand.replace("_", " ").title())
                            new_conf = _score(best_cand)
                        else:
                            new_slug = "unregistered_speaker"
                            new_display = "Unregistered Speaker"

                # Recover candidate monastic when returning from an unregistered segment with moderate similarity
                if new_slug.startswith("unregistered") and active_candidate_slugs:
                    recovery_thresh = 0.22 if (not is_multi_speaker and not has_qa_indicator and len(active_candidate_slugs) <= 1) else 0.33
                    if best_candidate_sim >= recovery_thresh and current_speaker.startswith("unregistered"):
                        best_cand = max(
                            active_candidate_slugs,
                            key=_score,
                        )
                        new_slug = best_cand
                        new_display = slug_to_display.get(best_cand, best_cand.replace("_", " ").title())
                        new_conf = best_candidate_sim

                # Hysteresis & role-appropriate speaker transition rules
                if new_slug != current_speaker:
                    if new_slug.startswith("unregistered"):
                        if not is_multi_speaker and not has_qa_indicator and len(active_candidate_slugs) <= 1:
                            # Solo talk: only switch to unregistered_speaker on sustained non-teacher segments
                            # (e.g. a 45s tape narrator intro) where similarity to the primary speaker is very low
                            if dur >= 6.0 and best_candidate_sim < 0.20:
                                current_speaker = new_slug
                                current_display = new_display
                            else:
                                new_slug = current_speaker
                                new_display = current_display
                        else:
                            # Multi-speaker or Q&A talk: switch to unregistered questioner when similarity to
                            # known candidate monastics drops clearly below conversational baseline
                            if (dur >= 1.8 and best_candidate_sim < 0.30) or (dur >= 1.2 and best_candidate_sim < 0.22):
                                current_speaker = new_slug
                                current_display = new_display
                            else:
                                new_slug = current_speaker
                                new_display = current_display
                    else:
                        # Candidate monastics require >= 0.40 (or >= 0.22/0.33 when returning from unregistered_speaker)
                        monastic_thresh = (
                            (0.22 if (not is_multi_speaker and not has_qa_indicator and len(active_candidate_slugs) <= 1) else 0.33)
                            if current_speaker.startswith("unregistered") and new_slug in active_candidate_slugs
                            else (0.40 if new_slug in active_candidate_slugs else 0.52)
                        )
                        if new_conf >= monastic_thresh and (new_conf >= active_sim + 0.02 or current_speaker.startswith("unregistered")):
                            current_speaker = new_slug
                            current_display = new_display
                            slug_to_display[new_slug] = new_display
                        else:
                            new_slug = current_speaker
                            new_display = current_display

                seg["speaker"] = new_slug
                seg["speaker_display"] = new_display
                seg["role"] = "guest_or_qa" if new_slug.startswith("unregistered") else id_result["role"]
                seg["confidence"] = new_conf
            except Exception:
                seg["speaker"] = current_speaker
                seg["speaker_display"] = current_display
                seg["role"] = "monastic_primary"
                seg["confidence"] = 0.70

            assigned_segments.append(seg)

        smoothed = self._smooth_isolated_turns(assigned_segments, max_island_dur=4.0)
        return self._merge_consecutive_turns(smoothed, merge_gap_sec)

    @staticmethod
    def _smooth_isolated_turns(segments: List[Dict], max_island_dur: float = 4.0) -> List[Dict]:
        """
        Absorbs isolated single-turn `unregistered_speaker` islands shorter than
        `max_island_dur` when immediately flanked by the same monastic speaker.
        """
        if len(segments) < 3:
            return segments

        out = [dict(s) for s in segments]
        for i in range(1, len(out) - 1):
            cur = out[i]
            prev_s = out[i - 1]
            next_s = out[i + 1]
            dur = cur["end"] - cur["start"]
            if (
                cur["speaker"].startswith("unregistered")
                and dur <= max_island_dur
                and prev_s["speaker"] == next_s["speaker"]
                and not prev_s["speaker"].startswith("unregistered")
            ):
                cur["speaker"] = prev_s["speaker"]
                cur["speaker_display"] = prev_s["speaker_display"]
                cur["role"] = prev_s.get("role", "monastic_primary")
        return out

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
