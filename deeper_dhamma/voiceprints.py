"""
Voiceprint Database & Reference Gallery Bootstrapper.
"""

import json
import logging
import sqlite3
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import numpy as np

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

        # Calculate cosine similarities
        scores = []
        for entry in gallery:
            sim = float(np.dot(query_embedding, entry["embedding"]))
            scores.append((sim, entry))

        scores.sort(key=lambda x: x[0], reverse=True)
        best_sim, best_entry = scores[0]

        if best_sim >= threshold:
            return {
                "identified": True,
                "teacher_slug": best_entry["teacher_slug"],
                "display_name": best_entry["display_name"],
                "confidence": round(best_sim, 4),
                "role": best_entry["role"],
                "era": best_entry["era"],
            }

        return {
            "identified": False,
            "teacher_slug": "unregistered_speaker",
            "display_name": "Unregistered Speaker",
            "confidence": round(best_sim, 4),
            "role": "guest_or_qa",
        }


def bootstrap_voiceprints(
    archive_dir: Path | str = ARCHIVE_DIR,
    db_path: Path | str = VOICEPRINTS_DB_PATH,
    samples_per_teacher_era: int = 6,
    sample_duration_sec: float = 6.0,
    device: str = "cuda:0",
) -> int:
    """Populates the reference gallery from standalone audio talks."""
    archive_p = Path(archive_dir)
    db = VoiceprintDatabase(db_path)
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

            start_t = 120.0
            end_t = start_t + sample_duration_sec

            waveform_16k, _ = load_audio_segment(audio_f, start_sec=start_t, end_sec=end_t)
            emb = encoder.encode_waveform(waveform_16k)

            db.insert_voiceprint(
                teacher_slug=teacher_slug,
                display_name=display_name,
                era=era,
                role="monastic_primary",
                source_file=audio_f.name,
                start_sec=start_t,
                end_sec=end_t,
                embedding=emb,
            )

            counts[cluster_key] = current_count + 1
            total_added += 1
        except Exception as e:
            logger.debug(f"Error processing {audio_f.name}: {e}")

    logger.info(f"[✓] Voiceprint bootstrap complete: {total_added} embeddings in database.")
    return total_added
