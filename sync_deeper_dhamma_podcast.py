#!/usr/bin/env python3
"""
Full-archive archiver for BSWA Deeper Dhamma podcast.
Crawls all 166 Podbean pages into a fast local catalog (catalog.json, ~3,320 episodes).
Uses local catalog on subsequent runs with instantaneous startup (no crawling needed).
Uses yt-dlp, aria2c, and ffmpeg to fetch episodes into year and series folders.
Enforces ASCII-normalized, lowercase, space-free file and folder names.
Embeds podcast cover thumbnails into MP3 ID3 tags with resilient Windows file-lock handling.
Configured with balanced throughput (3 connections, 10 MB/s, 1s delay).
"""

import argparse
import html
import json
import os
import re
import shutil
import sys
import time
import logging
from logging.handlers import RotatingFileHandler
import unicodedata
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
import yt_dlp

# Reconfigure console output on Windows to UTF-8 to prevent charmap/UnicodeEncodeError
if sys.platform == "win32":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# Standard application logger
logger = logging.getLogger("deeper_dhamma")


def setup_logging(log_file: Path) -> None:
    """Configures dual logging: clean output for console, compact rotating log for file."""
    logger.setLevel(logging.DEBUG)
    logger.handlers.clear()

    # Rotating file handler: 5MB per file, max 3 backups to prevent unbounded disk usage
    log_file.parent.mkdir(parents=True, exist_ok=True)
    rfh = RotatingFileHandler(log_file, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8")
    rfh.setLevel(logging.DEBUG)
    rfh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)-7s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S"))
    logger.addHandler(rfh)

    # Console handler: clean, human-readable terminal output
    ch = logging.StreamHandler(sys.stdout)
    ch.setLevel(logging.INFO)
    ch.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(ch)


class YTDLPLogAdapter:
    """Adapts yt-dlp messages: retains actionable diagnostics while filtering noisy progress ticks."""

    # Substrings that represent high-frequency progress ticks or repetitive downloader noise
    NOISY_PATTERNS = (
        "Downloading webpage",
        "Following redirect to",
        "Resuming download at byte",
        "Deleting existing file",
    )

    def __init__(self, target_logger: logging.Logger):
        self.target_logger = target_logger

    def _should_ignore(self, msg: str) -> bool:
        # Ignore frequent download progress ticks (e.g. "[download]  28.9% of ...")
        if "[download]" in msg and "%" in msg and "100%" not in msg:
            return True
        for pattern in self.NOISY_PATTERNS:
            if pattern in msg:
                return True
        return False

    def debug(self, msg: str) -> None:
        if self._should_ignore(msg):
            return
        self.target_logger.debug(f"[yt-dlp] {msg.strip()}")

    def info(self, msg: str) -> None:
        if self._should_ignore(msg):
            return
        self.target_logger.debug(f"[yt-dlp] {msg.strip()}")

    def warning(self, msg: str) -> None:
        self.target_logger.warning(f"[yt-dlp warning] {msg.strip()}")

    def error(self, msg: str) -> None:
        self.target_logger.error(f"[yt-dlp error] {msg.strip()}")


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


MONTH_MAP = {
    "january": "01", "jan": "01",
    "february": "02", "feb": "02",
    "march": "03", "mar": "03",
    "april": "04", "apr": "04",
    "may": "05",
    "june": "06", "jun": "06",
    "july": "07", "jul": "07",
    "august": "08", "aug": "08",
    "september": "09", "sep": "09", "sept": "09",
    "october": "10", "oct": "10",
    "november": "11", "nov": "11",
    "december": "12", "dec": "12",
}

NON_ENGLISH_PATTERNS = [
    r"\b(?:in\s+)?thai(?:\s+language)?\b",
    r"\b(?:with\s+)?sinhalese(?:\s+translation)?\b",
    r"\b(?:in\s+)?sinhala(?:\s+language)?\b",
    r"\b(?:in\s+)?chinese(?:\s+language)?\b",
    r"\bmandarin\b",
    r"\bcantonese\b",
    r"\bvietnamese\b",
    r"\bburmese\b",
    r"\bwith\s+\w+\s+translation\b",
    r"[\u0e00-\u0e7f]",  # Thai Unicode range
    r"[\u4e00-\u9fff]",  # Chinese Unicode range
    r"[\u0d80-\u0dff]",  # Sinhala Unicode range
]
_NON_ENGLISH_REGEX = re.compile("|".join(NON_ENGLISH_PATTERNS), re.IGNORECASE)


