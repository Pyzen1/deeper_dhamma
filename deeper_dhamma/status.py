"""
Transcription Progress & Audio Catalog Availability Reporter for BSWA Deeper Dhamma.

Calculates and formats real-time metrics across:
1. Podcast Catalog (catalog.json - published episodes on Podbean)
2. Local Audio Archive (archive/ - downloaded MP3 and M4A files and archive.log)
3. Canonical Transcripts Warehouse (dhamma_transcripts.db - SQLite & FTS5 search)
"""

import json
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from deeper_dhamma.config import ARCHIVE_DIR, CATALOG_PATH, ARCHIVE_LOG_PATH, TRANSCRIPTS_DB_PATH
from deeper_dhamma.catalog import (
    determine_era,
    identify_primary_teacher,
    clean_slug,
    parse_episode_metadata,
    is_english_talk,
    ERA_ANALOG,
    ERA_EARLY_DIGITAL,
    ERA_HIGH_DEF,
)


def format_duration_hhmmss(seconds: float) -> str:
    """Formats seconds into readable string (e.g. 1h 24m 12s or 5m 30s)."""
    hrs = int(seconds // 3600)
    mins = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    if hrs > 0:
        return f"{hrs}h {mins:02d}m {secs:02d}s"
    elif mins > 0:
        return f"{mins}m {secs:02d}s"
    return f"{secs}s"


def make_progress_bar(completed: int, total: int, width: int = 15) -> str:
    """Renders a text progress bar."""
    if total <= 0:
        return "[" + "." * width + "]   0.0%"
    pct = min(100.0, max(0.0, (completed / total) * 100))
    filled = int(round((pct / 100) * width))
    bar = "=" * filled + "." * (width - filled)
    return f"[{bar}] {pct:5.1f}%"


def collect_status(
    archive_dir: Path = ARCHIVE_DIR,
    db_path: Path = TRANSCRIPTS_DB_PATH,
    catalog_path: Path = CATALOG_PATH,
    archive_log_path: Path = ARCHIVE_LOG_PATH,
    year_filter: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Collects comprehensive statistics across catalog, archive, and database,
    strictly aligned with deeper_dhamma.catalog matching logic.
    """
    # ---------------------------------------------------------
    # 1. Read archive.log (records completed downloads)
    # ---------------------------------------------------------
    archive_entries: Set[str] = set()
    if archive_log_path.exists():
        try:
            with open(archive_log_path, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    parts = line.strip().split()
                    if len(parts) >= 2:
                        archive_entries.add(parts[1])
                    elif parts:
                        archive_entries.add(parts[0])
        except Exception:
            pass

    # ---------------------------------------------------------
    # 2. Database Analysis (dhamma_transcripts.db)
    # ---------------------------------------------------------
    db_episodes = []
    total_db_duration = 0.0
    total_db_segments = 0
    transcribed_stems: Set[str] = set()
    transcribed_years = Counter()
    transcribed_teachers = Counter()
    transcribed_eras = Counter()

    db_resolved_teachers: Dict[str, str] = {}
    db_errors: List[Dict[str, Any]] = []
    error_years = Counter()

    if db_path.exists():
        try:
            from deeper_dhamma.storage import TranscriptDatabase
            tdb = TranscriptDatabase(db_path=db_path)
            pipeline_db = tdb.pipeline_db
            fp_map = pipeline_db.get_filepath_map()

            conn = sqlite3.connect(str(db_path))
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                "SELECT id, title, year, date, primary_teacher, primary_display, duration_sec FROM episodes WHERE is_transcribed = 1 ORDER BY date ASC;"
            ).fetchall()
            db_episodes = [dict(r) for r in rows]
            for ep in db_episodes:
                ep["filepath"] = fp_map.get(ep["id"])

            res_rows = conn.execute(
                "SELECT id, title, primary_display FROM episodes WHERE primary_teacher != 'unknown_teacher' AND primary_display IS NOT NULL;"
            ).fetchall()
            for r in res_rows:
                disp = r["primary_display"]
                db_resolved_teachers[r["id"]] = disp
                db_resolved_teachers[clean_slug(r["id"])] = disp
                fp = fp_map.get(r["id"])
                if fp:
                    fp_stem = Path(fp).stem
                    db_resolved_teachers[fp_stem] = disp
                    db_resolved_teachers[clean_slug(fp_stem)] = disp
                if r["title"]:
                    db_resolved_teachers[clean_slug(r["title"])] = disp

            cur = conn.execute("SELECT COUNT(*) FROM speech_segments;")
            seg_row = cur.fetchone()
            if seg_row:
                total_db_segments = seg_row[0]

            ep_year_map = {
                r["id"]: r["year"]
                for r in conn.execute("SELECT id, year FROM episodes;").fetchall()
            }
            conn.close()

            error_years = Counter()
            for ed in pipeline_db.list_errors():
                ey = ep_year_map.get(ed["id"], 0) or 0
                ed["year"] = ey
                if not ey and ed.get("filepath"):
                    for part in Path(ed["filepath"]).parts:
                        if part.isdigit() and len(part) == 4:
                            ey = int(part)
                            ed["year"] = ey
                            break
                if year_filter is None or ey == year_filter:
                    db_errors.append(ed)
                    if ey:
                        error_years[ey] += 1

            for ep in db_episodes:
                ep_id = ep["id"]
                transcribed_stems.add(ep_id)
                if ep.get("filepath"):
                    transcribed_stems.add(Path(ep["filepath"]).stem)
                if ep.get("title"):
                    _, _, fn_stem = parse_episode_metadata(ep["title"], "")
                    if fn_stem:
                        transcribed_stems.add(fn_stem)
                y = ep.get("year", 0)
                if year_filter is None or y == year_filter:
                    total_db_duration += float(ep.get("duration_sec", 0.0))
                    transcribed_years[y] += 1
                    teacher_name = ep.get("primary_display") or "Unknown"
                    transcribed_teachers[teacher_name] += 1
                    era = determine_era(y if y > 0 else 2010)
                    transcribed_eras[era] += 1
        except Exception:
            pass

    # ---------------------------------------------------------
    # 3. Audio Archive Files on Disk (MP3 + M4A)
    # ---------------------------------------------------------
    all_disk_files = []
    archive_disk_bytes = 0
    mp3_count = 0
    m4a_count = 0

    if archive_dir.exists():
        for p in archive_dir.rglob("*"):
            if not p.is_file():
                continue
            if p.name.endswith(".temp.mp3") or p.name.endswith(".temp.m4a"):
                continue
            suffix = p.suffix.lower()
            if suffix in (".mp3", ".m4a"):
                all_disk_files.append(p)
                try:
                    archive_disk_bytes += p.stat().st_size
                except OSError:
                    pass
                if suffix == ".mp3":
                    mp3_count += 1
                else:
                    m4a_count += 1

    # Stems on disk for fast lookup
    disk_file_stems = {f.stem for f in all_disk_files}

    # Transcribed archive files on disk vs pending transcription on disk
    archive_files_transcribed = []
    archive_files_pending_transcription = []

    for f in all_disk_files:
        rel = f.relative_to(archive_dir)
        year_cand = None
        for part in rel.parts:
            if part.isdigit() and len(part) == 4:
                year_cand = int(part)
                break
        if not year_cand:
            year_cand_str, _, _ = parse_episode_metadata(f.name, "")
            year_cand = int(year_cand_str) if str(year_cand_str).isdigit() else 2000

        if year_filter is not None and year_cand != year_filter:
            continue

        _, teacher_display = identify_primary_teacher(f.name)
        if teacher_display == "Unknown Teacher":
            clean_fn = clean_slug(f.stem)
            for cand in [f.stem, clean_fn]:
                if cand in db_resolved_teachers:
                    teacher_display = db_resolved_teachers[cand]
                    break
        if f.stem in transcribed_stems:
            archive_files_transcribed.append({"path": f, "year": year_cand, "teacher": teacher_display})
        else:
            archive_files_pending_transcription.append({"path": f, "year": year_cand, "teacher": teacher_display})

    # ---------------------------------------------------------
    # 4. Catalog Analysis & Sync Matching (aligned with sync script)
    # ---------------------------------------------------------
    catalog_items = []
    cat_by_id = {}
    cat_by_stem = {}
    total_raw_catalog = 0
    english_in_scope_total = 0
    non_english_total = 0

    cat_years = Counter()
    synced_years = Counter()
    pending_download_years = Counter()
    cat_teachers = Counter()
    synced_teachers = Counter()
    cat_eras = Counter()

    pending_download_episodes = []

    if catalog_path.exists():
        try:
            with open(catalog_path, "r", encoding="utf-8") as f:
                catalog_items = json.load(f)
            total_raw_catalog = len(catalog_items)

            for ep in catalog_items:
                ep_id = ep.get("id", "")
                cat_by_id[ep_id] = ep
                title = ep.get("title", "")
                upload_date = ep.get("upload_date", "")

                year_str, series_slug, filename = parse_episode_metadata(title, upload_date)
                y = int(year_str) if str(year_str).isdigit() else 2000
                cat_by_stem[filename] = ep
                cat_by_stem[ep_id] = ep

                # Check language
                is_eng = is_english_talk(title)
                if not is_eng:
                    non_english_total += 1
                    continue

                english_in_scope_total += 1

                if year_filter is not None and y != year_filter:
                    continue

                cat_years[y] += 1
                _, teacher_display = identify_primary_teacher(title)
                if teacher_display == "Unknown Teacher":
                    clean_t = clean_slug(title)
                    clean_fn = clean_slug(filename)
                    for cand in [filename, clean_fn, ep_id, clean_t]:
                        if cand in db_resolved_teachers:
                            teacher_display = db_resolved_teachers[cand]
                            break
                    if teacher_display == "Unknown Teacher":
                        for s, disp in db_resolved_teachers.items():
                            if (clean_fn and len(clean_fn) > 15 and (clean_fn in s or s in clean_fn)) or \
                               (clean_t and len(clean_t) > 15 and (clean_t in s or s in clean_t)):
                                teacher_display = disp
                                break
                cat_teachers[teacher_display] += 1
                era = determine_era(y)
                cat_eras[era] += 1

                # Check if downloaded or in archive.log
                dest_mp3 = archive_dir / year_str / series_slug / f"{filename}.mp3"
                dest_m4a = archive_dir / year_str / series_slug / f"{filename}.m4a"
                file_exists = (
                    (dest_mp3.exists() and dest_mp3.stat().st_size > 1024 * 1024)
                    or (dest_m4a.exists() and dest_m4a.stat().st_size > 1024 * 1024)
                )

                media_url = ep.get("media_url") or ""
                url_stem = Path(media_url.split("?")[0]).stem if media_url else ""
                guid_match = any(e in archive_entries for e in [ep_id, media_url, url_stem, filename] if e)

                if file_exists or guid_match:
                    synced_years[y] += 1
                    synced_teachers[teacher_display] += 1
                else:
                    pending_download_years[y] += 1
                    pending_download_episodes.append({
                        "id": ep_id,
                        "title": title,
                        "year": y,
                        "series": series_slug,
                        "filename": filename,
                        "teacher": teacher_display,
                    })
        except Exception:
            pass

    # All years active
    all_years = sorted(list(set(cat_years.keys()) | set(transcribed_years.keys())))
    if 0 in all_years:
        all_years.remove(0)

    # All teachers active
    all_teachers = sorted(
        list(set(cat_teachers.keys()) | set(synced_teachers.keys())),
        key=lambda t: (synced_teachers[t], cat_teachers[t]),
        reverse=True,
    )

    total_synced = sum(synced_years.values())
    total_pending_dl = sum(pending_download_years.values())
    total_in_scope = sum(cat_years.values())

    return {
        "catalog": {
            "total_raw": total_raw_catalog,
            "total_in_scope": total_in_scope,
            "non_english": non_english_total,
            "synced_count": total_synced,
            "pending_download_count": total_pending_dl,
            "pending_download_episodes": pending_download_episodes,
            "by_year": dict(cat_years),
            "synced_by_year": dict(synced_years),
            "pending_by_year": dict(pending_download_years),
            "by_teacher": dict(cat_teachers),
            "synced_by_teacher": dict(synced_teachers),
            "by_era": dict(cat_eras),
        },
        "archive_disk": {
            "total_files": len(all_disk_files),
            "mp3_files": mp3_count,
            "m4a_files": m4a_count,
            "total_bytes": archive_disk_bytes,
            "transcribed_on_disk": len(archive_files_transcribed),
            "pending_transcription_on_disk": len(archive_files_pending_transcription),
            "pending_files": archive_files_pending_transcription,
            "transcribed_files": archive_files_transcribed,
        },
        "transcripts": {
            "records_count": len(db_episodes),
            "total_duration_sec": total_db_duration,
            "total_segments": total_db_segments,
            "by_year": dict(transcribed_years),
            "by_teacher": dict(transcribed_teachers),
            "by_era": dict(transcribed_eras),
            "episodes": db_episodes,
        },
        "all_years": all_years,
        "all_teachers": all_teachers,
        "year_filter": year_filter,
        "errors": db_errors,
        "errors_count": len(db_errors),
        "errors_by_year": dict(error_years),
    }


def print_summary(data: Dict[str, Any]) -> None:
    """Prints the executive status summary and progress meters."""
    cat = data["catalog"]
    arch = data["archive_disk"]
    tr = data["transcripts"]
    yf = data["year_filter"]

    year_label = f" (Year {yf})" if yf else ""
    arch_gb = arch["total_bytes"] / (1024 ** 3)
    dur_str = format_duration_hhmmss(tr["total_duration_sec"])

    sync_bar = make_progress_bar(cat["synced_count"], cat["total_in_scope"], width=18)
    tr_bar = make_progress_bar(arch["transcribed_on_disk"], arch["total_files"], width=18)

    print("=" * 80)
    print(f"BSWA Deeper Dhamma: Transcription Progress & Archive Status{year_label}")
    print("=" * 80)
    print("Podcast Catalog & Audio Archive Sync:")
    print(f"  - Feed Catalog Total:       {cat['total_raw']:,} published talks ({cat['total_in_scope']:,} in scope, {cat['non_english']} non-English)")
    print(f"  - Catalog Sync Status:      {cat['synced_count']:,} / {cat['total_in_scope']:,} synced {sync_bar}")
    print(f"  - Pending Audio Downloads:  {cat['pending_download_count']:,} talks (fetch with: python main.py sync --all)")
    print(f"  - Audio Files on Disk:      {arch['total_files']:,} files ({arch['mp3_files']:,} MP3, {arch['m4a_files']:,} M4A | {arch_gb:.2f} GB)")

    print("\nTranscription & Processing Health:")
    print(f"  - Database Episode Records: {tr['records_count']:,} cataloged in dhamma_transcripts.db")
    print(f"  - Total Transcribed Audio:  {dur_str} ({tr['total_duration_sec']:.1f}s)")
    print(f"  - Indexed Speech Segments:  {tr['total_segments']:,} turns (zero-copy SQLite FTS5 index)")
    print(f"  - Disk Archive Coverage:    {arch['transcribed_on_disk']:,} / {arch['total_files']:,} talks transcribed {tr_bar}")
    print(f"  - Ready for Transcription:  {arch['pending_transcription_on_disk']:,} audio talks available on disk")
    err_count = data.get("errors_count", len(data.get("errors", [])))
    if err_count > 0:
        print(f"  - Files with Active Errors: {err_count:,} file(s) with recorded errors (inspect: python main.py status -e)")
    else:
        print("  - Files with Active Errors: 0 files with errors (all clean)")

    print("-" * 80)
    print("Acoustic Era Distribution (In-Scope Catalog):")
    eras = [
        (ERA_ANALOG, "Analog Era (1997-2003)"),
        (ERA_EARLY_DIGITAL, "Early Digital (2004-2014)"),
        (ERA_HIGH_DEF, "High Definition (2015-2026)"),
    ]
    for era_key, era_label in eras:
        c_cat = cat["by_era"].get(era_key, 0)
        c_tr = tr["by_era"].get(era_key, 0)
        era_bar = make_progress_bar(c_tr, c_cat, width=12)
        print(f"  - {era_label:<28}: {c_cat:>5,} talks | {c_tr:>3,} transcribed {era_bar}")
    print("=" * 80)


def print_year_breakdown(data: Dict[str, Any]) -> None:
    """Prints a structured table of year-by-year transcription, sync progress, and error counts."""
    cat = data["catalog"]
    cat_years = cat["by_year"]
    synced_years = cat["synced_by_year"]
    pending_dl_years = cat["pending_by_year"]
    tr_years = data["transcripts"]["by_year"]
    err_years = data.get("errors_by_year", {})
    years = data["all_years"]

    print("\n" + "=" * 80)
    print("Year-by-Year Sync, Transcription & Error Health")
    print("=" * 80)
    print(f"{'Year':<6} | {'In Scope':<8} | {'Synced':<8} | {'Pending DL':<10} | {'Transcribed':<11} | {'Errors':<6} | {'Status':<10}")
    print("-" * 6 + "-+-" + "-" * 8 + "-+-" + "-" * 8 + "-+-" + "-" * 10 + "-+-" + "-" * 11 + "-+-" + "-" * 6 + "-+-" + "-" * 10)

    tot_cat = 0
    tot_synced = 0
    tot_p_dl = 0
    tot_tr = 0
    tot_err = 0

    for y in years:
        c_cat = cat_years.get(y, 0)
        c_synced = synced_years.get(y, 0)
        c_pdl = pending_dl_years.get(y, 0)
        c_tr = tr_years.get(y, 0)
        c_err = err_years.get(y, 0)

        tot_cat += c_cat
        tot_synced += c_synced
        tot_p_dl += c_pdl
        tot_tr += c_tr
        tot_err += c_err

        # Multi-status flags
        flags = []
        if c_pdl > 0:
            flags.append("P")
        elif c_cat > 0 and c_synced >= c_cat:
            flags.append("D")
        elif c_synced > 0:
            flags.append("D")

        if c_cat > 0 and c_tr >= c_cat:
            flags.append("C")
        elif c_tr > 0:
            flags.append("T")
        else:
            flags.append("U")

        if c_err > 0:
            flags.append("E")

        status_str = ", ".join(flags)
        err_str = str(c_err) if c_err > 0 else "-"
        print(f"{y:<6} | {c_cat:>8,} | {c_synced:>8,} | {c_pdl:>10,} | {c_tr:>11,} | {err_str:>6} | {status_str:<10}")

    print("-" * 6 + "-+-" + "-" * 8 + "-+-" + "-" * 8 + "-+-" + "-" * 10 + "-+-" + "-" * 11 + "-+-" + "-" * 6 + "-+-" + "-" * 10)

    tot_flags = []
    if tot_p_dl > 0:
        tot_flags.append("P")
    elif tot_cat > 0 and tot_synced >= tot_cat:
        tot_flags.append("D")

    if tot_cat > 0 and tot_tr >= tot_cat:
        tot_flags.append("C")
    elif tot_tr > 0:
        tot_flags.append("T")
    else:
        tot_flags.append("U")

    if tot_err > 0:
        tot_flags.append("E")

    tot_status_str = ", ".join(tot_flags)
    tot_err_str = str(tot_err) if tot_err > 0 else "-"
    print(f"{'Total':<6} | {tot_cat:>8,} | {tot_synced:>8,} | {tot_p_dl:>10,} | {tot_tr:>11,} | {tot_err_str:>6} | {tot_status_str:<10}")
    print("=" * 80)
    print("Status Key:")
    print("  D = Downloaded (100% in-scope audio files on disk)")
    print("  P = Pending Download (audio files awaiting download)")
    print("  C = Complete (100% of talks transcribed)")
    print("  T = Partially Transcribed (transcription underway)")
    print("  U = Untranscribed (no talks transcribed yet)")
    print("  E = Error (one or more active file errors recorded)")
    print("=" * 80)


def print_teacher_breakdown(data: Dict[str, Any], limit: Optional[int] = None) -> None:
    """Prints a breakdown of talks by monastic teacher."""
    cat = data["catalog"]
    cat_t = cat["by_teacher"]
    synced_t = cat["synced_by_teacher"]
    tr_t = data["transcripts"]["by_teacher"]
    teachers = data["all_teachers"][:limit] if limit is not None else data["all_teachers"]

    print("\n" + "=" * 80)
    print(f"Catalog & Archive Coverage by Teacher ({len(teachers)} Monastic Teachers)")
    print("=" * 80)
    print(f"{'Monastic Teacher':<28} | {'In Scope':<8} | {'Synced':<8} | {'Transcribed':<11} | {'Sync %':<9}")
    print("-" * 28 + "-+-" + "-" * 8 + "-+-" + "-" * 8 + "-+-" + "-" * 11 + "-+-" + "-" * 9)

    tot_cat = 0
    tot_synced = 0
    tot_tr = 0

    for teacher in teachers:
        c_cat = cat_t.get(teacher, 0)
        c_synced = synced_t.get(teacher, 0)
        c_tr = tr_t.get(teacher, 0)
        pct = (c_synced / c_cat * 100) if c_cat else 0
        tot_cat += c_cat
        tot_synced += c_synced
        tot_tr += c_tr
        print(f"{teacher:<28} | {c_cat:>8,} | {c_synced:>8,} | {c_tr:>11,} | {pct:6.1f}%")

    print("-" * 28 + "-+-" + "-" * 8 + "-+-" + "-" * 8 + "-+-" + "-" * 11 + "-+-" + "-" * 9)
    sync_pct = (tot_synced / tot_cat * 100) if tot_cat else 0
    print(f"{'Total':<28} | {tot_cat:>8,} | {tot_synced:>8,} | {tot_tr:>11,} | {sync_pct:6.1f}%")
    print("=" * 80)


def print_pending_files(data: Dict[str, Any], limit: int = 25) -> None:
    """Lists audio files on disk waiting to be transcribed."""
    pending = data["archive_disk"]["pending_files"]
    yf = data["year_filter"]
    year_str = f" for Year {yf}" if yf else ""

    print("\n" + "=" * 80)
    print(f"Archive Audio Files on Disk Awaiting Transcription{year_str} ({len(pending):,} total)")
    print("=" * 80)

    if not pending:
        print("  [✓] All audio files in archive matching the filter have been transcribed!")
        print("=" * 80)
        return

    sample = pending[:limit]
    for idx, item in enumerate(sample, 1):
        rel = item["path"].relative_to(ARCHIVE_DIR)
        print(f"  {idx:>2}. [{item['year']}] {rel.name} ({item['teacher']})")

    if len(pending) > limit:
        print(f"\n  ... and {len(pending) - limit:,} more audio talks available on disk.")

    cmd_sample = f"python main.py transcribe --year {yf}" if yf else "python main.py transcribe --year 2001 --limit 5"
    print(f"\n  -> Transcribe with: {cmd_sample}")
    print("=" * 80)


def print_completed_episodes(data: Dict[str, Any], limit: int = 25) -> None:
    """Lists already transcribed episodes in database."""
    episodes = data["transcripts"]["episodes"]
    yf = data["year_filter"]
    year_str = f" for Year {yf}" if yf else ""

    print("\n" + "=" * 80)
    print(f"Transcribed Episodes in Canonical Database{year_str} ({len(episodes)} total)")
    print("=" * 80)

    if not episodes:
        print("  [-] No episodes transcribed yet matching the filter.")
        print("=" * 80)
        return

    sample = episodes[:limit]
    for idx, ep in enumerate(sample, 1):
        dur_fmt = format_duration_hhmmss(ep.get("duration_sec", 0))
        teacher = ep.get("primary_display") or "Unknown"
        print(f"  {idx:>2}. [{ep.get('date', 'N/A')}] {ep['title']}")
        print(f"      ID: {ep['id']:<35} | Duration: {dur_fmt:<10} | Teacher: {teacher}")

    if len(episodes) > limit:
        print(f"\n  ... and {len(episodes) - limit} more transcribed episodes.")

    print(f"\n  -> Export any episode: python main.py export --id <episode_id> --format md")
    print("=" * 80)


def print_errors(data: Dict[str, Any], limit: int = 25) -> None:
    """Lists archive files with active recorded errors in the database."""
    errors = data.get("errors", [])
    yf = data.get("year_filter")
    year_str = f" for Year {yf}" if yf else ""

    print("\n" + "=" * 80)
    print(f"Active Recorded File / Archive Errors{year_str} ({len(errors):,} total)")
    print("=" * 80)

    if not errors:
        print("  [✓] Clean Health: No errors currently recorded for any archive files!")
        print("=" * 80)
        return

    sample = errors[:limit]
    for idx, err in enumerate(sample, 1):
        op = err.get("last_error_op") or "unknown"
        at = (err.get("last_error_at") or "")[:19]
        title = err.get("title") or err.get("id") or "Untitled"
        msg = err.get("last_error") or "Unknown error"
        # Truncate msg if too long for display
        if len(msg) > 90:
            msg = msg[:87] + "..."
        print(f"  {idx:>2}. [{at}] Operation: {op.upper():<12} | ID: {err['id']}")
        print(f"      Title: {title[:70]}")
        print(f"      Error: {msg}")

    if len(errors) > limit:
        print(f"\n  ... and {len(errors) - limit:,} more recorded errors.")

    print("\n  -> To retry failed operations: python main.py sync --retry-errors")
    print("  -> Or for transcription:      python main.py transcribe --all --retry-errors")
    print("=" * 80)

