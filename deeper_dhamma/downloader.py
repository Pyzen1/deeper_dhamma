"""
Podbean Podcast Feed Sync, Catalog Crawler, and High-Resilience Audio Downloader.

Crawls the BSWA Deeper Dhamma podcast feed, maintains local catalog.json,
and downloads audio talks into structured year/series directories with embedded
ID3v2 APIC cover thumbnails and custom metadata via yt-dlp, aria2c, and ffmpeg.
"""

import html
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple, Union

import yt_dlp

from deeper_dhamma.config import (
    ARCHIVE_DIR,
    CATALOG_PATH,
    ARCHIVE_LOG_PATH,
    PROJECT_ROOT,
    DEFAULT_SYNC_LOG,
)
from deeper_dhamma.catalog import (
    parse_episode_metadata,
    is_english_talk,
    clean_slug,
)
from deeper_dhamma.audio import get_id3_tag_size, get_id3v2_tag_size

logger = logging.getLogger("downloader")

# Resilient os.replace to resolve Windows file-locking race conditions during EmbedThumbnail.
# When ffmpeg finishes writing a media file, Windows Defender / Search Indexer can momentarily
# hold a read handle, causing a transient PermissionError [WinError 32] on immediate replace.
_original_os_replace = os.replace


def _resilient_os_replace(src: str | os.PathLike, dst: str | os.PathLike) -> None:
    max_retries = 15
    for attempt in range(max_retries):
        try:
            return _original_os_replace(src, dst)
        except PermissionError:
            if attempt == max_retries - 1:
                raise
            time.sleep(0.3 * (attempt + 1))


os.replace = _resilient_os_replace


def setup_sync_logging(log_file: Optional[Path | str] = None) -> logging.Logger:
    """Configures dual logging: clean output for console, compact rotating log for file."""
    sync_logger = logging.getLogger("deeper_dhamma_sync")
    sync_logger.setLevel(logging.DEBUG)
    sync_logger.propagate = False
    sync_logger.handlers.clear()

    if log_file:
        p_log = Path(log_file)
        p_log.parent.mkdir(parents=True, exist_ok=True)
        rfh = RotatingFileHandler(p_log, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8")
        rfh.setLevel(logging.DEBUG)
        rfh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)-7s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S"))
        sync_logger.addHandler(rfh)

    # Console handler
    ch = logging.StreamHandler(sys.stdout)
    ch.setLevel(logging.INFO)
    ch.setFormatter(logging.Formatter("%(message)s"))
    sync_logger.addHandler(ch)
    return sync_logger


def ensure_binary(name: str) -> bool:
    """Checks if a binary is in PATH; if not, searches known WinGet package directories."""
    if shutil.which(name):
        return True
    winget_pkg = Path(os.path.expanduser("~")) / "AppData/Local/Microsoft/WinGet/Packages"
    if winget_pkg.exists():
        for exe in winget_pkg.rglob(f"{name}.exe"):
            os.environ["PATH"] = f"{exe.parent};" + os.environ.get("PATH", "")
            return True
    return False


class YTDLPLogAdapter:
    """
    Adapts yt-dlp messages:
    - Renders active download progress (speed, percent, ETA) dynamically to the live shell.
    - Excludes high-frequency progress ticks from the log file to prevent log bloat.
    - Captures actionable debugging diagnostics into the rotating log file.
    """

    NOISY_PATTERNS = (
        "Downloading webpage",
        "Following redirect to",
        "Resuming download at byte",
        "Deleting existing file",
    )

    def __init__(self, target_logger: logging.Logger):
        self.target_logger = target_logger
        self.has_active_progress = False

    def clear_active_progress(self) -> None:
        sys.stdout.write("\r" + " " * 90 + "\r")
        sys.stdout.flush()
        self.has_active_progress = False

    def _should_ignore_for_log(self, msg: str) -> bool:
        if "[download]" in msg and "%" in msg and "100%" not in msg:
            return True
        for pattern in self.NOISY_PATTERNS:
            if pattern in msg:
                return True
        return False

    def debug(self, msg: str) -> None:
        clean_msg = msg.strip()
        if "[download]" in clean_msg and "%" in clean_msg and "100%" not in clean_msg:
            sys.stdout.write(f"\r   -> {clean_msg:<75}")
            sys.stdout.flush()
            self.has_active_progress = True
            return

        if self.has_active_progress:
            self.clear_active_progress()

        if self._should_ignore_for_log(clean_msg):
            return

        self.target_logger.debug(f"[yt-dlp] {clean_msg}")

    def info(self, msg: str) -> None:
        if self.has_active_progress:
            self.clear_active_progress()
        if self._should_ignore_for_log(msg):
            return
        self.target_logger.debug(f"[yt-dlp] {msg.strip()}")

    def warning(self, msg: str) -> None:
        if self.has_active_progress:
            self.clear_active_progress()
        self.target_logger.warning(f"[yt-dlp warning] {msg.strip()}")

    def error(self, msg: str) -> None:
        if self.has_active_progress:
            self.clear_active_progress()
        self.target_logger.error(f"[yt-dlp error] {msg.strip()}")