def is_english_talk(title: str) -> bool:
    """Returns True if the talk title does not indicate non-English language or translation."""
    return not bool(_NON_ENGLISH_REGEX.search(title))


def to_ascii_slug(text: str) -> str:
    """
    Normalizes unicode strings (e.g. Pali diacritics: ā -> a, ṇ -> n, ḍ -> d)
    into clean, lowercase, underscore-separated ASCII slugs.
    """
    text = html.unescape(text)
    decomposed = unicodedata.normalize("NFKD", text)
    ascii_only = decomposed.encode("ascii", "ignore").decode("ascii")
    lowered = ascii_only.lower()
    slug = re.sub(r"[^a-z0-9]+", "_", lowered)
    return slug.strip("_")


def extract_year_and_date(title: str, upload_date: str) -> tuple[str, str]:
    """
    Extracts the true talk year and yyyy-mm-dd date prefix.
    Detects dates or years in the title for older releases / backfilled talks,
    falling back to upload_date.
    """
    # 1. Explicit full date in title: e.g. 15 August 2001, 26th April 2003, 27 November 2025
    m_full_date = re.search(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(19\d\d|20\d\d)\b", title)
    if m_full_date:
        day = m_full_date.group(1).zfill(2)
        mon_name = m_full_date.group(2).lower()
        yr = m_full_date.group(3)
        if mon_name in MONTH_MAP:
            return yr, f"{yr}-{MONTH_MAP[mon_name]}-{day}"

    # 2. Month + Year: e.g. November 2011, October 2013
    m_mon_yr = re.search(r"\b([A-Za-z]+)\s+(19\d\d|20\d\d)\b", title)
    if m_mon_yr:
        mon_name = m_mon_yr.group(1).lower()
        yr = m_mon_yr.group(2)
        if mon_name in MONTH_MAP:
            return yr, f"{yr}-{MONTH_MAP[mon_name]}-01"

    # 3. Series or title starting with year: e.g. 2017 Rains Retreat, 1997 9 Day Retreat
    m_start_yr = re.match(r"^(19\d\d|20\d\d)\b", title)
    if m_start_yr:
        yr = m_start_yr.group(1)
        if upload_date and len(upload_date) == 8:
            return yr, f"{yr}-{upload_date[4:6]}-{upload_date[6:8]}"
        return yr, f"{yr}-01-01"

    # 4. Standalone year at end of title: e.g. ... | 1997
    m_end_yr = re.search(r"\|\s*(19\d\d|20\d\d)\s*$", title)
    if m_end_yr:
        yr = m_end_yr.group(1)
        if upload_date and len(upload_date) == 8:
            return yr, f"{yr}-{upload_date[4:6]}-{upload_date[6:8]}"
        return yr, f"{yr}-01-01"

    # Fallback to upload_date
    yr = upload_date[:4] if len(upload_date) >= 4 else "unknown_year"
    d_prefix = f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:8]}" if len(upload_date) == 8 else yr
    return yr, d_prefix


