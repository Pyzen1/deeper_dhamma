#!/usr/bin/env python3
"""
Sequential Re-Transcription Runner for Currently Transcribed Browse Talks.
Prioritizes data quality and speech completeness over speed (batch_size=1, tuned VAD).
"""

import os
import sys
import time
import sqlite3
from pathlib import Path

# Ensure project root is on sys.path
PROJECT_ROOT = Path(__file__).resolve().parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import deeper_dhamma.config
from deeper_dhamma.storage import TranscriptDatabase
from deeper_dhamma.pipeline import TranscriptionPipeline
from deeper_dhamma.export_web import export_static_site

def main():
    print("=" * 80)
    print("BSWA Deeper Dhamma: Sequential Quality-First Re-Transcription")
    print("=" * 80)

    db_path = PROJECT_ROOT / "databases" / "dhamma_transcripts.db"
    tdb = TranscriptDatabase(db_path=db_path)
    fp_map = tdb.pipeline_db.get_filepath_map()

    with tdb._get_connection() as conn:
        ep_ids = [r[0] for r in conn.execute("SELECT id FROM episodes WHERE is_transcribed = 1").fetchall()]

    unique_paths = set()
    for ep_id in ep_ids:
        fp = fp_map.get(ep_id)
        if fp and os.path.exists(fp):
            unique_paths.add(Path(fp))

    target_files = sorted(list(unique_paths), key=lambda p: str(p))
    print(f"[*] Found {len(target_files)} unique audio talks to re-transcribe.")
    for idx, f in enumerate(target_files, 1):
        sz = f.stat().st_size / (1024 * 1024)
        print(f"    {idx}. {f.name} ({sz:.1f} MB)")
    print("-" * 80)

    t_start = time.time()
    print("[*] Initializing TranscriptionPipeline (faster-whisper Large-v3, sequential batch_size=1, contemplative VAD)...")
    pipeline = TranscriptionPipeline(device="cuda:0", model_size="large-v3", batch_size=1)
    print("[✓] Pipeline initialized and ready on GPU.\n")

    results = []

    for idx, f in enumerate(target_files, 1):
        print("=" * 80)
        print(f"[{idx}/{len(target_files)}] Transcribing: {f.name}")
        print("=" * 80)
        t0 = time.time()
        try:
            res = pipeline.process_file(audio_path=f)
            elapsed = time.time() - t0
            turns = res.get("turns_count", 0)
            ep_id = res.get("episode_id", f.stem)
            
            # Count generated words from binary sidecar
            bin_path = PROJECT_ROOT / "deeper_dhamma" / "web" / "static" / "words" / f"{ep_id}.bin"
            word_count = 0
            if bin_path.exists():
                import struct
                buf = bin_path.read_bytes()
                if len(buf) >= 4:
                    word_count = struct.unpack("<I", buf[:4])[0]

            print(f"[✓] [{idx}/{len(target_files)}] Completed {f.name} in {elapsed:.1f}s | {turns} turns | {word_count:,} words")
            results.append({
                "file": f.name,
                "episode_id": ep_id,
                "turns": turns,
                "words": word_count,
                "elapsed_sec": round(elapsed, 1),
                "status": "SUCCESS",
            })
        except Exception as e:
            elapsed = time.time() - t0
            print(f"[!] [{idx}/{len(target_files)}] Failed {f.name} after {elapsed:.1f}s: {e}")
            results.append({
                "file": f.name,
                "episode_id": f.stem,
                "turns": 0,
                "words": 0,
                "elapsed_sec": round(elapsed, 1),
                "status": f"ERROR: {e}",
            })

    total_time = time.time() - t_start

    print("\n" + "=" * 80)
    print("RE-TRANSCRIPTION SUMMARY")
    print("=" * 80)
    print(f"{'#':<3} | {'Episode File':<45} | {'Turns':<6} | {'Words':<8} | {'Time (s)':<8} | {'Status'}")
    print("-" * 80)
    total_words = 0
    total_turns = 0
    for idx, r in enumerate(results, 1):
        total_words += r["words"]
        total_turns += r["turns"]
        print(f"{idx:<3} | {r['file'][:45]:<45} | {r['turns']:<6} | {r['words']:<8,} | {r['elapsed_sec']:<8.1f} | {r['status']}")
    print("-" * 80)
    print(f"Total Audio Files:   {len(results)}")
    print(f"Total Speech Turns:  {total_turns:,}")
    print(f"Total Words Synced:  {total_words:,}")
    print(f"Total Elapsed Time:  {total_time/60:.1f} minutes ({total_time:.1f}s)")
    print("=" * 80)

    print("\n[*] Recompiling static distribution and dhamma_web.db...")
    export_static_site(PROJECT_ROOT / "dist")
    print("[✓] Static site and SQLite WASM database updated successfully!")

if __name__ == "__main__":
    main()
