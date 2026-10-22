"""
Pipeline Benchmark & Accuracy Evaluator against Curated Gold Standard References.

Compares pipeline-generated transcripts against true word-for-word human reference transcripts,
evaluating vocabulary precision, recall, speedup, and key Pali Buddhist terminology.
"""

import logging
import re
import time
from pathlib import Path
from typing import Dict, List, Optional

from deeper_dhamma.config import ARCHIVE_DIR, PROJECT_ROOT
from deeper_dhamma.pipeline import TranscriptionPipeline

logger = logging.getLogger("benchmark")

REF_DIR = PROJECT_ROOT / "benchmarks" / "reference_transcripts"


def normalize_text(text: str) -> List[str]:
    """Tokenizes and normalizes text for token comparison."""
    text = text.lower()
    text = re.sub(r"[^\w\s]", "", text)
    tokens = text.split()
    return tokens


def calculate_token_metrics(ref_tokens: List[str], hyp_tokens: List[str]) -> Dict[str, float]:
    """Calculates approximate token overlap, precision, and recall."""
    ref_set = set(ref_tokens)
    hyp_set = set(hyp_tokens)

    intersection = ref_set.intersection(hyp_set)
    precision = len(intersection) / len(hyp_set) if hyp_set else 0.0
    recall = len(intersection) / len(ref_set) if ref_set else 0.0
    f1 = 2 * (precision * recall) / (precision + recall) if (precision + recall) else 0.0

    return {
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "vocab_overlap_count": len(intersection),
    }


def find_matching_audio(ref_path: Path, archive_dir: Path = ARCHIVE_DIR) -> Optional[Path]:
    """
    Locates the corresponding audio MP3 file in the archive for a reference transcript.
    Matches by date (YYYY-MM-DD) and highest keyword token overlap.
    """
    stem = ref_path.stem.lower()
    ref_words = set(re.findall(r"\w+", stem))

    # 1. Date-based matching (YYYY-MM-DD)
    m = re.match(r"^(\d{4}-\d{2}-\d{2})", stem)
    candidates = []
    if m:
        date_str = m.group(1)
        year_str = date_str.split("-")[0]
        year_dir = archive_dir / year_str
        if year_dir.exists():
            candidates = list(year_dir.rglob(f"*{date_str}*.mp3"))
        if not candidates:
            candidates = list(archive_dir.rglob(f"*{date_str}*.mp3"))

    if not candidates:
        candidates = list(archive_dir.rglob("*.mp3"))

    # Score candidates by token overlap with ref stem
    best_candidate = None
    best_score = -1

    for audio in candidates:
        audio_words = set(re.findall(r"\w+", audio.stem.lower()))
        overlap = len(ref_words.intersection(audio_words))
        if overlap > best_score:
            best_score = overlap
            best_candidate = audio

    return best_candidate


def discover_active_benchmarks() -> List[Dict]:
    """
    Discovers all verified gold-standard reference transcripts in benchmarks/reference_transcripts/
    and pairs them with their source audio files. Ignores candidate drafts.
    """
    REF_DIR.mkdir(parents=True, exist_ok=True)
    pairs = []

    for ref_p in sorted(REF_DIR.glob("*.txt")):
        if ref_p.name.endswith("_candidate.txt"):
            continue  # Candidate draft awaiting human review

        audio_p = find_matching_audio(ref_p)
        if audio_p and audio_p.exists():
            pairs.append({
                "name": ref_p.stem.replace("_", " ").title(),
                "ref_text": ref_p,
                "audio": audio_p,
            })
        else:
            logger.warning(f"Could not find matching audio for reference transcript: {ref_p.name}")

    return pairs


def run_benchmarks(duration_sec: float = 300.0, device: str = "cuda:0") -> None:
    """
    Runs evaluation against all active, verified gold-standard reference transcripts.
    """
    print("=" * 75)
    print("BSWA Deeper Dhamma: Curated Gold Standard Benchmark Evaluation")
    print("=" * 75)

    pairs = discover_active_benchmarks()
    if not pairs:
        print("[!] No active gold standard reference transcripts found.")
        print(f"    Place verified word-for-word transcripts in: {REF_DIR}")
        print("    Or curate a candidate using: python main.py curate <audio_file>")
        return

    print(f"[*] Found {len(pairs)} active gold standard reference(s) for evaluation:\n")
    for idx, p in enumerate(pairs, 1):
        print(f"  {idx}. {p['name']}")
        print(f"     Ref:   {p['ref_text'].name} ({p['ref_text'].stat().st_size:,} bytes)")
        print(f"     Audio: {p['audio'].name}")

    pipeline = TranscriptionPipeline(device=device)

    for item in pairs:
        audio_p = item["audio"]
        ref_p = item["ref_text"]

        print(f"\n[*] Evaluating: {item['name']}")
        print(f"    Audio:     {audio_p.name}")
        print(f"    Reference: {ref_p.name}")

        with open(ref_p, "r", encoding="utf-8") as f:
            ref_content = f.read()
        ref_tokens = normalize_text(ref_content)

        result = pipeline.process_file(
            audio_path=audio_p,
            max_duration_sec=duration_sec,
        )

        hyp_content = pipeline.db.generate_markdown(result["episode_id"])
        hyp_tokens = normalize_text(hyp_content)

        metrics = calculate_token_metrics(ref_tokens, hyp_tokens)

        key_pali_terms = [
            "jhana", "meditation", "samadhi", "breath", "mind",
            "obstacles", "peace", "body", "letting", "kamma", "dhamma"
        ]
        found_terms = [t for t in key_pali_terms if t in hyp_tokens]

        speedup = result["duration_sec"] / result["elapsed_sec"] if result["elapsed_sec"] else 0
        print("    --- Benchmark Results ---")
        print(f"    - Duration Processed:    {result['duration_sec']:.1f}s in {result['elapsed_sec']:.2f}s (Speedup: {speedup:.1f}x)")
        print(f"    - Identified Speaker:    {result['primary_teacher']} (Era: {result['era']})")
        print(f"    - Multi-Speaker Flag:    {result['is_multi_speaker']}")
        print(f"    - Vocabulary Precision:  {metrics['precision']*100:.1f}%")
        print(f"    - Vocabulary Recall:     {metrics['recall']*100:.1f}%")
        print(f"    - F1 Score:              {metrics['f1']:.4f}")
        print(f"    - Key Term Match:        {len(found_terms)}/{len(key_pali_terms)} ({', '.join(found_terms)})")

    print("\n[✓] Benchmark evaluation completed successfully!")
