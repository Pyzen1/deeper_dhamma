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
        batch_size: int = 16,
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
        word_timestamps: bool = True,
        prompt: Optional[str] = None,
        hotwords: Optional[str] = None,
        hallucination_silence_threshold: Optional[float] = 2.0,
        condition_on_previous_text: bool = False,
    ) -> List[Dict]:
        """
        Transcribes 16kHz mono float32 numpy audio.
        Returns list of segment dictionaries with start, end, text, and acoustic confidence metrics.
        """
        active_prompt = prompt or self.initial_prompt
        vad_params = dict(
            threshold=0.30,
            min_speech_duration_ms=100,
            min_silence_duration_ms=500,
            speech_pad_ms=400,
        )
        if self.batched_pipeline is not None and vad_filter:
            segments_gen, _ = self.batched_pipeline.transcribe(
                audio_16k_mono,
                batch_size=self.batch_size,
                language="en",
                initial_prompt=active_prompt,
                hotwords=hotwords,
                vad_filter=vad_filter,
                vad_parameters=vad_params,
                word_timestamps=word_timestamps,
                hallucination_silence_threshold=hallucination_silence_threshold,
                condition_on_previous_text=condition_on_previous_text,
            )
        else:
            segments_gen, _ = self.model.transcribe(
                audio_16k_mono,
                language="en",
                initial_prompt=active_prompt,
                hotwords=hotwords,
                vad_filter=vad_filter,
                vad_parameters=vad_params,
                word_timestamps=word_timestamps,
                hallucination_silence_threshold=hallucination_silence_threshold,
                condition_on_previous_text=condition_on_previous_text,
            )

        segments = []
        for s in segments_gen:
            words = []
            if getattr(s, "words", None):
                for w in s.words:
                    words.append({
                        "word": w.word,
                        "start": round(w.start, 3),
                        "end": round(w.end, 3),
                        "prob": round(float(getattr(w, "probability", 1.0)), 3),
                    })
            segments.append({
                "start": round(s.start, 3),
                "end": round(s.end, 3),
                "text": s.text.strip(),
                "avg_logprob": round(float(getattr(s, "avg_logprob", 0.0)), 4),
                "no_speech_prob": round(float(getattr(s, "no_speech_prob", 0.0)), 4),
                "words": words,
            })

        return segments
