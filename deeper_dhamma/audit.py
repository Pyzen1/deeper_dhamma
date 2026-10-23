"""
Audio Archive Inspection, Integrity Auditing, and Scrubbing Engine for BSWA Deeper Dhamma.

Scans the local audio archive for:
1. 0-byte ghost files and transient fragments (.part, .temp, .aria2, .ytdl).
2. HTML error pages accidentally downloaded as audio.
3. Stream decodability and audio stream integrity via ffprobe.
4. Container / codec mismatches (e.g. AAC streams inside .mp3 containers).
5. Corrupted cover art images and malformed embedded ID3 streams.
"""

import concurrent.futures
import json
import logging
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

from deeper_dhamma.config import ARCHIVE_DIR, LOGS_DIR

logger = logging.getLogger("deeper_dhamma_audit")


def probe_single_file(file_path: Path, archive_dir: Path, deep_probe: bool = True) -> Optional[Dict[str, Any]]:
    """Inspects a single file on disk and returns an issue dict if anomalous, else None."""
    try:
        stat = file_path.stat()
    except OSError as e:
        return {"path": str(file_path), "issue": "access_error", "details": str(e), "size": 0}

    size = stat.st_size
    rel_path = str(file_path.relative_to(archive_dir))
    suffix = file_path.suffix.lower()

    # 1. Check for 0-byte ghost files
    if size == 0:
        return {
            "path": rel_path,
            "full_path": str(file_path),
            "issue": "zero_byte_ghost",
            "size": 0,
            "can_delete": True,
            "description": "Empty 0-byte ghost file",
        }

    # 2. Check for temporary fragments
    if suffix in (".temp", ".part", ".aria2", ".ytdl") or ".temp." in file_path.name or ".tmp_embed." in file_path.name:
        return {
            "path": rel_path,
            "full_path": str(file_path),
            "issue": "temp_fragment",
            "size": size,
            "can_delete": True,
            "description": "Unfinished transient download fragment",
        }

    # If it is an image file (cover art thumbnail)
    if suffix in (".jpg", ".jpeg", ".png", ".webp"):
        if size < 200:
            return {
                "path": rel_path,
                "full_path": str(file_path),
                "issue": "corrupt_thumbnail",
                "size": size,
                "can_delete": True,
                "description": f"Suspiciously tiny thumbnail image ({size} bytes)",
            }
        return None

    # Only deep-probe audio files (.mp3, .m4a)
    if suffix not in (".mp3", ".m4a"):
        return None

    # 3. Check for HTML error pages masquerading as audio
    if size < 100 * 1024:
        try:
            with open(file_path, "rb") as f:
                header = f.read(512)
            if b"<html" in header.lower() or b"<!doctype" in header.lower() or b"error?msg=" in header.lower():
                return {
                    "path": rel_path,
                    "full_path": str(file_path),
                    "issue": "html_error_page",
                    "size": size,
                    "can_delete": True,
                    "description": "HTML 404/error page saved with audio extension",
                }
        except OSError:
            pass

    if not deep_probe:
        return None

    # 4. Deep ffprobe stream and container validation
    cmd = [
        "ffprobe",
        "-v", "error",
        "-show_entries", "stream=index,codec_type,codec_name,duration:format=duration,size,format_name",
        "-of", "json",
        str(file_path),
    ]

    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        if res.returncode != 0:
            stderr_msg = res.stderr.strip().splitlines()[-1] if res.stderr else "Unknown ffprobe error"
            return {
                "path": rel_path,
                "full_path": str(file_path),
                "issue": "unreadable_audio",
                "size": size,
                "details": stderr_msg,
                "can_delete": False,
                "description": f"ffprobe could not parse audio stream: {stderr_msg}",
            }

        probe_data = json.loads(res.stdout or "{}")
        streams = probe_data.get("streams", [])
        audio_streams = [s for s in streams if s.get("codec_type") == "audio"]
        if not audio_streams:
            return {
                "path": rel_path,
                "full_path": str(file_path),
                "issue": "no_audio_stream",
                "size": size,
                "can_delete": False,
                "description": "File contains no audio stream",
            }

        codec = audio_streams[0].get("codec_name", "").lower()
        format_name = probe_data.get("format", {}).get("format_name", "").lower()

        # Check for container / extension mismatches
        if suffix == ".mp3" and codec == "aac":
            return {
                "path": rel_path,
                "full_path": str(file_path),
                "issue": "aac_in_mp3",
                "size": size,
                "codec": codec,
                "format_name": format_name,
                "can_delete": False,
                "can_rename_m4a": True,
                "description": "AAC audio stream packaged inside .mp3 container/extension",
            }

    except subprocess.TimeoutExpired:
        return {
            "path": rel_path,
            "full_path": str(file_path),
            "issue": "probe_timeout",
            "size": size,
            "can_delete": False,
            "description": "ffprobe timed out after 20 seconds",
        }
    except Exception as e:
        return {
            "path": rel_path,
            "full_path": str(file_path),
            "issue": "probe_exception",
            "size": size,
            "details": str(e),
            "can_delete": False,
            "description": f"Internal probe error: {e}",
        }

    return None


