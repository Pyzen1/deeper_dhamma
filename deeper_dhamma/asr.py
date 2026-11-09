"""
faster-whisper Large-v3 Speech-to-Text Transcriber with Pali Conditioning.
"""

import deeper_dhamma.config  # Enforces HF_HOME and DLL paths under C:\ai-models
import logging
import shutil
import sys
import time
from typing import Any, Callable, Dict, List, Optional
import numpy as np
from faster_whisper import WhisperModel

logger = logging.getLogger("transcription")

PALI_PROMPT = (
    "Ajahn Brahm, Ajahn Brahmali, Bodhinyana Monastery, Dhammaloka, Dhammasara, "
    "Rains Retreat, Vassa, jhana, samadhi, anapanasati, patimokkha, sila, panna, "
    "anatta, anicca, dukkha, paticcasamuppada, nimitta, kamma, vipassana, samatha, "
    "bhavana, sangha, bhikkhu, bhikkhuni, dhamma, buddha, ariyasacca."
)


class TranscriptionProgressBar:
    """
    Live updating CLI progress bar for faster-whisper speech transcription.
    Renders percentage, audio time elapsed/total, real-time speed factor (RTF),
    ETA, turn count, and live recognized speech snippet.
    """

    def __init__(
        self,
        total_sec: float,
        desc: str = "Transcribing",
        file: Optional[Any] = None,
    ):
        self.total_sec = max(0.1, float(total_sec))
        self.desc = desc
        self.file = file or sys.stdout
        self.is_tty = hasattr(self.file, "isatty") and self.file.isatty()
        self.start_time = time.time()
        self.last_update_time = 0.0
        self.last_log_sec = 0.0
        self.current_sec = 0.0
        self.turn_count = 0
        self.last_text = ""
        self.closed = False

    @staticmethod
    def _format_time(seconds: float, compact: bool = False) -> str:
        hrs = int(seconds // 3600)
        mins = int((seconds % 3600) // 60)
        secs = int(seconds % 60)
        if compact:
            if hrs > 0:
                return f"{hrs}h{mins:02d}m"
            return f"{mins:02d}:{secs:02d}"
        if hrs > 0:
            return f"{hrs:02d}:{mins:02d}:{secs:02d}"
        return f"{mins:02d}:{secs:02d}"

    def update(self, current_sec: float, text: str = ""):
        if self.closed:
            return
        self.current_sec = min(self.total_sec, max(self.current_sec, float(current_sec)))
        self.turn_count += 1
        if text:
            self.last_text = text.strip()

        now = time.time()
        if self.is_tty:
            # Throttle terminal updates to ~15 Hz unless completed
            if (now - self.last_update_time < 0.07) and (self.current_sec < self.total_sec):
                return
            self.last_update_time = now
            self._render_tty()
        else:
            milestone = max(1.0, min(30.0, self.total_sec * 0.10))
            if (self.current_sec - self.last_log_sec >= milestone) or (self.current_sec >= self.total_sec):
                self.last_log_sec = self.current_sec
                self._render_log()

    def _render_tty(self):
        cols = shutil.get_terminal_size((100, 24)).columns
        pct = min(100.0, (self.current_sec / self.total_sec) * 100.0)
        elapsed = max(0.001, time.time() - self.start_time)
        rtf = self.current_sec / elapsed if elapsed > 0.05 else 0.0
        rem_sec = max(0.0, self.total_sec - self.current_sec)
        eta_sec = rem_sec / rtf if rtf > 0.05 else 0.0

        if cols < 85:
            bar_w = 10
            filled = int(round((pct / 100.0) * bar_w))
            bar = "=" * filled + "." * (bar_w - filled)
            cur_s = self._format_time(self.current_sec, compact=True)
            tot_s = self._format_time(self.total_sec, compact=True)
            eta_s = self._format_time(eta_sec, compact=True)
            line = f"   -> {self.desc}: [{bar}] {pct:3.0f}% | {cur_s}/{tot_s} | {rtf:.0f}x | ETA {eta_s}"
        elif cols < 105:
            bar_w = 14
            filled = int(round((pct / 100.0) * bar_w))
            bar = "=" * filled + "." * (bar_w - filled)
            cur_s = self._format_time(self.current_sec)
            tot_s = self._format_time(self.total_sec)
            eta_s = self._format_time(eta_sec)
            line = f"   -> {self.desc}: [{bar}] {pct:5.1f}% | {cur_s}/{tot_s} | {rtf:4.1f}x RT | ETA: {eta_s}"
        elif cols < 125:
            bar_w = 16
            filled = int(round((pct / 100.0) * bar_w))
            bar = "=" * filled + "." * (bar_w - filled)
            cur_s = self._format_time(self.current_sec)
            tot_s = self._format_time(self.total_sec)
            eta_s = self._format_time(eta_sec)
            line = f"   -> {self.desc}: [{bar}] {pct:5.1f}% | {cur_s}/{tot_s} | {rtf:4.1f}x RT | ETA: {eta_s} | {self.turn_count} turns"
        else:
            bar_w = 20
            filled = int(round((pct / 100.0) * bar_w))
            bar = "=" * filled + "." * (bar_w - filled)
            cur_s = self._format_time(self.current_sec)
            tot_s = self._format_time(self.total_sec)
            eta_s = self._format_time(eta_sec)
            line = f"   -> {self.desc}: [{bar}] {pct:5.1f}% | {cur_s}/{tot_s} | {rtf:4.1f}x RT | ETA: {eta_s} | {self.turn_count} turns"
            avail = cols - len(line) - 6
            if avail >= 10 and self.last_text:
                clean_snip = " ".join(self.last_text.strip().split())[:avail]
                line += f" | \"{clean_snip}\""

        clean_line = f"\r{line[:cols - 1].ljust(cols - 1)}"
        self.file.write(clean_line)
        self.file.flush()

    def _render_log(self):
        pct = min(100.0, (self.current_sec / self.total_sec) * 100.0)
        elapsed = max(0.001, time.time() - self.start_time)
        rtf = self.current_sec / elapsed if elapsed > 0.05 else 0.0
        rem_sec = max(0.0, self.total_sec - self.current_sec)
        eta_sec = rem_sec / rtf if rtf > 0.05 else 0.0
        cur_s = self._format_time(self.current_sec)
        tot_s = self._format_time(self.total_sec)
        eta_s = self._format_time(eta_sec)
        line = f"   -> {self.desc}: {pct:5.1f}% | {cur_s}/{tot_s} | {rtf:4.1f}x RT | ETA: {eta_s} | {self.turn_count} turns\n"
        self.file.write(line)
        self.file.flush()

    def close(self):
        if self.closed:
            return
        self.closed = True
        elapsed = max(0.001, time.time() - self.start_time)
        rtf = self.total_sec / elapsed
        tot_s = self._format_time(self.total_sec)
        elp_s = self._format_time(elapsed)

        cols = shutil.get_terminal_size((100, 24)).columns
        bar_w = 20 if cols >= 110 else 14
        bar = "=" * bar_w
        if self.is_tty:
            summary = f"\r   [✓] {self.desc}: [{bar}] 100.0% | {tot_s} in {elp_s} ({rtf:.1f}x RT) | {self.turn_count} turns"
            self.file.write(summary[:cols - 1].ljust(cols - 1) + "\n")
        else:
            summary = f"   [✓] {self.desc}: 100.0% | {tot_s} in {elp_s} ({rtf:.1f}x RT) | {self.turn_count} turns\n"
            self.file.write(summary)
        self.file.flush()

    def __enter__(self):
        if self.is_tty:
            self._render_tty()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()


class Transcriber:
    """
    Wrapper around faster-whisper Large-v3.
    Prioritizes data quality and speech completeness over raw speed by defaulting
    to sequential inference (batch_size=1) with contemplative Silero VAD settings.
    """

    def __init__(
        self,
        model_size: str = "large-v3",
        device: str = "cuda",
        compute_type: str = "float16",
        initial_prompt: Optional[str] = PALI_PROMPT,
        batch_size: int = 1,
        local_files_only: bool = True,
    ):
        self.device = device
        self.compute_type = compute_type
        self.initial_prompt = initial_prompt
        self.batch_size = batch_size

        if not local_files_only:
            logger.info(f"Checking Hugging Face Hub for faster-whisper '{model_size}' updates...")
            self.model = WhisperModel(
                model_size_or_path=model_size,
                device=self.device,
                compute_type=self.compute_type,
                local_files_only=False,
            )
        else:
            logger.info(f"Loading faster-whisper '{model_size}' on {device} ({compute_type}, batch_size={batch_size})...")
            # Local-first load to avoid unnecessary online Hugging Face validation pings
            try:
                self.model = WhisperModel(
                    model_size_or_path=model_size,
                    device=self.device,
                    compute_type=self.compute_type,
                    local_files_only=True,
                )
            except Exception:
                # Fall back to downloading/resolving if model is not yet cached locally
                logger.info(f"Model '{model_size}' not found locally. Fetching from Hugging Face Hub...")
                self.model = WhisperModel(
                    model_size_or_path=model_size,
                    device=self.device,
                    compute_type=self.compute_type,
                    local_files_only=False,
                )
        if self.batch_size > 1:
            from faster_whisper import BatchedInferencePipeline
            self.batched_pipeline = BatchedInferencePipeline(model=self.model)
            logger.info("BatchedInferencePipeline active (note: batched mode may drop quiet segments near boundaries).")
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
        show_progress: bool = True,
        progress_callback: Optional[Callable[[float, float, str], None]] = None,
    ) -> List[Dict]:
        """
        Transcribes 16kHz mono float32 numpy audio.
        Returns list of segment dictionaries with start, end, text, and acoustic confidence metrics.
        Displays an in-place live updating progress bar unless show_progress=False.
        """
        active_prompt = prompt or self.initial_prompt
        vad_params = dict(
            threshold=0.20,
            min_speech_duration_ms=100,
            min_silence_duration_ms=800,
            speech_pad_ms=600,
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

        total_dur_sec = float(len(audio_16k_mono)) / 16000.0 if len(audio_16k_mono) > 0 else 0.1
        pbar = None
        if show_progress:
            pbar = TranscriptionProgressBar(total_sec=total_dur_sec, desc="Transcribing")
            pbar.__enter__()

        segments = []
        try:
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
                clean_text = s.text.strip()
                segments.append({
                    "start": round(s.start, 3),
                    "end": round(s.end, 3),
                    "text": clean_text,
                    "avg_logprob": round(float(getattr(s, "avg_logprob", 0.0)), 4),
                    "no_speech_prob": round(float(getattr(s, "no_speech_prob", 0.0)), 4),
                    "words": words,
                })
                if pbar is not None:
                    pbar.update(current_sec=float(s.end), text=clean_text)
                if progress_callback is not None:
                    try:
                        progress_callback(float(s.end), total_dur_sec, clean_text)
                    except Exception:
                        pass
        finally:
            if pbar is not None:
                pbar.close()

        return segments
