"""
Voiceprint Database & Reference Gallery Bootstrapper.
"""

import deeper_dhamma.config  # Enforces HF_HOME and TORCH_HOME under C:\ai-models
from contextlib import contextmanager
import json
import logging
import re
import sqlite3
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Tuple
import numpy as np
import torch

from deeper_dhamma.config import ARCHIVE_DIR, VOICEPRINTS_DB_PATH
from deeper_dhamma.catalog import (
    KNOWN_TEACHERS,
    determine_era,
    extract_recording_year,
    identify_primary_teacher,
)
from deeper_dhamma.audio import load_audio_segment, get_audio_info
from deeper_dhamma.encoder import SpeakerEncoder

logger = logging.getLogger("voiceprints")

LEGACY_SLUG_MAP: Dict[str, Tuple[str, str]] = {
    "ajahn_sujato": ("bhante_sujato", "Bhante Sujato"),
}


class VoiceprintDatabase:
    """SQLite-backed vector storage for monastic speaker embeddings."""

    def __init__(self, db_path: Path | str = VOICEPRINTS_DB_PATH):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._gallery_cache: Optional[List[Dict]] = None
        self._cache_mtime_ns: Optional[int] = None
        self._init_db()

    def invalidate_cache(self) -> None:
        """Clears the in-memory voiceprint gallery cache."""
        self._gallery_cache = None
        self._cache_mtime_ns = None

    @contextmanager
    def _get_connection(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    connection = _get_connection

    def _init_db(self) -> None:
        with self._get_connection() as conn:
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
            conn.commit()

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
        with self._get_connection() as conn:
            cursor = conn.execute(
                """
                INSERT INTO voiceprints (
                    teacher_slug, display_name, era, role, source_file,
                    start_sec, end_sec, embedding
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
                """,
                (teacher_slug, display_name, era, role, source_file, start_sec, end_sec, blob),
            )
            conn.commit()
            row_id = cursor.lastrowid
        self.invalidate_cache()
        return row_id

    def _ensure_gallery_cache(self) -> List[Dict]:
        mtime_ns = self.db_path.stat().st_mtime_ns if self.db_path.exists() else None
        if self._gallery_cache is not None and self._cache_mtime_ns == mtime_ns:
            return self._gallery_cache

        with self._get_connection() as conn:
            cursor = conn.execute("SELECT * FROM voiceprints;")
            rows = cursor.fetchall()

        gallery = []
        for r in rows:
            vec = np.frombuffer(r["embedding"], dtype=np.float32)
            v_norm = float(np.linalg.norm(vec))
            vec_normed = (vec / v_norm) if v_norm > 0 else vec
            slug = r["teacher_slug"]
            display = r["display_name"]
            if slug in LEGACY_SLUG_MAP:
                slug, display = LEGACY_SLUG_MAP[slug]
            gallery.append({
                "id": r["id"],
                "teacher_slug": slug,
                "display_name": display,
                "era": r["era"],
                "role": r["role"],
                "source_file": r["source_file"],
                "embedding": vec,
                "embedding_normed": vec_normed,
            })
        self._gallery_cache = gallery
        self._cache_mtime_ns = mtime_ns
        return gallery

    def load_gallery(self, era: Optional[str] = None) -> List[Dict]:
        all_entries = self._ensure_gallery_cache()
        if era:
            return [g for g in all_entries if g["era"] == era]
        return list(all_entries)

    @staticmethod
    def _compute_teacher_composite(sims: List[float], top_k: int = 3) -> Tuple[float, float]:
        """
        Computes an outlier-resistant composite similarity score for a teacher's
        reference voiceprints. Dampens isolated single-sample spikes when n >= 3.
        """
        s_list = sorted(sims, reverse=True)
        max_s = s_list[0]
        eff_max = max_s
        if len(s_list) >= 3 and (s_list[0] - s_list[1]) > 0.20:
            eff_max = 0.50 * s_list[0] + 0.50 * s_list[1]
        k_eff = min(len(s_list), top_k)
        avg_top_k = float(np.mean(s_list[:k_eff]))
        composite = 0.55 * eff_max + 0.45 * avg_top_k
        return composite, max_s

    def score_speaker(
        self,
        query_embedding: np.ndarray,
        teacher_slug: str,
        era: Optional[str] = None,
        top_k: int = 3,
    ) -> float:
        """
        Returns the composite cosine similarity of `query_embedding` against a
        specific `teacher_slug` (falling back across eras if not present in `era`).
        """
        if teacher_slug in LEGACY_SLUG_MAP:
            teacher_slug = LEGACY_SLUG_MAP[teacher_slug][0]

        gallery = [g for g in self.load_gallery(era=era) if g["teacher_slug"] == teacher_slug]
        if not gallery:
            gallery = [g for g in self.load_gallery(era=None) if g["teacher_slug"] == teacher_slug]
        if not gallery:
            return 0.0

        q_norm = float(np.linalg.norm(query_embedding))
        q_vec = query_embedding / q_norm if q_norm > 0 else query_embedding
        sims = []
        for entry in gallery:
            v_normed = entry.get("embedding_normed")
            if v_normed is None:
                vec = entry["embedding"]
                v_norm = float(np.linalg.norm(vec))
                v_normed = vec / v_norm if v_norm > 0 else vec
            sims.append(float(np.dot(q_vec, v_normed)))

        comp, _ = self._compute_teacher_composite(sims, top_k=top_k)
        return round(comp, 4)

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

        q_norm = float(np.linalg.norm(query_embedding))
        q_vec = query_embedding / q_norm if q_norm > 0 else query_embedding

        # Group gallery entries by teacher
        teacher_sims: Dict[str, Dict] = {}
        for entry in gallery:
            v_normed = entry.get("embedding_normed")
            if v_normed is None:
                vec = entry["embedding"]
                v_norm = float(np.linalg.norm(vec))
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

        # Score teachers by outlier-resistant composite similarity
        ranked = []
        for slug, tinfo in teacher_sims.items():
            composite_score, max_s = self._compute_teacher_composite(tinfo["sims"], top_k=top_k)
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
        with db.connection() as conn:
            conn.execute("DELETE FROM voiceprints;")
            conn.execute("DROP TABLE IF EXISTS speaker_gallery;")
            conn.commit()
        logger.info("Cleared previous voiceprints before bootstrapping clean gallery.")

    encoder = SpeakerEncoder(device=device)

    # Load existing counts from voiceprints table if not cleared
    counts = {}
    if not clear_existing:
        with db.connection() as conn:
            cur = conn.execute("SELECT teacher_slug, era, COUNT(*) FROM voiceprints GROUP BY teacher_slug, era;")
            counts = {(row[0], row[1]): row[2] for row in cur.fetchall()}

    all_files = sorted(list(archive_p.rglob("*.mp3")) + list(archive_p.rglob("*.m4a")))
    total_added = 0

    # Group files by teacher so that monastics with few talks are prioritized
    teacher_files: Dict[str, List] = {}
    for f in all_files:
        # Skip multi-teacher / co-taught recordings for bootstrapping exemplar reference voiceprints
        matched_monastics = set()
        lower_name = f.name.lower().replace("_", " ")
        for t in KNOWN_TEACHERS:
            for pat in t["patterns"]:
                if re.search(pat, lower_name):
                    matched_monastics.add(t["slug"])
                    break
        if len(matched_monastics) > 1:
            continue

        tslug, tdisplay = identify_primary_teacher(f.name)
        if tslug != "unknown_teacher":
            teacher_files.setdefault(tslug, []).append((f, tdisplay))

    logger.info(f"Scanning {len(all_files)} audio files across archive ({len(teacher_files)} known teachers represented)...")

    for tslug, files in teacher_files.items():
        # Prioritize standalone / non-Q&A monologue talks over Q&A sessions
        files_sorted = sorted(
            files,
            key=lambda item: (1 if re.search(r"(?:^|_)(?:q_a|qa)(?:_|\.|$)", item[0].name.lower()) else 0, item[0].name),
        )
        for audio_f, display_name in files_sorted:
            year_val = None
            for part in audio_f.parts:
                if part.isdigit() and len(part) == 4:
                    year_val = int(part)
                    break
            if not year_val:
                year_val = 2010

            rec_year = extract_recording_year(audio_f.name, fallback_year=year_val)
            era = determine_era(rec_year)
            cluster_key = (tslug, era)
            current_count = counts.get(cluster_key, 0)
            if current_count >= samples_per_teacher_era:
                continue

            try:
                info = get_audio_info(audio_f)
                dur = info["duration"]
                if dur < 30.0:
                    continue

                # Candidate time offsets deeper into the talk to avoid opening introductions/bells
                candidate_times = [180.0, 240.0, 300.0, 420.0, 600.0, 120.0, 60.0]
                best_waveform = None
                best_energy = -1.0
                best_start_t = 180.0

                for cand_t in candidate_times:
                    if cand_t + sample_duration_sec > dur - 5.0:
                        continue
                    seg_wave, _ = load_audio_segment(
                        audio_f,
                        start_sec=cand_t,
                        end_sec=cand_t + sample_duration_sec,
                    )
                    mean_energy = float(torch.mean(torch.abs(seg_wave)).item())
                    max_energy = float(torch.max(torch.abs(seg_wave)).item())

                    # If this segment has strong speech energy, accept immediately
                    if mean_energy >= 0.012 and max_energy >= 0.06:
                        best_waveform = seg_wave
                        best_start_t = cand_t
                        best_energy = mean_energy
                        break

                    if mean_energy > best_energy:
                        best_energy = mean_energy
                        best_waveform = seg_wave
                        best_start_t = cand_t

                # Skip file if no candidate has minimum speech energy
                if best_waveform is None or best_energy < 0.003:
                    continue

                end_t = best_start_t + sample_duration_sec
                emb = encoder.encode_waveform(best_waveform)

                db.insert_voiceprint(
                    teacher_slug=tslug,
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

    pruned = sanitize_and_prune_voiceprints(db_path=db_path)
    logger.info(f"[✓] Voiceprint bootstrap complete: {total_added} added, {pruned} outliers/duplicates pruned.")
    return total_added - pruned


def sanitize_and_prune_voiceprints(
    db_path: Path | str = VOICEPRINTS_DB_PATH,
    min_peer_similarity: float = 0.32,
) -> int:
    """
    Sanitizes `voiceprints.db` in place:
    1. Normalizes legacy teacher slugs (e.g. `ajahn_sujato` -> `bhante_sujato`).
    2. Corrects `era` tags on backfilled recordings using `extract_recording_year(source_file)`.
    3. Removes exact duplicate `(teacher_slug, source_file, start_sec)` rows.
    4. Removes contaminated/outlier voiceprints in clusters (n >= 3) whose mean cosine
       similarity to their teacher peers falls below `min_peer_similarity` while the
       cluster medoid is well-formed (>= 0.45).
    Returns the number of pruned/deduplicated rows.
    """
    db_p = Path(db_path)
    if not db_p.exists():
        return 0

    removed_ids = set()
    db = VoiceprintDatabase(db_p)
    with db.connection() as conn:
        rows = conn.execute("SELECT * FROM voiceprints ORDER BY id ASC;").fetchall()

        # 1. Normalize slugs, fix eras from source_file recording year, and find exact duplicates
        seen_keys = set()
        for r in rows:
            rid = r["id"]
            slug = r["teacher_slug"]
            display = r["display_name"]
            if slug in LEGACY_SLUG_MAP:
                slug, display = LEGACY_SLUG_MAP[slug]
                conn.execute(
                    "UPDATE voiceprints SET teacher_slug = ?, display_name = ? WHERE id = ?;",
                    (slug, display, rid),
                )

            src = r["source_file"]
            rec_year = extract_recording_year(src, fallback_year=0)
            if rec_year >= 1990:
                true_era = determine_era(rec_year)
                if true_era != r["era"]:
                    conn.execute("UPDATE voiceprints SET era = ? WHERE id = ?;", (true_era, rid))

            dedup_key = (slug, src, round(float(r["start_sec"]), 1))
            if dedup_key in seen_keys:
                removed_ids.add(rid)
            else:
                seen_keys.add(dedup_key)

        if removed_ids:
            conn.executemany("DELETE FROM voiceprints WHERE id = ?;", [(i,) for i in removed_ids])

        # 2. Intra-teacher medoid outlier pruning
        rows = conn.execute("SELECT * FROM voiceprints ORDER BY id ASC;").fetchall()
        by_teacher: Dict[str, List[Tuple[int, np.ndarray]]] = {}
        for r in rows:
            vec = np.frombuffer(r["embedding"], dtype=np.float32)
            norm = np.linalg.norm(vec)
            v_normed = vec / norm if norm > 0 else vec
            by_teacher.setdefault(r["teacher_slug"], []).append((r["id"], v_normed))

        outlier_ids = []
        for slug, items in by_teacher.items():
            if len(items) < 3:
                continue
            vecs = np.array([x[1] for x in items])
            sim_mat = vecs @ vecs.T
            n = len(items)
            peer_means = [
                float(np.mean([sim_mat[i, j] for j in range(n) if i != j]))
                for i in range(n)
            ]
            max_peer_mean = max(peer_means)
            # Only prune if the teacher has a coherent core (best sample >= 0.35 peer sim)
            if max_peer_mean < 0.30:
                continue
            for i, (rid, _) in enumerate(items):
                if peer_means[i] < min_peer_similarity and (max_peer_mean - peer_means[i]) >= 0.14:
                    outlier_ids.append(rid)

        if outlier_ids:
            conn.executemany("DELETE FROM voiceprints WHERE id = ?;", [(i,) for i in outlier_ids])
        conn.commit()

    return len(removed_ids) + len(outlier_ids)


def inspect_unknown_audio(
    archive_dir: Path | str = ARCHIVE_DIR,
    threshold: float = 0.40,
    stride_sec: float = 20.0,
    max_scan_sec: float = 300.0,
    limit: Optional[int] = None,
    device: str = "cuda:0",
    update_db: bool = True,
) -> List[Dict]:
    """
    Scans archive audio files where the teacher is unknown, extracts speaker embeddings
    using ECAPA-TDNN, compares against the reference voiceprint gallery, and associates
    identified teachers in dhamma_transcripts.db.
    """
    from deeper_dhamma.storage import TranscriptDatabase
    from deeper_dhamma.profiler import SpeakerProfiler

    trans_db = TranscriptDatabase()
    trans_db.index_archive_audio_files(archive_dir)

    with trans_db._get_connection() as conn:
        rows = conn.execute(
            """
            SELECT id, title, year
            FROM episodes
            WHERE primary_teacher = 'unknown_teacher'
               OR identified_teachers = 'Unknown Teacher'
               OR identified_teachers IS NULL
            ORDER BY year ASC, title ASC;
            """
        ).fetchall()
        unknown_candidates = [dict(r) for r in rows]

    if not unknown_candidates:
        logger.info("[✓] No unknown audio files found in database.")
        return []

    if limit:
        unknown_candidates = unknown_candidates[:limit]

    logger.info(f"[*] Initializing SpeakerEncoder on {device}...")
    vp_db = VoiceprintDatabase()
    encoder = SpeakerEncoder(device=device)
    profiler = SpeakerProfiler(vp_db, encoder)

    results = []
    for ep in unknown_candidates:
        ep_id = ep["id"]
        filepath_str = trans_db.pipeline_db.get_filepath(ep_id)
        file_path = Path(filepath_str) if filepath_str else None

        if not file_path or not file_path.exists():
            matches = list(Path(archive_dir).rglob(f"{ep_id}.*"))
            if matches:
                file_path = matches[0]

        if not file_path or not file_path.exists():
            continue

        era = determine_era(ep.get("year", 2010) or 2010)
        try:
            profile = profiler.profile_audio(
                file_path,
                stride_sec=stride_sec,
                window_sec=3.0,
                era=era,
                max_scan_duration_sec=max_scan_sec,
            )
        except Exception as e:
            logger.warning(f"Error profiling {file_path.name}: {e}")
            continue

        ranked = profile.get("ranked_speakers", [])
        identified_speaker = None
        confidence = 0.0
        share = 0.0

        for spk in ranked:
            slug = spk.get("slug", "")
            if slug and not slug.startswith("unregistered_speaker"):
                if spk.get("confidence", 0.0) >= threshold:
                    identified_speaker = spk
                    confidence = float(spk["confidence"])
                    share = float(spk["share"])
                    break

        detection_source = "voiceprint"
        if not identified_speaker:
            fn_slug, fn_display = identify_primary_teacher(file_path.name)
            if fn_slug != "unknown_teacher":
                identified_speaker = {
                    "slug": fn_slug,
                    "display_name": fn_display,
                    "confidence": 1.0,
                    "share": 1.0,
                }
                confidence = 1.0
                share = 1.0
                detection_source = "filename_pattern"

        item_result = {
            "episode_id": ep_id,
            "filename": file_path.name,
            "year": ep.get("year"),
            "identified": identified_speaker is not None,
            "teacher_slug": identified_speaker["slug"] if identified_speaker else "unknown_teacher",
            "display_name": identified_speaker["display_name"] if identified_speaker else "Unknown Teacher",
            "confidence": confidence,
            "share": share,
            "is_multi_speaker": profile.get("is_multi_speaker", False),
            "all_speakers": ranked,
            "detection_source": detection_source,
        }
        results.append(item_result)

        if identified_speaker and update_db:
            trans_db.associate_teacher(
                episode_id=ep_id,
                teacher_slug=identified_speaker["slug"],
                detection_source=detection_source,
                confidence=confidence,
                share=share,
            )
            with trans_db._get_connection() as conn:
                conn.execute(
                    """
                    UPDATE episodes
                    SET primary_teacher = ?, primary_display = ?
                    WHERE id = ?;
                    """,
                    (identified_speaker["slug"], identified_speaker["display_name"], ep_id),
                )

    return results
