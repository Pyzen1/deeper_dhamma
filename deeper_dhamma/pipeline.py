"""
TranscriptionPipeline Orchestrator.
"""

import json
import logging
import time
from pathlib import Path
from typing import Dict, Optional, Union

from deeper_dhamma.config import (
    CATALOG_PATH,
    TRANSCRIPTS_DB_PATH,
    VOICEPRINTS_DB_PATH,
)
from deeper_dhamma.catalog import (
    determine_era,
    identify_primary_teacher,
    parse_episode_metadata,
)
from deeper_dhamma.audio import load_audio_segment, get_audio_info
from deeper_dhamma.voiceprints import VoiceprintDatabase
from deeper_dhamma.encoder import SpeakerEncoder
from deeper_dhamma.asr import Transcriber
from deeper_dhamma.profiler import SpeakerProfiler
from deeper_dhamma.aligner import SpeakerAligner
from deeper_dhamma.terminology import TerminologyEditor
from deeper_dhamma.lexicon import BuddhismLexiconDatabase
from deeper_dhamma.storage import TranscriptDatabase

logger = logging.getLogger("pipeline")


class TranscriptionPipeline:
    """End-to-end pipeline runner."""

    def __init__(
        self,
        voiceprints_db_path: Path | str = VOICEPRINTS_DB_PATH,
        transcripts_db_path: Path | str = TRANSCRIPTS_DB_PATH,
        catalog_path: Optional[Path | str] = CATALOG_PATH,
        device: str = "cuda:0",
        model_size: str = "large-v3",
        batch_size: int = 16,
    ):
        logger.info(f"[*] Initializing TranscriptionPipeline components (model={model_size}, batch_size={batch_size})...")
        self.voiceprints_db = VoiceprintDatabase(voiceprints_db_path)
        self.encoder = SpeakerEncoder(device=device)
        self.transcriber = Transcriber(model_size=model_size, device="cuda", compute_type="float16", batch_size=batch_size)
        self.aligner = SpeakerAligner(voiceprint_db=self.voiceprints_db, encoder=self.encoder)
        self.profiler = SpeakerProfiler(voiceprint_db=self.voiceprints_db, encoder=self.encoder)
        self.lexicon_db = BuddhismLexiconDatabase()
        self.terminology_editor = TerminologyEditor(self.lexicon_db.db_path)
        self.db = TranscriptDatabase(db_path=transcripts_db_path)

        # Build fast lookup map from catalog.json if available
        self.catalog_map: Dict[str, Dict] = {}
        if catalog_path and Path(catalog_path).exists():
            try:
                with open(catalog_path, "r", encoding="utf-8") as f:
                    cat_list = json.load(f)
                for ep in cat_list:
                    _, _, fname = parse_episode_metadata(ep.get("title", ""), ep.get("upload_date", ""))
                    self.catalog_map[fname] = ep
                logger.info(f"[+] Loaded {len(self.catalog_map)} catalog metadata entries for automated stream linking.")
            except Exception as e:
                logger.warning(f"Could not parse catalog file: {e}")

        logger.info("[✓] All pipeline components loaded and ready on GPU.")

    def process_file(
        self,
        audio_path: Path | str,
        catalog_entry: Optional[Dict] = None,
        max_duration_sec: Optional[float] = None,
    ) -> Dict:
        audio_path = Path(audio_path)
        t0 = time.time()
        logger.info(f"[*] Processing audio: {audio_path.name}")

        info = get_audio_info(audio_path)
        total_dur = info["duration"]
        process_dur = min(total_dur, max_duration_sec) if max_duration_sec else total_dur
        logger.info(f"    Total duration: {total_dur:.1f}s | Processing: {process_dur:.1f}s")

        year_val = None
        for part in audio_path.parts:
            if part.isdigit() and len(part) == 4:
                year_val = int(part)
                break
        if not year_val:
            year_val = 2010

        era = determine_era(year_val)
        meta_teacher_slug, meta_teacher_display = identify_primary_teacher(audio_path.name)
        primary_slug = meta_teacher_slug
        primary_display = meta_teacher_display

        if not catalog_entry:
            catalog_entry = self.catalog_map.get(audio_path.stem)

        if catalog_entry:
            ep_title = catalog_entry.get("title", audio_path.stem)
            ep_id = catalog_entry.get("id", audio_path.stem)
            media_url = catalog_entry.get("media_url", "")
            permalink = catalog_entry.get("permalink", "")
            upload_date = catalog_entry.get("upload_date", "")
        else:
            ep_title = audio_path.stem.replace("_", " ").title()
            ep_id = audio_path.stem
            media_url = ""
            permalink = ""
            upload_date = f"{year_val}0101"

        # 1. Single In-Memory Audio Loading & Resample (zero repeated disk I/O)
        logger.info(f"    Loading {process_dur:.1f}s audio at 16kHz mono into RAM...")
        waveform_16k, _ = load_audio_segment(audio_path, start_sec=0.0, end_sec=process_dur, target_sr=16000)
        audio_np = waveform_16k.squeeze(0).numpy()

        # 2. Fast Acoustic Pre-Profiling (in-memory slice evaluation)
        logger.info(f"    Running fast acoustic pre-profiling across {process_dur:.1f}s...")
        profile = self.profiler.profile_audio(
            audio_path,
            stride_sec=30.0,
            window_sec=3.0,
            era=era,
            waveform_16k=waveform_16k,
        )
        if profile["is_multi_speaker"] and profile.get("ranked_speakers"):
            raw_names = [s["display_name"] for s in profile["ranked_speakers"] if s["share"] >= 0.08 and s.get("confidence", 0) >= 0.40]
            if primary_display not in raw_names and meta_teacher_slug != "unknown_teacher":
                raw_names.insert(0, primary_display)
            names = list(dict.fromkeys(raw_names))
            if len(names) > 1:
                primary_display = " & ".join(names[:2])
            elif names:
                primary_display = names[0]
        elif meta_teacher_slug == "unknown_teacher" and profile.get("ranked_speakers"):
            top = profile["ranked_speakers"][0]
            if top.get("confidence", 0) >= 0.42:
                primary_slug = top["slug"]
                primary_display = top["display_name"]

        # Collect all active teacher slugs for tailored vocabulary steering
        active_slugs = [primary_slug]
        if profile.get("is_multi_speaker") and profile.get("ranked_speakers"):
            for s in profile["ranked_speakers"]:
                if s.get("share", 0) >= 0.08 and s["slug"] not in active_slugs and not s["slug"].startswith("unregistered"):
                    active_slugs.append(s["slug"])

        meta = {
            "id": ep_id,
            "title": ep_title,
            "primary_teacher": primary_slug,
            "primary_display": primary_display,
            "media_url": media_url,
            "permalink": permalink,
            "upload_date": upload_date,
            "is_multi_speaker": profile.get("is_multi_speaker", False),
            "speaker_shares": profile.get("shares", {}),
        }

        # 3. Speech-to-Text with Teacher-Specific Prompt Steering & Continuous Hotwords
        talk_prompt = self.lexicon_db.get_prompt_steering_terms(teacher_slugs=active_slugs, limit=30)
        talk_hotwords = self.lexicon_db.get_hotwords_for_teachers(teacher_slugs=active_slugs, limit=50)
        logger.info(f"    Transcribing with faster-whisper (batched, float16, Silero VAD, {len(active_slugs)} teacher profile(s))...")
        t_asr0 = time.time()
        asr_segments = self.transcriber.transcribe(audio_np, prompt=talk_prompt, hotwords=talk_hotwords)
        logger.info(f"    ASR complete in {time.time() - t_asr0:.2f}s ({len(asr_segments)} segments).")

        # 4. Speaker Alignment & Identification (in-memory slice attribution)
        logger.info("    Aligning speakers with voiceprints & pre-analyzed profile...")
        t_spk0 = time.time()
        attributed = self.aligner.align_segments(
            audio_file=audio_path,
            asr_segments=asr_segments,
            primary_slug=primary_slug,
            primary_display=primary_display,
            era=era,
            profile=profile,
            waveform_16k=waveform_16k,
        )
        logger.info(f"    Speaker alignment complete in {time.time() - t_spk0:.2f}s ({len(attributed)} turns).")

        # 5. Buddhist Terminology Normalization & Audit Pass
        logger.info("    Applying final Buddhist reference terminology normalization...")
        attributed, term_changelog = self.terminology_editor.edit_segments(attributed)
        if term_changelog:
            logger.info(f"    [+] Terminology editor applied {len(term_changelog)} standardization rule(s).")

        # 6. Commit to Unified SQLite Database
        logger.info("    Committing to unified SQLite database & updating FTS5 index...")
        self.db.save_episode(
            episode_metadata=meta,
            attributed_segments=attributed,
            duration_sec=process_dur,
            year=str(year_val),
            filename_stem=audio_path.stem,
            terminology_changelog=term_changelog,
        )

        elapsed = time.time() - t0
        logger.info(f"[✓] Episode committed in {elapsed:.2f}s: {meta['id']}")

        return {
            "audio_file": str(audio_path),
            "episode_id": meta["id"],
            "duration_sec": process_dur,
            "elapsed_sec": round(elapsed, 2),
            "primary_teacher": primary_slug,
            "primary_display": primary_display,
            "is_multi_speaker": profile.get("is_multi_speaker", False),
            "speaker_shares": profile.get("shares", {}),
            "era": era,
            "turns_count": len(attributed),
            "db_path": str(self.db.db_path),
            "turns_sample": attributed[:3],
        }