def parse_episode_metadata(title: str, upload_date: str) -> tuple[str, str, str]:
    """
    Parses an episode title into a (year, series_folder, clean_filename) tuple.
    Extracts true talk year, series, part tags (padded), and normalized ASCII slug.
    """
    title = html.unescape(title)
    talk_year, date_prefix = extract_year_and_date(title, upload_date)

    m_fraction = re.search(r"^(.*?)\s*\((\d+)/(\d+)\)(.*)$", title)
    m_part = re.search(r"^(.*?)\s*-\s*Part\s+(\d+)/(\d+)(.*)$", title, re.IGNORECASE)
    m_lead_frac = re.search(r"^(.*?)\|\s*(\d+)/(\d+)\s+(Retreat.*)$", title, re.IGNORECASE)
    m_day = re.search(r"^(.*?\bRetreat\b)\s*-\s*Day\s+(\d+)(.*)$", title, re.IGNORECASE)

    if m_fraction:
        series_raw, cur_str, total_str, remainder = m_fraction.groups()
        pad = len(total_str)
        part_tag = f"{cur_str.zfill(pad)}_{total_str}"
        series_folder = to_ascii_slug(series_raw.replace("|", " "))
        remainder_slug = to_ascii_slug(remainder)
        parts = [date_prefix, series_folder, part_tag, remainder_slug]
        filename = "_".join(p for p in parts if p)
        return talk_year, series_folder, filename

    if m_part:
        series_raw, cur_str, total_str, remainder = m_part.groups()
        pad = len(total_str)
        part_tag = f"part_{cur_str.zfill(pad)}_{total_str}"
        series_folder = to_ascii_slug(series_raw.replace("|", " "))
        remainder_slug = to_ascii_slug(remainder)
        parts = [date_prefix, series_folder, part_tag, remainder_slug]
        filename = "_".join(p for p in parts if p)
        return talk_year, series_folder, filename

    if m_lead_frac:
        pre_series, cur_str, total_str, post_series = m_lead_frac.groups()
        pad = len(total_str)
        part_tag = f"{cur_str.zfill(pad)}_{total_str}"
        series_folder = to_ascii_slug(f"{pre_series} {post_series}")
        parts = [date_prefix, series_folder, part_tag]
        filename = "_".join(p for p in parts if p)
        return talk_year, series_folder, filename

    if m_day:
        series_raw, day_str, remainder = m_day.groups()
        part_tag = f"day_{day_str.zfill(2)}"
        series_folder = to_ascii_slug(series_raw.replace("|", " "))
        remainder_slug = to_ascii_slug(remainder)
        parts = [date_prefix, series_folder, part_tag, remainder_slug]
        filename = "_".join(p for p in parts if p)
        return talk_year, series_folder, filename

    clean_title = to_ascii_slug(title)
    parts = [date_prefix, clean_title]
    filename = "_".join(p for p in parts if p)
    return talk_year, "standalone", filename


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

            # Cleanly unescape JSON string without corrupting UTF-8 characters
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


def crawl_full_catalog(workers: int = 8) -> list[dict]:
    """Dynamically discovers archive page count from Page 1 and crawls all pages in parallel (~4-6s)."""
    logger.info("[*] Fetching Page 1 to discover archive size...")
    store_p1, p1_eps = fetch_podbean_page(1, include_store=True)
    if not p1_eps:
        logger.error("[-] Error: Failed to fetch Page 1 from deeperdhamma.podbean.com.")
        return []

    total_pages = store_p1.get("listTotalPage", 166)
    total_count = store_p1.get("listTotalCount", len(p1_eps))
    logger.info(f"[*] Discovered {total_count} total episodes across {total_pages} pages.")
    logger.info(f"[*] Crawling remaining pages (2 to {total_pages}) using {workers} parallel workers...")

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        pages_data = list(ex.map(fetch_podbean_page, range(2, total_pages + 1)))

    all_episodes = list(p1_eps)
    for eps in pages_data:
        all_episodes.extend(eps)

    elapsed = time.time() - t0
    logger.info(f"[+] Crawl finished in {elapsed:.2f}s: {len(all_episodes)} total episodes indexed.")
    return all_episodes