def scan_archive(
    archive_dir: Path | str = ARCHIVE_DIR,
    workers: int = 8,
    deep_probe: bool = True,
    progress: bool = True,
) -> List[Dict[str, Any]]:
    """Scans all files under archive_dir concurrently and collects any integrity issues."""
    archive_path = Path(archive_dir).resolve()
    if not archive_path.exists():
        print(f"[-] Archive directory not found: {archive_path}")
        return []

    all_files = [f for f in archive_path.rglob("*") if f.is_file()]
    total_files = len(all_files)
    if total_files == 0:
        return []

    issues: List[Dict[str, Any]] = []
    done_count = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        futures = {executor.submit(probe_single_file, f, archive_path, deep_probe): f for f in all_files}
        for fut in concurrent.futures.as_completed(futures):
            done_count += 1
            if progress and (done_count % 100 == 0 or done_count == total_files):
                pct = (done_count / total_files) * 100
                sys.stdout.write(f"\r[*] Auditing archive files: {done_count}/{total_files} ({pct:.1f}%) ...")
                sys.stdout.flush()

            res = fut.result()
            if res:
                issues.append(res)

    if progress:
        sys.stdout.write("\r" + " " * 80 + "\r")
        sys.stdout.flush()

    return issues


def clean_archive(
    issues: List[Dict[str, Any]],
    dry_run: bool = True,
    delete_ghosts: bool = True,
    fix_extensions: bool = False,
    log: Optional[logging.Logger] = None,
) -> Dict[str, int]:
    """Applies scrubbing / cleaning operations on detected issues."""
    counts = {
        "deleted_ghosts": 0,
        "deleted_fragments": 0,
        "deleted_html_errors": 0,
        "renamed_extensions": 0,
        "skipped": 0,
    }

    for issue in issues:
        fp = Path(issue.get("full_path", ""))
        issue_type = issue.get("issue")

        # 1. Delete 0-byte ghost files or temporary fragments
        if delete_ghosts and issue.get("can_delete") and fp.exists():
            if dry_run:
                if log:
                    log.info(f"[DRY-RUN] Would delete: {issue['path']} ({issue['description']})")
                if issue_type == "zero_byte_ghost":
                    counts["deleted_ghosts"] += 1
                elif issue_type == "temp_fragment":
                    counts["deleted_fragments"] += 1
                elif issue_type == "html_error_page":
                    counts["deleted_html_errors"] += 1
            else:
                try:
                    fp.unlink()
                    if issue_type == "zero_byte_ghost":
                        counts["deleted_ghosts"] += 1
                    elif issue_type == "temp_fragment":
                        counts["deleted_fragments"] += 1
                    elif issue_type == "html_error_page":
                        counts["deleted_html_errors"] += 1
                    if log:
                        log.info(f"[✓] Deleted {issue_type}: {issue['path']}")
                except OSError as e:
                    if log:
                        log.error(f"[!] Could not delete {issue['path']}: {e}")

        # 2. Fix container extension mismatch (AAC stream in .mp3 -> .m4a)
        elif fix_extensions and issue.get("can_rename_m4a") and fp.exists():
            new_path = fp.with_suffix(".m4a")
            if dry_run:
                if log:
                    log.info(f"[DRY-RUN] Would rename {fp.name} -> {new_path.name}")
                counts["renamed_extensions"] += 1
            else:
                try:
                    os.replace(fp, new_path)
                    counts["renamed_extensions"] += 1
                    if log:
                        log.info(f"[↻] Renamed {fp.name} -> {new_path.name}")
                except OSError as e:
                    if log:
                        log.error(f"[!] Could not rename {fp.name}: {e}")
        else:
            counts["skipped"] += 1

    return counts


def print_audit_report(issues: List[Dict[str, Any]], total_scanned: int, elapsed_sec: float) -> None:
    """Renders a formatted audit report to stdout."""
    print("=" * 80)
    print("BSWA Deeper Dhamma: Archive Integrity & Health Audit Report")
    print("=" * 80)
    print(f"[*] Scanned Files:     {total_scanned:,} files in {elapsed_sec:.1f}s")
    print(f"[*] Issues Detected:   {len(issues)}")
    print("-" * 80)

    if not issues:
        print("[✓] Perfect Archive Health: No corrupted, 0-byte, or invalid audio files found.")
        print("=" * 80)
        return

    # Categorize issues
    categories: Dict[str, List[Dict[str, Any]]] = {}
    for iss in issues:
        cat = iss["issue"]
        categories.setdefault(cat, []).append(iss)

    for cat_name, cat_items in sorted(categories.items()):
        print(f"\n[!] Category: {cat_name.upper()} ({len(cat_items)} item(s)):")
        for idx, item in enumerate(cat_items[:15], 1):
            size_str = f"{item.get('size', 0):,} bytes"
            print(f"  {idx:>2}. {item['path']} ({size_str}) - {item['description']}")
        if len(cat_items) > 15:
            print(f"  ... and {len(cat_items) - 15} more item(s).")

    print("\n" + "=" * 80)
    print("Recommended Action:")
    print("  Clean ghost/fragment files automatically:")
    print("  -> python main.py audit --clean")
    print("=" * 80)
