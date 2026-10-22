"""
Voiceprint Database & Reference Gallery Bootstrapper.
"""

import json
import logging
import sqlite3
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import numpy as np
import torch

from deeper_dhamma.config import ARCHIVE_DIR, VOICEPRINTS_DB_PATH
from deeper_dhamma.catalog import KNOWN_TEACHERS, determine_era, identify_primary_teacher
from deeper_dhamma.audio import load_audio_segment, get_audio_info
from deeper_dhamma.encoder import SpeakerEncoder

logger = logging.getLogger("voiceprints")


class VoiceprintDatabase:
    """SQLite-backed vector storage for monastic speaker embeddings."""

    def __init__(self, db_path: Path | str = VOICEPRINTS_DB_PATH):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _init_db(self) -> None:
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS voiceprints (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    teacher_slug TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    era TEXT NOT NULL,
                    role TEXT NOT NULL,
                    source_file TEXT NOT NULL,
                    start_sec REAL NOT NULL,
                    end_sec REAL NOT NULL,
                    embedding BLOB NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_teacher_era ON voiceprints(teacher_slug, era);")

    def insert_voiceprint(
        self,
        teacher_slug: str,
        display_name: str,
        era: str,
        role: str,
        source_file: str,
        start_sec: float,
        end_sec: float,
        embedding: np.ndarray,
    ) -> int:
        blob = embedding.astype(np.float32).tobytes()
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute(
                """
                INSERT INTO voiceprints (
                    teacher_slug, display_name, era, role, source_file,
                    start_sec, end_sec, embedding
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
                """,
                (teacher_slug, display_name, era, role, source_file, start_sec, end_sec, blob),
            )
            return cursor.lastrowid

    def load_gallery(self, era: Optional[str] = None) -> List[Dict]:
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.row_factory = sqlite3.Row
            if era:
                cursor = conn.execute("SELECT * FROM voiceprints WHERE era = ?;", (era,))
            else:
                cursor = conn.execute("SELECT * FROM voiceprints;")
            rows = cursor.fetchall()

        gallery = []
        for r in rows:
            vec = np.frombuffer(r["embedding"], dtype=np.float32)
            gallery.append({
                "id": r["id"],
                "teacher_slug": r["teacher_slug"],
                "display_name": r["display_name"],
                "era": r["era"],
                "role": r["role"],
                "source_file": r["source_file"],
                "embedding": vec,
            })
        return gallery

    def identify_speaker(
        self,
        query_embedding: np.ndarray,
        era: Optional[str] = None,
        top_k: int = 3,
        threshold: float = 0.40,
    ) -> Dict:
        gallery = self.load_gallery(era=era)
        if not gallery and era:
            gallery = self.load_gallery(era=None)

        if not gallery:
            return {
                "identified": False,
                "teacher_slug": "unregistered_speaker",
                "display_name": "Unregistered Speaker",
                "confidence": 0.0,
                "role": "guest_or_qa",
            }

        q_norm = np.linalg.norm(query_embedding)
        q_vec = query_embedding / q_norm if q_norm > 0 else query_embedding

        # Group gallery entries by teacher
        teacher_sims: Dict[str, Dict] = {}
        for entry in gallery:
            vec = entry["embedding"]
            v_norm = np.linalg.norm(vec)
            v_normed = vec / v_norm if v_norm > 0 else vec
            sim = float(np.dot(q_vec, v_normed))
            slug = entry["teacher_slug"]
            if slug not in teacher_sims:
                teacher_sims[slug] = {
                    "slug": slug,
                    "display_name": entry["display_name"],
                    "role": entry["role"],
                    "era": entry["era"],
                    "sims": [],
                }
            teacher_sims[slug]["sims"].append(sim)

        # Score teachers by composite: 0.70 * max_sim + 0.30 * top_k_avg
        ranked = []
        for slug, tinfo in teacher_sims.items():
            s_list = sorted(tinfo["sims"], reverse=True)
            max_s = s_list[0]
            k_eff = min(len(s_list), top_k)
            avg_top_k = float(np.mean(s_list[:k_eff]))
            composite_score = 0.70 * max_s + 0.30 * avg_top_k
            ranked.append((composite_score, max_s, tinfo))

        ranked.sort(key=lambda x: x[0], reverse=True)
        best_composite, best_max, best_tinfo = ranked[0]

        if best_composite >= threshold:
            return {
                "identified": True,
                "teacher_slug": best_tinfo["slug"],
                "display_name": best_tinfo["display_name"],
                "confidence": round(best_composite, 4),
                "role": best_tinfo["role"],
                "era": best_tinfo["era"],
            }

        return {
            "identified": False,
            "teacher_slug": "unregistered_speaker",
            "display_name": "Unregistered Speaker",
            "confidence": round(best_composite, 4),
            "role": "guest_or_qa",
        }


def bootstrap_voiceprints(
    archive_dir: Path | str = ARCHIVE_DIR,
    db_path: Path | str = VOICEPRINTS_DB_PATH,
    samples_per_teacher_era: int = 6,
    sample_duration_sec: float = 6.0,
    device: str = "cuda:0",
    clear_existing: bool = True,
) -> int:
    """Populates the reference gallery from standalone audio talks."""
    archive_p = Path(archive_dir)
    db = VoiceprintDatabase(db_path)

    if clear_existing:
        with sqlite3.connect(str(db.db_path)) as conn:
            conn.execute("DELETE FROM voiceprints;")
            conn.execute("DROP TABLE IF EXISTS speaker_gallery;")
            conn.commit()
        logger.info("Cleared previous voiceprints before bootstrapping clean gallery.")

    encoder = SpeakerEncoder(device=device)

    all_files = sorted(list(archive_p.rglob("*.mp3")))
    counts = {}
    total_added = 0

    logger.info(f"Scanning {len(all_files)} audio files across archive for voiceprint extraction...")

    for audio_f in all_files:
        teacher_slug, display_name = identify_primary_teacher(audio_f.name)
        if teacher_slug == "unknown_teacher":
            continue

        year_val = None
        for part in audio_f.parts:
            if part.isdigit() and len(part) == 4:
                year_val = int(part)
                break
        if not year_val:
            year_val = 2010

        era = determine_era(year_val)
        cluster_key = (teacher_slug, era)
        current_count = counts.get(cluster_key, 0)
        if current_count >= samples_per_teacher_era:
            continue

        try:
            info = get_audio_info(audio_f)
            dur = info["duration"]
            if dur < 180:
                continue

            # Candidate time offsets across the talk to find active voiced speech
            candidate_times = [60.0, 120.0, 180.0, 240.0, 300.0, 420.0, 600.0]
            best_waveform = None
            best_energy = -1.0
            best_start_t = 120.0

            for cand_t in candidate_times:
                if cand_t + sample_duration_sec > dur - 10.0:
                    continue
                seg_wave, _ = load_audio_segment(
                    audio_f,
                    start_sec=cand_t,
                    end_sec=cand_t + sample_duration_sec,
                )
                mean_energy = float(torch.mean(torch.abs(seg_wave)).item())
                max_energy = float(torch.max(torch.abs(seg_wave)).item())

                # If this segment has strong speech energy, accept immediately
                if mean_energy >= 0.012 and max_energy >= 0.08:
                    best_waveform = seg_wave
                    best_start_t = cand_t
                    best_energy = mean_energy
                    break

                if mean_energy > best_energy:
                    best_energy = mean_energy
                    best_waveform = seg_wave
                    best_start_t = cand_t

            # Skip file if no candidate has minimum speech energy
            if best_waveform is None or best_energy < 0.005:
                continue

            end_t = best_start_t + sample_duration_sec
            emb = encoder.encode_waveform(best_waveform)

            db.insert_voiceprint(
                teacher_slug=teacher_slug,
                display_name=display_name,
                era=era,
                role="monastic_primary",
                source_file=audio_f.name,
                start_sec=best_start_t,
                end_sec=end_t,
                embedding=emb,
            )

            counts[cluster_key] = current_count + 1
            total_added += 1
        except Exception as e:
            logger.debug(f"Error processing {audio_f.name}: {e}")

    logger.info(f"[✓] Voiceprint bootstrap complete: {total_added} embeddings in database.")
    return total_added
