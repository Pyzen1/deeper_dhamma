"""
faster-whisper Large-v3 Speech-to-Text Transcriber with Pali Conditioning.
"""

import logging
from typing import Dict, List, Optional
import numpy as np
from faster_whisper import WhisperModel

import deeper_dhamma.config  # Enforces HF_HOME and DLL paths

logger = logging.getLogger("transcription")

PALI_PROMPT = (
    "Ajahn Brahm, Ajahn Brahmali, Bodhinyana Monastery, Dhammaloka, Dhammasara, "
    "Rains Retreat, Vassa, jhana, samadhi, anapanasati, patimokkha, sila, panna, "
    "anatta, anicca, dukkha, paticcasamuppada, nimitta, kamma, vipassana, samatha, "
    "bhavana, sangha, bhikkhu, bhikkhuni, dhamma, buddha, ariyasacca."
)


class Transcriber:
    """Wrapper around faster-whisper Large-v3."""

    def __init__(
        self,
        model_size: str = "large-v3",
        device: str = "cuda",
        compute_type: str = "float16",
        initial_prompt: Optional[str] = PALI_PROMPT,
        batch_size: int = 8,
    ):
        self.device = device
        self.compute_type = compute_type
        self.initial_prompt = initial_prompt
        self.batch_size = batch_size

        logger.info(f"Loading faster-whisper '{model_size}' on {device} ({compute_type}, batch_size={batch_size})...")
        self.model = WhisperModel(
            model_size_or_path=model_size,
            device=self.device,
            compute_type=self.compute_type,
        )
        if self.batch_size > 1:
            from faster_whisper import BatchedInferencePipeline
            self.batched_pipeline = BatchedInferencePipeline(model=self.model)
            logger.info("BatchedInferencePipeline active.")
        else:
            self.batched_pipeline = None
        logger.info("Whisper model ready.")

    def transcribe(
        self,
        audio_16k_mono: np.ndarray,
        vad_filter: bool = True,
        word_timestamps: bool = False,
        prompt: Optional[str] = None,
    ) -> List[Dict]:
        """
        Transcribes 16kHz mono float32 numpy audio.
        Returns list of segment dictionaries with start, end, text, and acoustic confidence metrics.
        """
        active_prompt = prompt or self.initial_prompt
        if self.batched_pipeline is not None:
            segments_gen, _ = self.batched_pipeline.transcribe(
                audio_16k_mono,
                batch_size=self.batch_size,
                language="en",
                initial_prompt=active_prompt,
                vad_filter=vad_filter,
                word_timestamps=word_timestamps,
            )
        else:
            segments_gen, _ = self.model.transcribe(
                audio_16k_mono,
                language="en",
                initial_prompt=active_prompt,
                vad_filter=vad_filter,
                vad_parameters=dict(min_silence_duration_ms=500),
                word_timestamps=word_timestamps,
            )

        segments = []
        for s in segments_gen:
            segments.append({
                "start": round(s.start, 3),
                "end": round(s.end, 3),
                "text": s.text.strip(),
                "avg_logprob": round(float(getattr(s, "avg_logprob", 0.0)), 4),
                "no_speech_prob": round(float(getattr(s, "no_speech_prob", 0.0)), 4),
            })

        return segments
