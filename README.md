# Deeper Dhamma Podcast Archiver

Automated archiver and cataloger for the Buddhist Society of Western Australia (BSWA) **Deeper Dhamma** podcast archive (~3,320 episodes spanning 30+ years of Theravada Buddhist teachings, retreats, and Q&A sessions).

## Features

- **Full-Archive Parallel Discovery**: Automatically crawls Podbean's 166 pages in ~5 seconds and saves an instant-load local index (`catalog.json`).
- **Smart Catalog Sync**: On every run, queries Page 1 in ~0.2s. Automatically detects new uploads or backfilled historical releases without redundant full-crawls.
- **Accurate Historical Filing**: Automatically parses true talk years and dates from episode titles (e.g., historical retreats from 1997–2025 uploaded in batches), filing them into their proper year and series folders rather than batch upload dates.
- **English-Only Filtering**: Automatically filters out non-English talks (such as Thai retreats and Sinhalese translations) by default. Use `--allow-non-english` to include them.
- **Embedded Cover Art**: Embeds official podcast cover thumbnails into audio ID3 tags using `ffmpeg` with resilient Windows file-lock handling.
- **Bandwidth-Friendly & Polite**: Rate-limited to 10 MB/s, 3 connections per file via `aria2c`, and a 1-second delay between downloads.
- **Resilient & Resumable**: Automatically tracks downloaded episodes in `archive.log` and verifies disk presence. Press `Ctrl+C` to pause and resume seamlessly anytime.

## Quick Start

```powershell
# Run archiver (defaults to downloading into archive/)
python sync_deeper_dhamma_podcast.py

# Download only talks from a specific year (e.g. 2026)
python sync_deeper_dhamma_podcast.py --year 2026

# Refresh or check local catalog without downloading audio
python sync_deeper_dhamma_podcast.py --catalog-only

# Reorganize any previously downloaded files into true date/year folders
python sync_deeper_dhamma_podcast.py --reorganize
```

## Directory Structure

```text
deeper_dhamma/
├── catalog.json              # Full index of ~3,320 episodes
├── archive.log               # Download tracker
├── sync_deeper_dhamma_podcast.py
└── archive/                  # Audio downloads (ignored by git)
    ├── 1997/
    │   └── travelogue_through_jhanas/
    ├── 2025/
    │   └── standalone/
    └── 2026/
        ├── 2026_may_9_day_sutta_retreat/
        └── 2026_rains_retreat/
```