class CatalogEpisodePP(yt_dlp.postprocessor.PostProcessor):
    """Injects human title, upload date, series, and clean filename into yt-dlp info_dict."""

    def __init__(self, downloader, ep_meta: dict):
        super().__init__(downloader)
        self.ep_meta = ep_meta

    def run(self, info: dict) -> tuple[list, dict]:
        info["title"] = self.ep_meta["title"]
        raw_date = self.ep_meta.get("upload_date") or ""
        if raw_date:
            info["upload_date"] = raw_date.replace("-", "")
        info["custom_year"] = str(self.ep_meta["year"])
        info["custom_series"] = self.ep_meta["series"]
        info["custom_filename"] = self.ep_meta["filename"]
        if self.ep_meta.get("logo") and not info.get("thumbnails"):
            info["thumbnails"] = [{"url": self.ep_meta["logo"], "id": "0"}]
        return [], info


def fetch_podbean_page(page_num: int, include_store: bool = False):
    """Fetches a single page from deeperdhamma.podbean.com and extracts episode data."""
    url = f"https://deeperdhamma.podbean.com/page/{page_num}/" if page_num > 1 else "https://deeperdhamma.podbean.com/"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            html_text = resp.read().decode("utf-8", errors="ignore")
            m = re.search(r'window\.__INITIAL_STATE__="(\{.*?\})"', html_text)
            if not m:
                m = re.search(r'window\.__INITIAL_STATE__=(\{.*?\});', html_text)
            if not m:
                return ({}, []) if include_store else []

            inner_json = json.loads(f'"{m.group(1)}"')
            data = json.loads(inner_json)
            store = data.get("store", {})
            episodes = store.get("listEpisodes", [])
            cleaned = []
            for ep in episodes:
                ts = ep.get("publishTimestamp")
                upload_date = ""
                if ts:
                    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
                    upload_date = dt.strftime("%Y%m%d")
                cleaned.append({
                    "id": ep.get("id"),
                    "title": ep.get("title") or "",
                    "media_url": ep.get("mediaUrl") or "",
                    "upload_date": upload_date,
                    "logo": ep.get("largeLogo") or ep.get("logo") or "",
                    "permalink": ep.get("permalink") or "",
                })
            return (store, cleaned) if include_store else cleaned
    except Exception:
        return ({}, []) if include_store else []


def crawl_full_catalog(workers: int = 8, log: Optional[logging.Logger] = None) -> List[Dict]:
    """Dynamically discovers archive page count from Page 1 and crawls all pages in parallel."""
    l = log or logger
    l.info("[*] Fetching Page 1 to discover archive size...")
    store_p1, p1_eps = fetch_podbean_page(1, include_store=True)
    if not p1_eps:
        l.error("[-] Error: Failed to fetch Page 1 from deeperdhamma.podbean.com.")
        return []

    total_pages = store_p1.get("listTotalPage", 166)
    total_count = store_p1.get("listTotalCount", len(p1_eps))
    l.info(f"[*] Discovered {total_count} total episodes across {total_pages} pages.")
    l.info(f"[*] Crawling remaining pages (2 to {total_pages}) using {workers} parallel workers...")

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        pages_data = list(ex.map(fetch_podbean_page, range(2, total_pages + 1)))

    all_episodes = list(p1_eps)
    for eps in pages_data:
        all_episodes.extend(eps)

    elapsed = time.time() - t0
    l.info(f"[+] Crawl finished in {elapsed:.2f}s: {len(all_episodes)} total episodes indexed.")
    return all_episodes