def get_or_update_catalog(catalog_file: Path, refresh: bool = False) -> list[dict]:
    """
    Loads local catalog.json immediately if present.
    Performs a fast check on Page 1 (~0.2s) to check for newly published episodes.
    Automatically crawls and updates if new episodes or older missing releases are detected.
    Automatically generates catalog.json if it is missing or if refresh is requested.
    """
    if catalog_file.exists() and not refresh:
        try:
            with open(catalog_file, "r", encoding="utf-8") as f:
                catalog = json.load(f)
            logger.info(f"[+] Loaded local catalog: {len(catalog)} episodes from {catalog_file.name}")

            # Query Page 1 to verify whether Podbean state changed
            store_p1, page1_eps = fetch_podbean_page(1, include_store=True)
            if not store_p1 and not page1_eps:
                logger.warning("[!] Warning: Could not reach deeperdhamma.podbean.com to verify latest changes. Using cached catalog.")
                return catalog

            remote_total = store_p1.get("listTotalCount", len(catalog))
            top_remote_id = page1_eps[0].get("id") if page1_eps else None
            top_local_id = catalog[0].get("id") if catalog else None

            # 1. Perfectly in sync
            if top_remote_id == top_local_id and len(catalog) == remote_total:
                logger.info(f"[✓] Catalog is up to date ({len(catalog)} episodes indexed).")
                return catalog

            logger.info(f"[*] Catalog update detected: local has {len(catalog)} eps, remote reports {remote_total} eps.")

            # 2. Check if new episodes were published at the top
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
                    # We reached existing episodes on this page
                    break
                page_idx += 1
                cur_page_eps = fetch_podbean_page(page_idx)

            if new_top_eps:
                logger.info(f"[+] Found {len(new_top_eps)} new episode(s) released on Podbean.")
                catalog = new_top_eps + catalog

            # 3. If there are still missing older releases or count discrepancies anywhere in the archive
            if len(catalog) < remote_total:
                logger.info(f"[*] Discovered missing older release(s) ({len(catalog)} vs remote {remote_total}). Crawling full archive...")
                full_archive = crawl_full_catalog()
                if full_archive:
                    seen = set()
                    merged = []
                    for ep in full_archive:
                        if ep["id"] not in seen:
                            seen.add(ep["id"])
                            merged.append(ep)
                    catalog = merged

            # Save the refreshed/updated catalog
            with open(catalog_file, "w", encoding="utf-8") as f:
                json.dump(catalog, f, indent=2, ensure_ascii=False)
            logger.info(f"[+] Catalog updated and saved to {catalog_file.name} ({len(catalog)} total episodes).")

            return catalog
        except Exception as e:
            logger.warning(f"[!] Warning reading/updating local catalog ({e}). Re-generating...")

    logger.info(f"[*] Local catalog '{catalog_file.name}' not found or refresh requested.")
    logger.info(f"[*] Generating local catalog '{catalog_file.name}' from Podbean...")
    catalog = crawl_full_catalog()
    if catalog:
        with open(catalog_file, "w", encoding="utf-8") as f:
            json.dump(catalog, f, indent=2, ensure_ascii=False)
        logger.info(f"[+] Saved local copy to {catalog_file.name}")
    return catalog


def reorganize_existing_files(target_dir: Path, catalog: list[dict], allow_non_english: bool = False) -> int:
    """
    Checks if any existing audio files on disk are located under older/transitional
    date-stamps or years, and moves them to their true locations to prevent redownloading.
    """
    ep_map = {}
    for ep in catalog:
        if not allow_non_english and not is_english_talk(ep["title"]):
            continue
        y, s, fn = parse_episode_metadata(ep["title"], ep["upload_date"])
        slug = to_ascii_slug(ep["title"])
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
                logger.info(f"[↻] Reorganized existing file:\n    {rel} -> {matched_target}")
                moved_count += 1
            except Exception as e:
                logger.warning(f"[!] Could not move {rel} to {matched_target}: {e}")

    # Clean up empty parent directories if any
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
        logger.info(f"[+] Reorganized {moved_count} existing file(s) into their true date/year folders.")
    return moved_count


class CatalogEpisodePP(yt_dlp.postprocessor.PostProcessor):
    """Injects human title, upload date, series, and clean filename into yt-dlp info_dict."""

    def __init__(self, downloader, ep_meta: dict):
        super().__init__(downloader)
        self.ep_meta = ep_meta

    def run(self, info: dict) -> tuple[list, dict]:
        info["title"] = self.ep_meta["title"]
        info["upload_date"] = self.ep_meta["upload_date"]
        info["custom_year"] = self.ep_meta["year"]
        info["custom_series"] = self.ep_meta["series"]
        info["custom_filename"] = self.ep_meta["filename"]
        if self.ep_meta.get("logo") and not info.get("thumbnails"):
            info["thumbnails"] = [{"url": self.ep_meta["logo"], "id": "0"}]
        return [], info


