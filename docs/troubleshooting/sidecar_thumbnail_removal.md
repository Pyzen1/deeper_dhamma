# Sidecar Cover-Art Thumbnail Bloat & Removal

## 1. Symptoms

Although `run_sync` disabled post-download cover art embedding (`safe_embed_cover_art` is never called) to preserve 1:1 Podbean CDN bitstream parity for VBR audio seeking, `archive/` still accumulated nearly as many image files as audio files:

- `archive/` contained `5,929` files across `184` directories: `2,972` audio files (`2,598` `.mp3`, `374` `.m4a`) and **`2,957` sidecar cover-art thumbnails** (`2,541` `.jpg`, `348` `.png`, `68` `.jpeg`), occupying **`365,803,372` bytes (`348.86 MB`)**.
- Across all `2,957` sidecar image files, there were only **`48` unique SHA-256 hashes** (led by **`1,460` identical copies** of `21,646`-byte JPG `0cc5b8d012d7`, matching the `50` unique `logo` URLs across `catalog.json`'s `3,323` episodes).
- `499` `.mp3` files already carry native Podbean `ID3` `APIC` tags from the CDN (`2,099` do not), while no transcript, search, alignment, or web component ever reads sidecar images from `archive/`.

---

## 2. Architecture & Safety Analysis

```text
+---------------------------------------------------------------------------------------------------+
| BEFORE: Bitstream Audio + Redundant Sidecar Thumbnails Written Per Talk                           |
+---------------------------------------------------------------------------------------------------+
| [CatalogEpisodePP] --> Injects ep_meta["logo"] into info["thumbnails"]                            |
| [ydl_opts]         --> "writethumbnail": True writes <stem>.jpg/.png/.jpeg beside every audio     |
| [archive/]         --> 2,972 audio files + 2,957 duplicated sidecar images (48 unique SHA-256)    |
| [voiceprints.py]   --> archive_dir.rglob(f"{ep_id}.*") exposed to matching .jpg/.png before audio |
+---------------------------------------------------------------------------------------------------+
                                                 |
                                                 v
+---------------------------------------------------------------------------------------------------+
| AFTER: Audio-Only Archive + Zero Sidecar Thumbnail Downloads                                      |
+---------------------------------------------------------------------------------------------------+
| [CatalogEpisodePP] --> Sets title, upload_date, custom_year, custom_series, custom_filename only  |
| [ydl_opts]         --> "writethumbnail": False (no sidecar images fetched or written to disk)     |
| [archive/]         --> 2,972 pristine audio files only (2,598 .mp3 + 374 .m4a | 140.61 GB)        |
+---------------------------------------------------------------------------------------------------+
```

### Pre-Removal Dependency Checks
1. **Runtime Code**: `deeper_dhamma/status.py`, `deeper_dhamma/storage.py`, `deeper_dhamma/downloader.py` completion checks (`dest_mp3`, `dest_m4a`), and `deeper_dhamma/export_web.py` / `deeper_dhamma/web/*` never read sidecar image files in `archive/`.
2. **Databases & Logs**: `dhamma_transcripts.db`, `pipeline_state.db` (`episode_states` / `filepath`), and `archive.log` contain `0` `.jpg`/`.jpeg`/`.png`/`.webp` paths.
3. **Archive Stem Parity**: Every single one of the `2,957` image files matched an existing sibling `.mp3` or `.m4a` stem in the same directory (`0` orphan images, `0` empty directories).
4. **Latent Risk Eliminated**: Removing sidecar images prevents `deeper_dhamma/voiceprints.py` (`Path(archive_dir).rglob(f"{ep_id}.*")`) from matching non-audio image files before audio files.

---

## 3. Changes Applied

1. **`deeper_dhamma/downloader.py`**:
   - Set `"writethumbnail": False` inside `run_sync`'s `ydl_opts`.
   - Removed synthetic `info["thumbnails"]` injection from `CatalogEpisodePP.run` while keeping `title`, `upload_date`, `custom_year`, `custom_series`, and `custom_filename` required by `outtmpl`.
   - Updated the module docstring to reflect 1:1 bitstream audio downloads without sidecar thumbnails or ID3 re-muxing.
   - Retained `safe_embed_cover_art` (unused in `run_sync`) and `deeper_dhamma/audit.py` thumbnail probing so existing bitstream-parity and audit unit tests remain intact.
2. **`tests/test_downloader_parity.py`**:
   - Added `test_downloader_disables_thumbnail_downloads` to enforce `"writethumbnail": False` in `run_sync` and confirm `CatalogEpisodePP.run` does not populate `"thumbnails"`.
3. **Archive Cleanup**:
   - Deleted all `2,957` verified sidecar images (`2,541` `.jpg`, `348` `.png`, `68` `.jpeg`; `348.86 MB` reclaimed), leaving `2,972` audio files (`2,598` `.mp3`, `374` `.m4a`) with `0` empty directories and `0` errors.

---

## 4. Verification

```powershell
# 1. Archive health & file inventory
python main.py status -s
python main.py audit --scan -w 16

# 2. Verify sync does not re-download missing thumbnails
python main.py sync --all --dry-run

# 3. Run unit & parity tests
pytest tests/test_downloader_parity.py tests/test_audit.py -q
```

Verified outcomes after cleanup:
- `python main.py status -s`: `3,251 / 3,251 synced`, `0` pending downloads, `2,972` audio files (`2,598 MP3, 374 M4A | 140.61 GB`).
- `python main.py sync --all --dry-run`: `3251 verified pristine, 0 pending download/repair`.
- `python main.py audit --scan -w 16`: `3,156` entries scanned in `7.6s`, `0` issues detected.
- `python -m pytest -q`: `185 passed`.