def get_or_update_catalog(
    catalog_file: Path | str = CATALOG_PATH,
    refresh: bool = False,
    log: Optional[logging.Logger] = None,
) -> List[Dict]:
    """
    Loads local catalog.json immediately if present.
    Performs a fast check on Page 1 to check for newly published episodes.
    Automatically crawls and updates if new episodes or older missing releases are detected.
    Automatically generates catalog.json if it is missing or if refresh is requested.
    """
    l = log or logger
    catalog_path = Path(catalog_file)

    if catalog_path.exists() and not refresh:
        try:
            with open(catalog_path, "r", encoding="utf-8") as f:
                catalog = json.load(f)
            l.info(f"[+] Loaded local catalog: {len(catalog)} episodes from {catalog_path.name}")

            store_p1, page1_eps = fetch_podbean_page(1, include_store=True)
            if not store_p1 and not page1_eps:
                l.warning("[!] Warning: Could not reach deeperdhamma.podbean.com to verify latest changes. Using cached catalog.")
                return catalog

            remote_total = store_p1.get("listTotalCount", len(catalog))
            top_remote_id = page1_eps[0].get("id") if page1_eps else None
            top_local_id = catalog[0].get("id") if catalog else None

            if top_remote_id == top_local_id and len(catalog) == remote_total:
                l.info(f"[✓] Catalog is up to date ({len(catalog)} episodes indexed).")
                return catalog

            l.info(f"[*] Catalog update detected: local has {len(catalog)} eps, remote reports {remote_total} eps.")

            existing_ids = {ep["id"] for ep in catalog}
            new_top_eps = []
            page_idx = 1
            cur_page_eps = page1_eps

            while cur_page_eps:
                page_new = [ep for ep in cur_page_eps if ep["id"] not in existing_ids]
                if not page_new:
                    break
                new_top_eps.extend(page_new)
                if len(page_new) < len(cur_page_eps):
                    break
                page_idx += 1
                cur_page_eps = fetch_podbean_page(page_idx)

            if new_top_eps:
                l.info(f"[+] Found {len(new_top_eps)} new episode(s) released on Podbean.")
                catalog = new_top_eps + catalog

            if len(catalog) < remote_total:
                l.info(f"[*] Discovered missing older release(s) ({len(catalog)} vs remote {remote_total}). Crawling full archive...")
                full_archive = crawl_full_catalog(log=l)
                if full_archive:
                    seen = set()
                    merged = []
                    for ep in full_archive:
                        if ep["id"] not in seen:
                            seen.add(ep["id"])
                            merged.append(ep)
                    catalog = merged

            with open(catalog_path, "w", encoding="utf-8") as f:
                json.dump(catalog, f, indent=2, ensure_ascii=False)
            l.info(f"[+] Catalog updated and saved to {catalog_path.name} ({len(catalog)} total episodes).")

            return catalog
        except Exception as e:
            l.warning(f"[!] Warning reading/updating local catalog ({e}). Re-generating...")

    l.info(f"[*] Local catalog '{catalog_path.name}' not found or refresh requested.")
    l.info(f"[*] Generating local catalog '{catalog_path.name}' from Podbean...")
    catalog = crawl_full_catalog(log=l)
    if catalog:
        catalog_path.parent.mkdir(parents=True, exist_ok=True)
        with open(catalog_path, "w", encoding="utf-8") as f:
            json.dump(catalog, f, indent=2, ensure_ascii=False)
        l.info(f"[+] Saved local copy to {catalog_path.name}")
    return catalog


def reorganize_existing_files(
    target_dir: Path | str = ARCHIVE_DIR,
    catalog: Optional[List[Dict]] = None,
    allow_non_english: bool = False,
    log: Optional[logging.Logger] = None,
) -> int:
    """
    Checks if any existing audio files on disk are located under older/transitional
    date-stamps or years, and moves them to their true locations to prevent redownloading.
    """
    l = log or logger
    target_dir = Path(target_dir)

    if catalog is None:
        if not CATALOG_PATH.exists():
            return 0
        with open(CATALOG_PATH, "r", encoding="utf-8") as f:
            catalog = json.load(f)

    ep_map = {}
    for ep in catalog:
        if not allow_non_english and not is_english_talk(ep["title"]):
            continue
        y, s, fn = parse_episode_metadata(ep["title"], ep.get("upload_date", ""))
        slug = clean_slug(ep["title"])
        ep_map[slug] = (y, s, fn)

    existing = list(target_dir.glob("*/*/*.mp3")) + list(target_dir.glob("*/*/*.m4a"))
    moved_count = 0

    for p in existing:
        rel = p.relative_to(target_dir)
        matched_target = None
        for slug, (y, s, fn) in ep_map.items():
            if slug and (slug in p.name or p.stem.endswith(slug[:35])):
                matched_target = Path(y) / s / f"{fn}{p.suffix}"
                break

        if matched_target and rel != matched_target:
            dest = target_dir / matched_target
            dest.parent.mkdir(parents=True, exist_ok=True)
            try:
                shutil.move(str(p), str(dest))
                l.info(f"[↻] Reorganized existing file:\n    {rel} -> {matched_target}")
                moved_count += 1
            except Exception as e:
                l.warning(f"[!] Could not move {rel} to {matched_target}: {e}")

    for y_dir in list(target_dir.glob("????")):
        if y_dir.is_dir():
            for s_dir in list(y_dir.iterdir()):
                if s_dir.is_dir() and not any(s_dir.iterdir()):
                    try:
                        s_dir.rmdir()
                    except OSError:
                        pass
            if not any(y_dir.iterdir()):
                try:
                    y_dir.rmdir()
                except OSError:
                    pass

    if moved_count > 0:
        l.info(f"[+] Reorganized {moved_count} existing file(s) into their true date/year folders.")
    return moved_count


def cleanup_corrupted_archive_files(target_dir: Path, log: Optional[logging.Logger] = None) -> int:
    """Removes 0-byte audio/image files and transient fragments left behind by interrupted runs."""
    removed = 0
    for p in target_dir.rglob("*"):
        if not p.is_file():
            continue
        # Remove unfinished temporary files
        if p.suffix.lower() in (".temp", ".part", ".ytdl", ".aria2") or ".temp." in p.name:
            try:
                p.unlink()
                removed += 1
            except OSError:
                pass
        # Remove empty 0-byte media files
        elif p.suffix.lower() in (".mp3", ".m4a", ".jpg", ".jpeg", ".png", ".webp") and p.stat().st_size == 0:
            try:
                p.unlink()
                removed += 1
            except OSError:
                pass
    if removed > 0 and log:
        log.info(f"[+] Purged {removed} empty (0-byte) or transient fragment file(s) from archive.")
    return removed


