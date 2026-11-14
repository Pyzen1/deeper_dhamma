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

from deeper_dhamma.audio import (
    get_audio_info,
    measure_decoded_duration_ffmpeg,
    verify_ffmpeg_decode,
)
from deeper_dhamma.config import ARCHIVE_DIR, LOGS_DIR, TRANSCRIPTS_DB_PATH

logger = logging.getLogger("deeper_dhamma_audit")


def probe_single_file(
    file_path: Path,
    archive_dir: Path,
    deep_probe: bool = True,
    verify_decode: bool = False,
) -> Optional[Dict[str, Any]]:
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

        if verify_decode:
            decode_res = verify_ffmpeg_decode(file_path)
            if not decode_res["ok"]:
                errs = decode_res.get("errors") or [f"ffmpeg exited with code {decode_res['returncode']}"]
                return {
                    "path": rel_path,
                    "full_path": str(file_path),
                    "issue": "ffmpeg_decode_error",
                    "size": size,
                    "details": "; ".join(errs[:3]),
                    "can_delete": False,
                    "description": f"FFmpeg audio decode error: {errs[0]}",
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
    verify_decode: bool = False,
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
        futures = {
            executor.submit(probe_single_file, f, archive_path, deep_probe, verify_decode): f
            for f in all_files
        }
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
                    # If this file had a recorded failure in the database, clear it since the defect is now resolved
                    try:
                        from deeper_dhamma.storage import TranscriptDatabase
                        tdb = TranscriptDatabase()
                        if tdb.get_error(fp.stem):
                            tdb.clear_error(fp.stem)
                    except Exception:
                        pass
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


def audit_database_transcripts(
    db_path: Path | str = TRANSCRIPTS_DB_PATH,
    archive_dir: Path | str = ARCHIVE_DIR,
    check_durations: bool = True,
    pipeline_db_path: Optional[Path | str] = None,
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """
    Audits all transcribed episodes in dhamma_transcripts.db for:
    1. Word-timing BLOB vs whitespace token 1:1 parity (`word_sync_mismatch`).
    2. Early truncation where DB duration falls >15s short of true decoded PCM audio (`duration_truncation`).

    Returns `(issues, checked_episode_ids)`.
    """
    from deeper_dhamma.postprocess import count_words_in_blob
    from deeper_dhamma.storage import TranscriptDatabase

    db_file = Path(db_path)
    if not db_file.exists():
        return [], []

    tdb = TranscriptDatabase(db_path=db_file, pipeline_db_path=pipeline_db_path)
    fp_map = tdb.pipeline_db.get_filepath_map()
    archive_path = Path(archive_dir).resolve() if archive_dir else None
    issues: List[Dict[str, Any]] = []
    checked_uids: List[str] = []

    with tdb._get_connection() as conn:
        episodes = conn.execute(
            "SELECT id, title, duration_sec FROM episodes WHERE is_transcribed = 1 ORDER BY id ASC;"
        ).fetchall()
        token_counts: Dict[str, int] = {}
        seg_rows = conn.execute("SELECT episode_id, text FROM speech_segments;").fetchall()
        for r in seg_rows:
            eid = r["episode_id"]
            token_counts[eid] = token_counts.get(eid, 0) + len((r["text"] or "").split())

        blob_counts: Dict[str, int] = {}
        for r in conn.execute("SELECT episode_id, words_blob FROM episode_words;").fetchall():
            blob_counts[r["episode_id"]] = count_words_in_blob(r["words_blob"])

    for ep in episodes:
        ep_id = ep["id"]
        title = ep["title"] or ep_id
        db_dur = float(ep["duration_sec"] or 0.0)
        checked_uids.append(ep_id)
        tok_cnt = token_counts.get(ep_id, 0)
        blob_cnt = blob_counts.get(ep_id)

        audio_fp_str = fp_map.get(ep_id)
        audio_fp = Path(audio_fp_str) if audio_fp_str else None
        if audio_fp and not audio_fp.exists():
            audio_fp = None
        if audio_fp is None and archive_path and archive_path.exists():
            resolved_fp, _ = tdb.resolve_audio_path(ep_id, archive_dir=archive_path)
            audio_fp = resolved_fp if resolved_fp and resolved_fp.exists() else None

        rel_display = (
            str(audio_fp.relative_to(archive_path))
            if audio_fp and archive_path and audio_fp.resolve().is_relative_to(archive_path)
            else (str(audio_fp) if audio_fp else ep_id)
        )

        if blob_cnt is not None and blob_cnt != tok_cnt:
            issues.append({
                "path": rel_display,
                "full_path": str(audio_fp) if audio_fp else "",
                "episode_id": ep_id,
                "title": title,
                "issue": "word_sync_mismatch",
                "size": audio_fp.stat().st_size if audio_fp and audio_fp.exists() else 0,
                "blob_words": blob_cnt,
                "token_count": tok_cnt,
                "can_delete": False,
                "description": f"Word BLOB count ({blob_cnt}) != transcript token count ({tok_cnt})",
            })

        if check_durations and audio_fp and audio_fp.exists():
            try:
                info = get_audio_info(audio_fp)
                probe_dur = float(info.get("duration") or 0.0)
                if probe_dur > 30.0 and db_dur < probe_dur - 15.0:
                    true_dur, _ = measure_decoded_duration_ffmpeg(audio_fp)
                    if true_dur > 30.0 and db_dur < true_dur - 15.0:
                        issues.append({
                            "path": rel_display,
                            "full_path": str(audio_fp),
                            "episode_id": ep_id,
                            "title": title,
                            "issue": "duration_truncation",
                            "size": audio_fp.stat().st_size,
                            "db_duration_sec": round(db_dur, 2),
                            "decoded_duration_sec": round(true_dur, 2),
                            "can_delete": False,
                            "description": (
                                f"Transcript duration ({db_dur:.1f}s) truncated vs decoded PCM ({true_dur:.1f}s)"
                            ),
                        })
            except Exception as exc:
                logger.debug("Duration verification skipped for %s: %s", ep_id, exc)

    return issues, checked_uids


def sync_audit_results_to_db(
    issues: List[Dict[str, Any]],
    checked_identifiers: Optional[List[str]] = None,
    checked_decode_ids: Optional[List[str]] = None,
    checked_db_ids: Optional[List[str]] = None,
    db_path: Path | str = TRANSCRIPTS_DB_PATH,
    pipeline_db_path: Optional[Path | str] = None,
) -> Dict[str, int]:
    """
    Tracks audit issues in pipeline_state.db (`operation='audit'`) and clears prior audit
    errors for files/episodes that verified clean in the corresponding audit scope. Never clears download 404s.
    """
    from deeper_dhamma.storage import TranscriptDatabase

    tdb = TranscriptDatabase(db_path=db_path, pipeline_db_path=pipeline_db_path)
    recorded = 0
    cleared = 0
    flagged_ids = set()

    for iss in issues:
        full_path = iss.get("full_path") or ""
        stem = Path(full_path).stem if full_path else ""
        uid = iss.get("episode_id") or (tdb.pipeline_db.resolve_episode_uid(stem) if stem else None) or stem or iss.get("path", "")
        if not uid:
            continue
        flagged_ids.add(uid)
        if stem:
            flagged_ids.add(stem)
        tdb.record_error(
            episode_id=uid,
            error_message=iss.get("description") or iss.get("issue") or "Audit check failed",
            operation="audit",
            filepath=full_path or None,
            title=iss.get("title") or uid,
            error_code=iss.get("issue"),
        )
        recorded += 1

    db_issue_codes = {"word_sync_mismatch", "duration_truncation"}
    checked_file_set = set(checked_identifiers or [])
    checked_decode_set = set(checked_decode_ids or [])
    checked_db_set = set(checked_db_ids or [])
    if checked_file_set or checked_decode_set or checked_db_set:
        active_hist = {
            h["episode_uid"]: h.get("error_code")
            for h in tdb.list_error_history(status="active", operation="audit")
        }
        for err_row in tdb.list_errors(operation="audit"):
            uid = err_row["id"]
            fp = err_row.get("filepath") or ""
            stem = Path(fp).stem if fp else ""
            if uid in flagged_ids or (stem and stem in flagged_ids):
                continue
            code = active_hist.get(uid) or ""
            if code in db_issue_codes:
                in_scope = uid in checked_db_set or (stem and stem in checked_db_set)
            elif code == "ffmpeg_decode_error":
                in_scope = uid in checked_decode_set or (stem and stem in checked_decode_set)
            else:
                in_scope = uid in checked_file_set or (stem and stem in checked_file_set)
            if in_scope:
                tdb.clear_error(uid, resolution="audit_verified_clean", operation="audit")
                cleared += 1

    return {"recorded": recorded, "cleared": cleared}


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
