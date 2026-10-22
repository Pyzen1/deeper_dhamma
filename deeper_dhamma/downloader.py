"""
Podbean Podcast Feed Sync and Downloader Interface.
"""

import sys
from pathlib import Path
from deeper_dhamma.config import ARCHIVE_DIR, CATALOG_PATH, ARCHIVE_LOG_PATH
import sync_deeper_dhamma_podcast


def run_sync(
    limit: int = None,
    series: str = None,
    year: int = None,
    dry_run: bool = False,
    workers: int = 3,
) -> None:
    """Wrapper around sync_deeper_dhamma_podcast main."""
    cmd_args = []
    if limit:
        cmd_args.extend(["--limit", str(limit)])
    if series:
        cmd_args.extend(["--series", str(series)])
    if year:
        cmd_args.extend(["--year", str(year)])
    if dry_run:
        cmd_args.append("--dry-run")
    if workers:
        cmd_args.extend(["--workers", str(workers)])

    # Call main
    orig_argv = sys.argv
    try:
        sys.argv = ["sync_deeper_dhamma_podcast.py"] + cmd_args
        sync_deeper_dhamma_podcast.main()
    finally:
        sys.argv = orig_argv
