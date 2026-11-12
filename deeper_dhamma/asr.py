"""
faster-whisper Large-v3 Speech-to-Text Transcriber with Pali Conditioning.
"""

import deeper_dhamma.config  # Enforces HF_HOME and DLL paths under C:\ai-models
import logging
import shutil
import sys
import threading
import time
from typing import Any, Callable, Dict, Iterable, List, Optional
import numpy as np
from faster_whisper import WhisperModel

logger = logging.getLogger("transcription")

PALI_PROMPT = (
    "Ajahn Brahm, Ajahn Brahmali, Bodhinyana Monastery, Dhammaloka, Dhammasara, "
    "Rains Retreat, Vassa, jhana, samadhi, anapanasati, patimokkha, sila, panna, "
    "anatta, anicca, dukkha, paticcasamuppada, nimitta, kamma, vipassana, samatha, "
    "bhavana, sangha, bhikkhu, bhikkhuni, dhamma, buddha, ariyasacca."
)

DEFAULT_VAD_PARAMS: Dict[str, Any] = dict(
    threshold=0.20,
    min_speech_duration_ms=100,
    min_silence_duration_ms=800,
    speech_pad_ms=600,
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

    def close(self, completed: Optional[bool] = None):
        if self.closed:
            return
        self.closed = True
        elapsed = max(0.001, time.time() - self.start_time)
        tot_s = self._format_time(self.total_sec)
        elp_s = self._format_time(elapsed)

        # Default to completed=True unless explicitly marked incomplete/interrupted
        if completed is None:
            completed = True

        cols = shutil.get_terminal_size((100, 24)).columns
        bar_w = 20 if cols >= 110 else 14
        if completed:
            bar = "=" * bar_w
            rtf = self.total_sec / elapsed if elapsed > 0.05 else 0.0
            if self.is_tty:
                summary = f"\r   [✓] {self.desc}: [{bar}] 100.0% | {tot_s} in {elp_s} ({rtf:.1f}x RT) | {self.turn_count} turns"
            else:
                summary = f"   [✓] {self.desc}: 100.0% | {tot_s} in {elp_s} ({rtf:.1f}x RT) | {self.turn_count} turns"
        else:
            pct = min(100.0, (self.current_sec / self.total_sec) * 100.0)
            filled = int(round((pct / 100.0) * bar_w))
            bar = "=" * filled + "." * (bar_w - filled)
            cur_s = self._format_time(self.current_sec)
            rtf = self.current_sec / elapsed if elapsed > 0.05 else 0.0
            if self.is_tty:
                summary = f"\r   [-] {self.desc} stopped: [{bar}] {pct:5.1f}% | {cur_s}/{tot_s} ({rtf:.1f}x RT) | {self.turn_count} turns"
            else:
                summary = f"   [-] {self.desc} stopped: {pct:5.1f}% | {cur_s}/{tot_s} ({rtf:.1f}x RT) | {self.turn_count} turns"

        if self.is_tty:
            self.file.write(summary[:cols - 1].ljust(cols - 1) + "\n")
        else:
            self.file.write(summary + "\n")
        self.file.flush()

    def __enter__(self):
        if self.is_tty:
            self._render_tty()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close(completed=(exc_type is None))


class Transcriber:
    """
    Wrapper around faster-whisper Large-v3.
    Prioritizes data quality and speech completeness over raw speed by defaulting
    to sequential inference (batch_size=1) with contemplative Silero VAD settings.
    """

    def __init__(
        self,
        model_size: str = "turbo",
        device: str = "cuda",
        compute_type: str = "float16",
        initial_prompt: Optional[str] = PALI_PROMPT,
        batch_size: int = 1,
        cpu_threads: int = 8,
        local_files_only: bool = True,
    ):
        self.device = device
        self.compute_type = compute_type
        self.initial_prompt = initial_prompt
        self.batch_size = batch_size
        self.cpu_threads = cpu_threads
        self._vad_lock = threading.Lock()

        if not local_files_only:
            logger.info(
                f"Checking Hugging Face Hub for faster-whisper '{model_size}' updates "
                f"(cpu_threads={cpu_threads})..."
            )
            self.model = WhisperModel(
                model_size_or_path=model_size,
                device=self.device,
                compute_type=self.compute_type,
                cpu_threads=self.cpu_threads,
                local_files_only=False,
            )
        else:
            logger.info(
                f"Loading faster-whisper '{model_size}' on {device} "
                f"({compute_type}, batch_size={batch_size}, cpu_threads={cpu_threads})..."
            )
            # Local-first load to avoid unnecessary online Hugging Face validation pings
            try:
                self.model = WhisperModel(
                    model_size_or_path=model_size,
                    device=self.device,
                    compute_type=self.compute_type,
                    cpu_threads=self.cpu_threads,
                    local_files_only=True,
                )
            except Exception:
                # Fall back to downloading/resolving if model is not yet cached locally
                logger.info(f"Model '{model_size}' not found locally. Fetching from Hugging Face Hub...")
                self.model = WhisperModel(
                    model_size_or_path=model_size,
                    device=self.device,
                    compute_type=self.compute_type,
                    cpu_threads=self.cpu_threads,
                    local_files_only=False,
                )
        if self.batch_size > 1:
            from faster_whisper import BatchedInferencePipeline
            self.batched_pipeline = BatchedInferencePipeline(model=self.model)
            logger.info("BatchedInferencePipeline active (note: batched mode may drop quiet segments near boundaries).")
        else:
            self.batched_pipeline = None
        logger.info("Whisper model ready.")

    def prepare_audio(
        self,
        audio_16k_mono: np.ndarray,
        vad_filter: bool = True,
    ) -> Dict[str, Any]:
        """
        Pre-computes CPU-bound Silero VAD speech chunks and 128-bin log-Mel spectrogram
        features so they can be overlapped in a background thread while the GPU is busy
        transcribing the preceding talk. Produces 100% bit-for-bit identical inputs to
        WhisperModel.transcribe().
        """
        from faster_whisper.vad import VadOptions, collect_chunks, get_speech_timestamps

        fe = getattr(self.model, "feature_extractor", None)
        sampling_rate = getattr(fe, "sampling_rate", 16000)
        if not isinstance(sampling_rate, int):
            sampling_rate = 16000
        duration = float(audio_16k_mono.shape[0]) / sampling_rate if len(audio_16k_mono) > 0 else 0.0

        if vad_filter:
            vad_opts = VadOptions(**DEFAULT_VAD_PARAMS)
            with self._vad_lock:
                speech_chunks = get_speech_timestamps(
                    audio_16k_mono,
                    vad_opts,
                    sampling_rate=sampling_rate,
                )
            audio_chunks, _ = collect_chunks(
                audio_16k_mono,
                speech_chunks,
                sampling_rate=sampling_rate,
            )
            vad_audio = (
                np.concatenate(audio_chunks, axis=0)
                if audio_chunks
                else np.array([], dtype=np.float32)
            )
            duration_after_vad = float(vad_audio.shape[0]) / sampling_rate
        else:
            speech_chunks = None
            vad_audio = audio_16k_mono
            duration_after_vad = duration

        features = self.model.feature_extractor(vad_audio, chunk_length=None)
        return {
            "speech_chunks": speech_chunks,
            "features": features,
            "duration": duration,
            "duration_after_vad": duration_after_vad,
            "sampling_rate": sampling_rate,
            "vad_filter": vad_filter,
        }

    def _transcribe_from_prepared(
        self,
        prepared_asr: Dict[str, Any],
        active_prompt: Optional[str],
        hotwords: Optional[str],
        word_timestamps: bool,
        hallucination_silence_threshold: Optional[float],
        condition_on_previous_text: bool,
    ) -> Iterable[Any]:
        """
        Executes WhisperModel.generate_segments() directly on pre-computed Mel features
        and restores Silero VAD timestamps without repeating CPU VAD/STFT work.
        """
        from faster_whisper.tokenizer import Tokenizer
        from faster_whisper.transcribe import (
            TranscriptionOptions,
            get_suppressed_tokens,
            restore_speech_timestamps,
        )

        tokenizer = Tokenizer(
            self.model.hf_tokenizer,
            self.model.model.is_multilingual,
            task="transcribe",
            language="en",
        )
        options = TranscriptionOptions(
            beam_size=5,
            best_of=5,
            patience=1,
            length_penalty=1,
            repetition_penalty=1,
            no_repeat_ngram_size=0,
            log_prob_threshold=-1.0,
            no_speech_threshold=0.6,
            compression_ratio_threshold=2.4,
            condition_on_previous_text=condition_on_previous_text,
            prompt_reset_on_temperature=0.5,
            temperatures=[0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
            initial_prompt=active_prompt,
            prefix=None,
            suppress_blank=True,
            suppress_tokens=get_suppressed_tokens(tokenizer, [-1]),
            without_timestamps=False,
            max_initial_timestamp=1.0,
            word_timestamps=word_timestamps,
            prepend_punctuations="\"'“¿([{-",
            append_punctuations="\"'.。,，!！?？:：”)]}、",
            multilingual=False,
            max_new_tokens=None,
            clip_timestamps="0",
            hallucination_silence_threshold=hallucination_silence_threshold,
            hotwords=hotwords,
        )
        segments_gen = self.model.generate_segments(
            prepared_asr["features"],
            tokenizer,
            options,
            log_progress=False,
            encoder_output=None,
        )
        speech_chunks = prepared_asr.get("speech_chunks")
        if speech_chunks:
            segments_gen = restore_speech_timestamps(
                segments_gen,
                speech_chunks,
                prepared_asr.get("sampling_rate", 16000),
            )
        return segments_gen

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
        prepared_asr: Optional[Dict[str, Any]] = None,
    ) -> List[Dict]:
        """
        Transcribes 16kHz mono float32 numpy audio.
        Returns list of segment dictionaries with start, end, text, and acoustic confidence metrics.
        Displays an in-place live updating progress bar unless show_progress=False.
        """
        active_prompt = prompt or self.initial_prompt
        vad_params = dict(DEFAULT_VAD_PARAMS)
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
        elif (
            prepared_asr is not None
            and self.batched_pipeline is None
            and prepared_asr.get("vad_filter") == vad_filter
            and type(self.model).__name__ == "WhisperModel"
        ):
            segments_gen = self._transcribe_from_prepared(
                prepared_asr=prepared_asr,
                active_prompt=active_prompt,
                hotwords=hotwords,
                word_timestamps=word_timestamps,
                hallucination_silence_threshold=hallucination_silence_threshold,
                condition_on_previous_text=condition_on_previous_text,
            )
        else:
            with self._vad_lock:
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
        hallucination_phrases = {
            "satsang with mooji",
            "subtitles by the amara.org community",
            "thank you for watching",
            "thanks for watching",
        }
        completed_cleanly = False
        try:
            for s in segments_gen:
                clean_text = s.text.strip()
                if not clean_text:
                    continue
                norm_check = " ".join(clean_text.lower().strip(".!?,;: ").split())
                if norm_check in hallucination_phrases:
                    logger.info(f"Skipping Whisper trailing silence hallucination at {s.start:.2f}s: '{clean_text}'")
                    continue

                words = []
                if getattr(s, "words", None):
                    for w in s.words:
                        raw_w = getattr(w, "word", "")
                        w_start = round(float(w.start), 3)
                        w_end = round(float(w.end), 3)
                        w_prob = round(float(getattr(w, "probability", 1.0)), 3)
                        # Coalesce sub-word continuation tokens lacking a leading space
                        # (e.g. hyphenated compounds 'citta' + '-viveka,', percentages '100' + '%',
                        # decimals '6' + '.15', or apostrophes 'O' + "'Day") so every entry in
                        # `words` maps 1:1 to a whitespace-delimited token in `s.text`.
                        if words and raw_w and not raw_w[0].isspace() and not words[-1]["word"][-1:].isspace():
                            words[-1]["word"] = words[-1]["word"] + raw_w
                            words[-1]["end"] = max(words[-1]["end"], w_end)
                            words[-1]["prob"] = round(min(words[-1]["prob"], w_prob), 3)
                        else:
                            words.append({
                                "word": raw_w,
                                "start": w_start,
                                "end": w_end,
                                "prob": w_prob,
                            })

                # Guard against faster-whisper's add_word_timestamps lead-in boundary bug where
                # an unpunctuated first word (e.g. "This" before "evening") is anchored onto a
                # pre-speech rustle/breath several seconds before actual speech onset.
                if len(words) >= 2:
                    lead_gap = words[1]["start"] - words[0]["end"]
                    w0_tok = words[0]["word"].strip()
                    if lead_gap >= 2.5 and w0_tok and w0_tok[-1] not in ".?!,:;":
                        dur0 = min(max(0.25, words[0]["end"] - words[0]["start"]), 0.60)
                        words[0]["end"] = round(words[1]["start"], 3)
                        words[0]["start"] = round(max(0.0, words[1]["start"] - dur0), 3)

                seg_start = words[0]["start"] if words else round(s.start, 3)
                seg_end = max(round(s.end, 3), words[-1]["end"]) if words else round(s.end, 3)
                segments.append({
                    "start": seg_start,
                    "end": seg_end,
                    "text": clean_text,
                    "avg_logprob": round(float(getattr(s, "avg_logprob", 0.0)), 4),
                    "no_speech_prob": round(float(getattr(s, "no_speech_prob", 0.0)), 4),
                    "words": words,
                })
                if pbar is not None:
                    pbar.update(current_sec=float(seg_end), text=clean_text)
                if progress_callback is not None:
                    try:
                        progress_callback(float(seg_end), total_dur_sec, clean_text)
                    except Exception:
                        pass
            completed_cleanly = True
        finally:
            if pbar is not None:
                pbar.close(completed=completed_cleanly)

        return segments