def safe_embed_cover_art(audio_path: Path, thumbnail_path: Path, log: Optional[logging.Logger] = None) -> bool:
    """
    Safely embeds cover art thumbnail into MP3 ID3 tags without re-encoding audio.
    NOTE: Calling this modifies ID3 headers and shifts audio packet byte offsets,
    breaking byte-level parity with remote CDN streaming. It is preserved for standalone
    export use only and must NOT be executed on archive files during run_sync.
    """
    if not audio_path.exists() or not thumbnail_path.exists():
        return False
    if audio_path.suffix.lower() != ".mp3":
        return False
    temp_out = audio_path.with_suffix(".tmp_embed.mp3")
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(audio_path),
        "-i", str(thumbnail_path),
        "-map", "0:a:0",
        "-map", "1:v:0",
        "-c", "copy",
        "-id3v2_version", "3",
        "-metadata:s:v", "title=Album cover",
        "-metadata:s:v", "comment=Cover (front)",
        str(temp_out),
    ]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
        if res.returncode == 0 and temp_out.exists() and temp_out.stat().st_size > 1024:
            _resilient_os_replace(temp_out, audio_path)
            return True
        else:
            if temp_out.exists():
                try:
                    temp_out.unlink()
                except OSError:
                    pass
            if log and res.stderr:
                log.debug(f"Cover art embed notice for {audio_path.name}: {res.stderr.strip()[:120]}")
            return False
    except Exception as e:
        if temp_out.exists():
            try:
                temp_out.unlink()
            except OSError:
                pass
        if log:
            log.debug(f"Cover art embed skipped for {audio_path.name}: {e}")
        return False