def main():
    parser = argparse.ArgumentParser(
        description="Full BSWA Deeper Dhamma podcast archiver (~3,320 episodes) with local catalog caching."
    )
    parser.add_argument(
        "--target-dir",
        "-t",
        type=Path,
        default=Path(__file__).resolve().parent / "archive",
        help="Target directory for downloaded podcast files (default: archive/)",
    )
    parser.add_argument(
        "--catalog-file",
        default="catalog.json",
        help="Local JSON catalog filename (default: catalog.json)",
    )
    parser.add_argument(
        "--refresh-catalog",
        action="store_true",
        default=False,
        help="Force re-crawling all 166 pages even if catalog.json exists",
    )
    parser.add_argument(
        "--rate-limit-mb",
        "-r",
        type=int,
        default=10,
        help="Speed ceiling in MB/s (default: 10 MB/s)",
    )
    parser.add_argument(
        "--connections",
        "-c",
        type=int,
        default=3,
        help="Number of download connections per file (default: 3)",
    )
    parser.add_argument(
        "--sleep-seconds",
        "-s",
        type=int,
        default=1,
        help="Delay in seconds between downloading episodes (default: 1)",
    )
    parser.add_argument(
        "--archive-file",
        default="archive.log",
        help="File tracking already-downloaded episode IDs (default: archive.log)",
    )
    parser.add_argument(
        "--year",
        "-y",
        type=str,
        default=None,
        help="Optional: Filter downloads to a specific year (e.g. 2026, 2025)",
    )
    parser.add_argument(
        "--limit",
        "-l",
        type=int,
        default=None,
        help="Optional: Maximum number of episodes to download in this run",
    )
    parser.add_argument(
        "--catalog-only",
        action="store_true",
        default=False,
        help="Only fetch, update, or generate the catalog without downloading episodes",
    )
    parser.add_argument(
        "--reorganize",
        action="store_true",
        default=False,
        help="Scan and reorganize existing audio files into their true date/year folders",
    )
    parser.add_argument(
        "--allow-non-english",
        action="store_true",
        default=False,
        help="Include non-English talks (e.g. Thai language, Sinhalese translation). Default is English only.",
    )
    parser.add_argument(
        "--log-file",
        default="sync_deeper_dhamma.log",
        help="Script log file path (default: sync_deeper_dhamma.log in repo root)",
    )

    args = parser.parse_args()

    script_dir = Path(__file__).resolve().parent
    log_path = script_dir / args.log_file
    setup_logging(log_path)

    logger.debug(f"=== Sync Session Initialized ===")
    logger.debug(f"Command line arguments: {args}")

    # Ensure required external binaries (auto-detect in WinGet if not in PATH)
    for binary in ("aria2c", "ffmpeg"):
        if not ensure_binary(binary):
            logger.error(f"[-] Error: Required dependency '{binary}' was not found.")
            sys.exit(1)

    target_dir = args.target_dir.resolve()
    target_dir.mkdir(parents=True, exist_ok=True)
    os.chdir(target_dir)

    catalog_path = (script_dir / args.catalog_file) if (script_dir / args.catalog_file).exists() else (target_dir / args.catalog_file)
    archive_file = (script_dir / args.archive_file) if (script_dir / args.archive_file).exists() else (target_dir / args.archive_file)

    # Load or crawl catalog
    catalog = get_or_update_catalog(catalog_path, refresh=args.refresh_catalog)

    # Automatically reorganize any previously downloaded files to true dates/locations
    reorganize_existing_files(target_dir, catalog, allow_non_english=args.allow_non_english)

    if args.reorganize:
        logger.info("[✓] Reorganization finished.")
        return

    if args.catalog_only or (args.limit is not None and args.limit <= 0):
        logger.info(f"[+] Catalog '{args.catalog_file}' is ready ({len(catalog)} episodes indexed). Exiting as requested.")
        return

    # Read archive.log into memory
    archive_entries = set()
    if archive_file.exists():
        with open(archive_file, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) >= 2:
                    archive_entries.add(parts[1])
                elif parts:
                    archive_entries.add(parts[0])

    # Filter catalog
    all_pending = []
    for ep in catalog:
        # Filter out non-English talks by default
        if not args.allow_non_english and not is_english_talk(ep["title"]):
            continue

        year, series, filename = parse_episode_metadata(ep["title"], ep["upload_date"])

        if args.year and not (year == args.year or ep.get("upload_date", "").startswith(args.year)):
            continue

        # Check if already in archive.log or existing on disk
        dest_mp3 = target_dir / year / series / f"{filename}.mp3"
        dest_m4a = target_dir / year / series / f"{filename}.m4a"

        file_exists = (
            (dest_mp3.exists() and dest_mp3.stat().st_size > 1024 * 1024)
            or (dest_m4a.exists() and dest_m4a.stat().st_size > 1024 * 1024)
        )

        ep_id = ep.get("id") or ""
        media_url = ep.get("media_url") or ""
        guid_match = any(e in archive_entries for e in [ep_id, media_url, filename] if e)

        if file_exists or guid_match:
            continue

        all_pending.append({
            **ep,
            "series": series,
            "filename": filename,
            "year": year,
        })

    def is_in_scope(ep_item: dict) -> bool:
        if not args.allow_non_english and not is_english_talk(ep_item["title"]):
            return False
        if not args.year:
            return True
        y, _, _ = parse_episode_metadata(ep_item["title"], ep_item["upload_date"])
        return y == args.year or ep_item.get("upload_date", "").startswith(args.year)

    total_in_scope = len([ep for ep in catalog if is_in_scope(ep)])
    completed = total_in_scope - len(all_pending)

    pending_episodes = all_pending[: args.limit] if args.limit is not None else all_pending

    lang_desc = "English Only" if not args.allow_non_english else "All Languages"
    logger.info(f"[*] Target Directory:    {target_dir}")
    logger.info(f"[*] Script Log File:     {log_path}")
    logger.info(f"[*] Language Filter:     {lang_desc}")
    logger.info(f"[*] Episodes in Scope:   {total_in_scope}" + (f" (Year: {args.year})" if args.year else ""))
    logger.info(f"[*] Already Synced:      {completed}")
    logger.info(f"[*] Pending Download:    {len(all_pending)}" + (f" (Capped to first {len(pending_episodes)} this run)" if args.limit is not None else ""))
    logger.info(f"[*] Speed Cap:           {args.rate_limit_mb} MB/s")
    logger.info(f"[*] Connections / File:  {args.connections}")
    logger.info(f"[*] Inter-Episode Delay: {args.sleep_seconds}s")
    logger.info("[*] Cover Art:           Embedded directly into audio (ID3v2 APIC)")
    logger.info("[*] Press Ctrl+C at any time to pause. Rerunning will resume safely.\n")

    if not pending_episodes:
        logger.info("[✓] All episodes in scope are already downloaded and up to date!")
        return

    rate_limit_arg = f"--max-overall-download-limit={max(1, args.rate_limit_mb)}M"
    aria2_args = [
        f"-x{max(1, args.connections)}",
        f"-s{max(1, args.connections)}",
        "-k1M",
        "-c",
        rate_limit_arg,
        "--console-log-level=warn",
        "--summary-interval=0",
    ]

    success_count = 0
    for idx, ep in enumerate(pending_episodes, start=1):
        current_num = completed + idx
        logger.info(f"[{current_num}/{total_in_scope}] Ingesting: {ep['title']}")
        logger.info(f"   -> Folder: {ep['year']}/{ep['series']}/")
        logger.info(f"   -> File:   {ep['filename']}.mp3")

        ydl_opts = {
            "downloader": "aria2c",
            "downloader_args": {"aria2c": aria2_args},
            "download_archive": str(archive_file),
            "add_metadata": True,
            "writethumbnail": True,
            "logger": YTDLPLogAdapter(logger),
            "postprocessors": [
                {
                    "key": "FFmpegMetadata",
                    "add_metadata": True,
                },
                {
                    "key": "EmbedThumbnail",
                    "already_have_thumbnail": False,
                },
            ],
            "windowsfilenames": True,
            "retries": 10,
            "fragment_retries": 10,
            "outtmpl": "%(custom_year)s/%(custom_series)s/%(custom_filename)s.%(ext)s",
            "quiet": True,
            "no_warnings": False,
        }

        t0 = time.time()
        try:
            ydl = yt_dlp.YoutubeDL(ydl_opts)
            ydl.add_post_processor(CatalogEpisodePP(ydl, ep), when="pre_process")
            ret = ydl.download([ep["media_url"]])
            if ret == 0:
                success_count += 1
                elapsed = time.time() - t0
                dest_mp3 = target_dir / ep["year"] / ep["series"] / f"{ep['filename']}.mp3"
                dest_m4a = target_dir / ep["year"] / ep["series"] / f"{ep['filename']}.m4a"
                dest_file = dest_mp3 if dest_mp3.exists() else dest_m4a
                size_str = f" ({dest_file.stat().st_size / (1024 * 1024):.1f} MB)" if dest_file.exists() else ""
                logger.info(f"   [✓] Completed in {elapsed:.1f}s{size_str} - tagged with cover art\n")
                if ep.get("id"):
                    with open(archive_file, "a", encoding="utf-8") as af:
                        af.write(f"generic {ep['id']}\n")
            if args.sleep_seconds > 0 and idx < len(pending_episodes):
                time.sleep(args.sleep_seconds)
        except KeyboardInterrupt:
            logger.info("\n[*] Interrupted by user. Run again to resume downloads.")
            sys.exit(130)
        except Exception as e:
            logger.error(f"[!] Error downloading '{ep['title']}': {e}", exc_info=True)

    logger.info(f"[✓] Sync finished: {success_count} episode(s) downloaded.")


if __name__ == "__main__":
    main()
