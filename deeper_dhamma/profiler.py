"""
Fast Acoustic Pre-Analysis & Speaker Profiler.
"""

import time
import logging
from pathlib import Path
from typing import Dict, List, Optional
import numpy as np
import torch
from sklearn.cluster import AgglomerativeClustering

from deeper_dhamma.audio import load_audio_segment, get_audio_info
from deeper_dhamma.voiceprints import VoiceprintDatabase
from deeper_dhamma.encoder import SpeakerEncoder

logger = logging.getLogger("speaker_profiler")


class SpeakerProfiler:
    """Pre-analyzes audio with strided acoustic slices before ASR decoding."""

    def __init__(self, voiceprint_db: VoiceprintDatabase, encoder: SpeakerEncoder):
        self.db = voiceprint_db
        self.encoder = encoder

    def profile_audio(
        self,
        audio_path: Path | str,
        stride_sec: float = 30.0,
        window_sec: float = 3.0,
        era: Optional[str] = None,
        max_scan_duration_sec: Optional[float] = None,
        waveform_16k: Optional[torch.Tensor] = None,
        sample_rate: int = 16000,
    ) -> Dict:
        t0 = time.time()
        if waveform_16k is not None:
            total_samples = waveform_16k.shape[-1]
            total_duration = total_samples / sample_rate
        else:
            info = get_audio_info(audio_path)
            total_duration = info["duration"]
            total_samples = None

        scan_duration = min(total_duration, max_scan_duration_sec) if max_scan_duration_sec else total_duration

        # Compute sample time points (skip the first 10s of bell ringing/silence)
        sample_times = np.arange(10.0, scan_duration - window_sec, stride_sec)
        if len(sample_times) < 5:
            sample_times = np.linspace(1.0, max(1.0, scan_duration - window_sec), num=min(5, int(scan_duration // 2)))

        embeddings = []
        valid_times = []

        for t in sample_times:
            try:
                if waveform_16k is not None:
                    start_frame = int(t * sample_rate)
                    end_frame = min(total_samples, int((t + window_sec) * sample_rate))
                    waveform = waveform_16k[:, start_frame:end_frame]
                else:
                    waveform, _ = load_audio_segment(audio_path, start_sec=t, end_sec=t + window_sec)

                # Check for minimum audio energy (skip silence)
                if torch.mean(torch.abs(waveform)).item() < 0.005:
                    continue
                emb = self.encoder.encode_waveform(waveform)
                embeddings.append(emb)
                valid_times.append(t)
            except Exception:
                continue

        if not embeddings:
            return {
                "is_multi_speaker": False,
                "shares": {},
                "ranked_speakers": [],
                "clusters_count": 0,
                "elapsed_sec": round(time.time() - t0, 2),
            }

        emb_matrix = np.array(embeddings)

        # Agglomerative clustering with cosine distance
        clustering = AgglomerativeClustering(
            n_clusters=None,
            metric="cosine",
            linkage="average",
            distance_threshold=0.35,
        )
        labels = clustering.fit_predict(emb_matrix)
        unique_labels, counts = np.unique(labels, return_counts=True)

        cluster_centers = {}
        for lbl in unique_labels:
            cluster_center = np.mean(emb_matrix[labels == lbl], axis=0)
            norm = np.linalg.norm(cluster_center)
            if norm > 0:
                cluster_center = cluster_center / norm
            cluster_centers[lbl] = cluster_center

        total_samples = len(labels)
        ranked_speakers = []
        shares = {}

        for lbl, count in zip(unique_labels, counts):
            share = count / total_samples
            id_res = self.db.identify_speaker(cluster_centers[lbl], era=era, threshold=0.40)
            slug = id_res["teacher_slug"]
            display = id_res["display_name"]
            if not id_res["identified"]:
                slug = f"unregistered_speaker_{lbl}"
                display = f"Unregistered Speaker {lbl}"

            ranked_speakers.append({
                "cluster_id": int(lbl),
                "slug": slug,
                "display_name": display,
                "share": round(share, 3),
                "confidence": id_res["confidence"],
                "role": id_res["role"],
            })
            shares[slug] = round(shares.get(slug, 0.0) + share, 3)

        ranked_speakers.sort(key=lambda x: (x["share"], x.get("confidence", 0.0)), reverse=True)

        # Distinct teachers qualifying as co-speakers:
        # Detected with confident match (>= 0.45) or noticeable presence (>= 3% share).
        distinct_teachers = [
            slug for slug, sh in shares.items()
            if not slug.startswith("unregistered") and (
                sh >= 0.05 or any(r["slug"] == slug and r.get("confidence", 0.0) >= 0.45 for r in ranked_speakers)
            )
        ]
        unreg_share = sum(sh for slug, sh in shares.items() if slug.startswith("unregistered") and sh >= 0.03)

        # Multi-speaker if more than one distinct teacher is detected or guest/QA participants are present
        is_multi_speaker = len(distinct_teachers) > 1 or unreg_share >= 0.03

        elapsed = time.time() - t0
        return {
            "is_multi_speaker": is_multi_speaker,
            "shares": shares,
            "ranked_speakers": ranked_speakers,
            "clusters_count": len(unique_labels),
            "elapsed_sec": round(elapsed, 2),
        }