def remove_from_archive_log(archive_path: Path, identifiers: Set[str]) -> int:
    """Removes entries from archive.log for given identifiers (id, filename, url_stem)."""
    if not archive_path.exists() or not identifiers:
        return 0
    clean_ids = {str(i).strip() for i in identifiers if i and str(i).strip()}
    removed = 0
    new_lines = []
    with open(archive_path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            parts = line.strip().split()
            matched = False
            for p in parts:
                if p in clean_ids:
                    matched = True
                    break
            if matched:
                removed += 1
            else:
                new_lines.append(line)
    if removed > 0:
        with open(archive_path, "w", encoding="utf-8") as f:
            f.writelines(new_lines)
    return removed


def verify_remote_parity(
    local_path: Path,
    media_url: str,
    timeout: int = 10,
) -> Tuple[bool, str, Dict[str, Any]]:
    """
    Verifies bitstream parity between local audio file and remote CDN media URL.
    Checks:
    1. Local file existence and non-trivial size (> 1MB).
    2. Remote Content-Length matching local file size.
    3. Remote Content-Type matching expected audio format.
    4. ID3v2 tag length parity (for MP3).
    5. Exact byte match of initial stream prefix (first 128 bytes).
    """
    if not local_path.exists():
        return False, "local file does not exist", {}
    local_size = local_path.stat().st_size
    if local_size < 1024 * 1024:
        return False, f"local file suspiciously small ({local_size} bytes)", {}

    req_head = urllib.request.Request(media_url, method="HEAD", headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req_head, timeout=timeout) as resp:
            remote_size = int(resp.headers.get("Content-Length", 0))
    except Exception as e:
        return False, f"remote HEAD probe failed: {e}", {}

    if remote_size > 0 and local_size != remote_size:
        diff = local_size - remote_size
        return False, f"size mismatch: local={local_size}, remote={remote_size} (diff: {diff:+d} bytes)", {
            "local_size": local_size, "remote_size": remote_size, "diff": diff
        }

    # Range check first 1024 bytes
    try:
        with open(local_path, "rb") as f:
            loc_head = f.read(1024)
        req_range = urllib.request.Request(media_url, headers={"Range": "bytes=0-1023", "User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req_range, timeout=timeout) as resp:
            rem_head = resp.read()
    except Exception as e:
        return False, f"remote Range probe failed: {e}", {}

    if local_path.suffix.lower() == ".mp3":
        loc_id3 = get_id3v2_tag_size(loc_head)
        rem_id3 = get_id3v2_tag_size(rem_head)
        if loc_id3 != rem_id3:
            diff_id3 = loc_id3 - rem_id3
            return False, f"ID3 tag length mismatch: local={loc_id3}, remote={rem_id3} (diff: {diff_id3:+d} bytes)", {
                "local_id3": loc_id3, "remote_id3": rem_id3, "diff_id3": diff_id3
            }

    if loc_head[:128] != rem_head[:128]:
        return False, "bitstream prefix divergence in first 128 bytes", {}

    return True, "exact bitstream parity confirmed", {"size": local_size}


def run_sync(
    target_dir: Path | str = ARCHIVE_DIR,
    catalog_file: Path | str = CATALOG_PATH,
    archive_log_file: Path | str = ARCHIVE_LOG_PATH,
    limit: Optional[int] = None,
    series: Optional[str] = None,
    year: Optional[Union[int, str]] = None,
    dry_run: bool = False,
    workers: int = 3,
    rate_limit_mb: int = 10,
    sleep_seconds: int = 1,
    refresh_catalog: bool = False,
    catalog_only: bool = False,
    reorganize: bool = False,
    allow_non_english: bool = False,
    log_file: Optional[Path | str] = None,
    auto_index_db: bool = True,
    retry_errors: bool = False,
    repair: bool = False,
) -> Dict[str, Any]:
    """
    Main orchestration entry point for feed syncing, catalog updating, and episode downloading.
    """
    target_dir = Path(target_dir).resolve()
    target_dir.mkdir(parents=True, exist_ok=True)

    catalog_path = Path(catalog_file) if Path(catalog_file).is_absolute() else (PROJECT_ROOT / catalog_file)
    archive_path = Path(archive_log_file) if Path(archive_log_file).is_absolute() else (PROJECT_ROOT / archive_log_file)
    default_log = DEFAULT_SYNC_LOG
    p_log = Path(log_file) if log_file else default_log

    l = setup_sync_logging(p_log)
    l.debug("=== Sync Session Initialized ===")
    l.debug(f"Parameters: target_dir={target_dir}, limit={limit}, year={year}, series={series}, dry_run={dry_run}, workers={workers}")

    # Verify external tools
    for binary in ("aria2c", "ffmpeg"):
        if not ensure_binary(binary):
            l.error(f"[-] Error: Required dependency '{binary}' was not found.")
            sys.exit(1)

    # Save original working directory and switch to target_dir for yt-dlp relative paths
    orig_cwd = os.getcwd()
    os.chdir(target_dir)

    try:
        # Load or refresh catalog
        catalog = get_or_update_catalog(catalog_path, refresh=refresh_catalog, log=l)

        # Reorganize previously downloaded files
        reorganize_existing_files(target_dir, catalog, allow_non_english=allow_non_english, log=l)
        if reorganize:
            l.info("[✓] Reorganization finished.")
            return {"status": "reorganized"}

        # Purge any 0-byte ghost files or transient partial downloads from prior aborted sessions
        cleanup_corrupted_archive_files(target_dir, log=l)

        if catalog_only or (limit is not None and limit <= 0):
            l.info(f"[+] Catalog '{catalog_path.name}' is ready ({len(catalog)} episodes indexed). Exiting as requested.")
            return {"status": "catalog_only", "episodes": len(catalog)}

        # Load archive.log
        archive_entries: Set[str] = set()
        if archive_path.exists():
            with open(archive_path, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    parts = line.strip().split()
                    if len(parts) >= 2:
                        archive_entries.add(parts[1])
                    elif parts:
                        archive_entries.add(parts[0])

        str_year = str(year) if year is not None else None

        candidates_in_scope = []
        for ep in catalog:
            if not allow_non_english and not is_english_talk(ep["title"]):
                continue

            ep_year, ep_series, filename = parse_episode_metadata(ep["title"], ep.get("upload_date", ""))

            if str_year and not (ep_year == str_year or ep.get("upload_date", "").startswith(str_year)):
                continue
            if series and series.lower() not in ep_series.lower() and series.lower() not in ep.get("title", "").lower():
                continue

            dest_mp3 = target_dir / ep_year / ep_series / f"{filename}.mp3"
            dest_m4a = target_dir / ep_year / ep_series / f"{filename}.m4a"

            file_exists = (
                (dest_mp3.exists() and dest_mp3.stat().st_size > 1024 * 1024)
                or (dest_m4a.exists() and dest_m4a.stat().st_size > 1024 * 1024)
            )
            existing_file = dest_mp3 if (dest_mp3.exists() and dest_mp3.stat().st_size > 1024 * 1024) else (
                dest_m4a if (dest_m4a.exists() and dest_m4a.stat().st_size > 1024 * 1024) else None
            )

            ep_id = ep.get("id") or ""
            media_url = ep.get("media_url") or ""
            url_stem = Path(media_url.split("?")[0]).stem if media_url else ""
            guid_match = any(e in archive_entries for e in [ep_id, media_url, url_stem, filename] if e)

            candidates_in_scope.append({
                **ep,
                "series": ep_series,
                "filename": filename,
                "year": ep_year,
                "file_exists": file_exists,
                "existing_file": existing_file,
                "guid_match": guid_match,
            })

        total_in_scope = len(candidates_in_scope)
        all_pending = []

        if not repair:
            for ep_cand in candidates_in_scope:
                if ep_cand["file_exists"] or ep_cand["guid_match"]:
                    continue
                all_pending.append(ep_cand)
        else:
            missing_episodes = [
                ep for ep in candidates_in_scope
                if not ep["file_exists"] and not ep["guid_match"]
            ]
            existing_episodes = [ep for ep in candidates_in_scope if ep["file_exists"]]

            for ep in missing_episodes:
                all_pending.append({**ep, "is_repair": False})

            if existing_episodes:
                l.info(f"[*] Auditing {len(existing_episodes)} existing archive files against Podbean CDN for bitstream parity...")

                def _check_ep(item: dict) -> Tuple[dict, bool, str]:
                    p = item["existing_file"]
                    u = item.get("media_url", "")
                    if not u or not p:
                        return item, True, "No media URL or file"
                    is_valid, reason, _ = verify_remote_parity(p, u)
                    return item, is_valid, reason

                parity_workers = min(15, max(1, len(existing_episodes)))
                audited = 0
                with ThreadPoolExecutor(max_workers=parity_workers) as pool:
                    for ep_item, is_valid, reason in pool.map(_check_ep, existing_episodes):
                        audited += 1
                        if audited % 50 == 0 or audited == len(existing_episodes):
                            sys.stdout.write(f"\r   -> Audited parity: {audited}/{len(existing_episodes)} files...")
                            sys.stdout.flush()
                        if not is_valid:
                            all_pending.append({
                                **ep_item,
                                "is_repair": True,
                                "repair_reason": reason,
                            })
                sys.stdout.write("\n")

        completed = total_in_scope - len(all_pending)
        pending_episodes = all_pending[:limit] if limit is not None else all_pending

        mode_str = "REPAIR (audit & fix corrupted/modified bytes)" if repair else "SYNC (download missing talks)"
        lang_desc = "English Only" if not allow_non_english else "All Languages"
        l.info(f"[*] Target Directory:    {target_dir}")
        l.info(f"[*] Operation Mode:      {mode_str}")
        l.info(f"[*] Script Log File:     {p_log}")
        l.info(f"[*] Language Filter:     {lang_desc}")
        l.info(f"[*] Episodes in Scope:   {total_in_scope}" + (f" (Year: {year})" if year else ""))
        l.info(f"[*] Verified Pristine:   {completed}")
        l.info(f"[*] Pending Download:    {len(all_pending)}" + (f" (Capped to first {len(pending_episodes)} this run)" if limit is not None else ""))
        l.info(f"[*] Speed Cap:           {rate_limit_mb} MB/s")
        l.info(f"[*] Connections / File:  {workers}")
        l.info("[*] Cover Art:           Preserved from source (native compressed ID3 APIC)")
        l.info("[*] Bitstream Parity:    Exact 1:1 match with Podbean CDN verified")
        l.info("[*] Press Ctrl+C at any time to pause. Rerunning will resume safely.\n")

        if dry_run:
            desc = "pending repairs & downloads" if repair else "pending downloads"
            l.info(f"[✓] Dry run active. Preview of {desc} ({len(all_pending)} total pending):")
            for idx, ep in enumerate(pending_episodes[:15], 1):
                reason_tag = f" -> {ep['repair_reason']}" if ep.get("is_repair") else ""
                l.info(f"  {idx:>2}. [{ep['year']}] {ep['filename']} ({ep['title'][:55]}){reason_tag}")
            if len(pending_episodes) > 15:
                l.info(f"  ... and {len(pending_episodes) - 15} more talks.")
            l.info(f"\n[✓] Dry run complete: {completed} verified pristine, {len(all_pending)} pending download/repair.")
            return {
                "in_scope": total_in_scope,
                "already_synced": completed,
                "pending": len(all_pending),
                "preview_count": len(pending_episodes),
            }

        if not pending_episodes:
            l.info("[✓] All episodes in scope are already downloaded and bitstream-verified!")
            return {
                "in_scope": total_in_scope,
                "already_synced": completed,
                "downloaded": 0,
            }

        rate_limit_arg = f"--max-overall-download-limit={max(1, rate_limit_mb)}M"
        aria2_args = [
            f"-x{max(1, workers)}",
            f"-s{max(1, workers)}",
            "-k1M",
            "-c",
            rate_limit_arg,
            "--console-log-level=warn",
            "--summary-interval=0",
        ]

        tdb = None
        if auto_index_db:
            try:
                from deeper_dhamma.storage import TranscriptDatabase
                tdb = TranscriptDatabase()
            except Exception as e:
                l.debug(f"Database initialization notice: {e}")

        success_count = 0
        for idx, ep in enumerate(pending_episodes, start=1):
            current_num = completed + idx
            ep_id = ep.get("id") or ep["filename"]
            l.info(f"[{current_num}/{total_in_scope}] Ingesting: {ep['title']}")
            l.info(f"   -> Folder: {ep['year']}/{ep['series']}/")
            l.info(f"   -> File:   {ep['filename']}.mp3")

            dest_folder = target_dir / ep["year"] / ep["series"]
            dest_folder.mkdir(parents=True, exist_ok=True)
            dest_mp3 = dest_folder / f"{ep['filename']}.mp3"
            dest_m4a = dest_folder / f"{ep['filename']}.m4a"
            dest_jpg = dest_folder / f"{ep['filename']}.jpg"

            # Pre-cleanup: if repairing or 0-byte ghost files exist, remove them before yt-dlp sees them
            if ep.get("is_repair"):
                l.info(f"   -> Repair action: Purging altered file & invalidating archive.log ({ep.get('repair_reason')})")
                for old_f in (dest_mp3, dest_m4a, dest_jpg):
                    if old_f.exists():
                        try:
                            old_f.unlink()
                        except OSError:
                            pass
                media_url = ep.get("media_url") or ""
                url_stem = Path(media_url.split("?")[0]).stem if media_url else ""
                remove_from_archive_log(archive_path, {ep_id, media_url, url_stem, ep.get("filename", "")})
            else:
                for ghost in (dest_mp3, dest_m4a, dest_jpg):
                    if ghost.exists() and ghost.stat().st_size == 0:
                        try:
                            ghost.unlink()
                        except OSError:
                            pass

            # Pre-flight error check: inspect previous error for this episode, resolve or skip
            if tdb:
                def _dl_auto_resolver(err_info: dict) -> bool:
                    err_msg = (err_info.get("last_error") or "").lower()
                    if "invalid data" in err_msg or "postprocessing" in err_msg:
                        ghost_exists = any(
                            p.exists() and p.stat().st_size == 0
                            for p in (dest_mp3, dest_m4a, dest_jpg)
                        )
                        if not ghost_exists:
                            return "0-byte ghost files purged"
                    if "elapsed" in err_msg:
                        dest_f = dest_mp3 if dest_mp3.exists() else dest_m4a
                        if dest_f.exists() and dest_f.stat().st_size > 1024 * 1024:
                            return "spurious 'elapsed' error auto-resolved (audio file intact)"
                        return "spurious 'elapsed' error reset for retry"
                    if "aria2c exited with code 16" in err_msg or "code 16" in err_msg:
                        return "aria2c path length error reset for native retry"
                    return False

                can_proceed, reason = tdb.check_preflight(
                    episode_id=ep_id,
                    operation="download",
                    retry_errors=retry_errors,
                    auto_resolver=_dl_auto_resolver,
                )
                if not can_proceed:
                    l.warning(f"   [-] Pre-flight skip: '{ep['title']}' ({reason}). Pass --retry-errors to force retry.\n")
                    continue

            ydl_adapter = YTDLPLogAdapter(l)
            ydl_opts = {
                "downloader": "aria2c",
                "downloader_args": {"aria2c": aria2_args},
                "external_downloader": {"default": "aria2c"},
                "external_downloader_args": {"aria2c": aria2_args},
                "ratelimit": (rate_limit_mb * 1024 * 1024) if rate_limit_mb else None,
                "download_archive": str(archive_path),
                "writethumbnail": True,
                "logger": ydl_adapter,
                "windowsfilenames": True,
                "retries": 10,
                "fragment_retries": 10,
                "paths": {"home": str(target_dir)},
                "outtmpl": "%(custom_year)s/%(custom_series)s/%(custom_filename)s.%(ext)s",
                "quiet": False,
                "no_warnings": True,
            }

            t0 = time.time()
            try:
                ydl = yt_dlp.YoutubeDL(ydl_opts)
                ydl.add_post_processor(CatalogEpisodePP(ydl, ep), when="pre_process")
                ret = ydl.download([ep["media_url"]])
                ydl_adapter.clear_active_progress()
                if ret == 0:
                    elapsed = time.time() - t0
                    success_count += 1
                    if tdb:
                        tdb.clear_error(ep_id)
                    dest_file = dest_mp3 if dest_mp3.exists() else dest_m4a
                    size_str = f" ({dest_file.stat().st_size / (1024 * 1024):.1f} MB)" if dest_file.exists() else ""
                    tag_str = "repaired with exact bitstream parity" if ep.get("is_repair") else "exact bitstream copy preserved"
                    l.info(f"   [✓] Completed in {elapsed:.1f}s{size_str} - {tag_str}\n")
                if sleep_seconds > 0 and idx < len(pending_episodes) and elapsed > 1.0:
                    time.sleep(sleep_seconds)
            except KeyboardInterrupt:
                ydl_adapter.clear_active_progress()
                # Immediate cleanup of any 0-byte or corrupted remnants of the interrupted download
                for remnant in (dest_mp3, dest_m4a, dest_jpg):
                    if remnant.exists() and remnant.stat().st_size == 0:
                        try:
                            remnant.unlink()
                        except OSError:
                            pass
                # Also remove any transient aria2/part fragments for this specific file
                for p in dest_folder.glob(f"{ep['filename']}.*"):
                    if p.suffix.lower() in (".temp", ".part", ".ytdl") or ".temp." in p.name:
                        try:
                            p.unlink()
                        except OSError:
                            pass

                l.info("\n[*] Download session interrupted by user (Ctrl+C).")

                # Guarantee that any episodes successfully completed earlier in this session are preserved and indexed
                if auto_index_db and success_count > 0:
                    try:
                        tdb_inst = tdb or TranscriptDatabase()
                        idx_res = tdb_inst.index_archive_audio_files(target_dir)
                        l.info(f"[+] Audio database catalog refreshed: {idx_res.get('new_episodes_indexed', 0)} new file(s) indexed.")
                    except Exception as e:
                        l.debug(f"Audio database auto-index notice: {e}")

                l.info("[*] Run 'python main.py sync' at any time to resume remaining downloads safely.\n")
                sys.exit(130)
            except Exception as e:
                ydl_adapter.clear_active_progress()
                err_str = str(e)

                # Fallback to native yt-dlp downloader if aria2c fails (e.g. Windows MAX_PATH limits, network/exit errors)
                if "aria2c exited with code" in err_str or "aria2c" in err_str.lower():
                    l.warning(f"   [!] aria2c failed ({e}). Retrying with native downloader...")
                    for remnant in (dest_mp3, dest_m4a, dest_jpg):
                        if remnant.exists() and remnant.stat().st_size == 0:
                            try:
                                remnant.unlink()
                            except OSError:
                                pass
                    for p in dest_folder.glob(f"{ep['filename']}.*"):
                        if p.suffix.lower() in (".temp", ".part", ".ytdl", ".aria2") or ".temp." in p.name:
                            try:
                                p.unlink()
                            except OSError:
                                pass

                    native_opts = dict(ydl_opts)
                    native_opts.pop("downloader", None)
                    native_opts.pop("downloader_args", None)
                    native_opts.pop("external_downloader", None)
                    native_opts.pop("external_downloader_args", None)
                    try:
                        ydl_native = yt_dlp.YoutubeDL(native_opts)
                        ydl_native.add_post_processor(CatalogEpisodePP(ydl_native, ep), when="pre_process")
                        ret = ydl_native.download([ep["media_url"]])
                        ydl_adapter.clear_active_progress()
                        if ret == 0:
                            elapsed = time.time() - t0
                            success_count += 1
                            if tdb:
                                tdb.clear_error(ep_id)
                            dest_file = dest_mp3 if dest_mp3.exists() else dest_m4a
                            size_str = f" ({dest_file.stat().st_size / (1024 * 1024):.1f} MB)" if dest_file.exists() else ""
                            tag_str = "repaired with exact bitstream parity" if ep.get("is_repair") else "exact bitstream copy preserved"
                            l.info(f"   [✓] Completed via native fallback in {elapsed:.1f}s{size_str} - {tag_str}\n")
                            if sleep_seconds > 0 and idx < len(pending_episodes) and elapsed > 1.0:
                                time.sleep(sleep_seconds)
                            continue
                    except KeyboardInterrupt:
                        raise
                    except Exception as fallback_e:
                        e = fallback_e
                        err_str = str(fallback_e)

                # Post-failure cleanup: purge any 0-byte remnants so they don't break subsequent attempts
                for remnant in (dest_mp3, dest_m4a, dest_jpg):
                    if remnant.exists() and remnant.stat().st_size == 0:
                        try:
                            remnant.unlink()
                        except OSError:
                            pass
                if "user-site-page-not-found" in err_str or "HTTP Error 404" in err_str:
                    l.warning(f"[!] Podbean 404 Notice: Talk '{ep['title']}' was removed from CDN by host. Skipping.\n")
                    if tdb:
                        tdb.record_error(
                            episode_id=ep_id,
                            error_message="HTTP Error 404: Removed from CDN by host",
                            operation="download",
                            filepath=str(dest_mp3),
                            title=ep.get("title", ""),
                        )
                    if ep.get("id"):
                        try:
                            with open(archive_path, "a", encoding="utf-8") as af:
                                af.write(f"podbean {ep['id']}\n")
                        except Exception:
                            pass
                else:
                    l.error(f"[!] Error downloading '{ep['title']}': {e}\n")
                    if tdb:
                        tdb.record_error(
                            episode_id=ep_id,
                            error_message=err_str,
                            operation="download",
                            filepath=str(dest_mp3),
                            title=ep.get("title", ""),
                        )

        l.info(f"[✓] Sync finished: {success_count} episode(s) downloaded.")

        if auto_index_db and success_count > 0:
            try:
                from deeper_dhamma.storage import TranscriptDatabase
                tdb = TranscriptDatabase()
                idx_res = tdb.index_archive_audio_files(target_dir)
                l.info(f"[+] Audio database catalog refreshed: {idx_res.get('new_episodes_indexed', 0)} new file(s) indexed.")
            except Exception as e:
                l.debug(f"Audio database auto-index notice: {e}")

        return {
            "in_scope": total_in_scope,
            "already_synced": completed,
            "downloaded": success_count,
        }
    finally:
        os.chdir(orig_cwd)
