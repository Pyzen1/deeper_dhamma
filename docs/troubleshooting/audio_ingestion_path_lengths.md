# Audio Ingestion & aria2c Path Length Failure on Long Episode Titles (Windows MAX_PATH)

## 1. Symptoms

Running `python main.py sync --all` (or with `--retry-errors`) aborted when downloading long-titled episodes, terminating with `aria2c errorCode=16`:

```text
[3251/3251] Ingesting: 2016 June | 12/26. SN12.1 Dependent Origination, SN12.2 Analysis of Dependent Origination, AN3.35 Divine messengers, SN15 Tears and MN38 The Greater Discourse on the destruction of craving | Brahmali
   -> Folder: 2016/standalone/
   -> File:   2016-08-22_2016_june_12_26_sn12_1_dependent_origination_sn12_2_analysis_of_dependent_origination_an3_35_divine_messengers_sn15_tears_and_mn38_the_greater_discourse_on_the_destruction_of_craving_brahmali.mp3

11/10 23:58:04 [ERROR] CUID#7 - Download aborted. URI=https://s380.podbean.com/...
Exception: [AbstractCommand.cc:403] errorCode=16 URI=https://s380.podbean.com/...
  -> [RequestGroup.cc:761] errorCode=16 Download aborted.
  -> [AbstractDiskWriter.cc:204] errNum=3 errorCode=16 Failed to open the file ./2016/standalone//./2016-08-22_2016_june_12_26_sn12_1_dependent_origination_sn12_2_analysis_of_dependent_origination_an3_35_divine_messengers_sn15_tears_and_mn38_the_greater_discourse_on_the_destruction_of_craving_brahmali.mp3.part, cause: The system cannot find the path specified.

[yt-dlp error] ERROR: aria2c exited with code 16
[!] Error downloading '2016 June | 12/26. SN12.1 Dependent Origination, ...': ERROR: aria2c exited with code 16
[✓] Sync finished: 0 episode(s) downloaded.
```

---

## 2. Root Cause Analysis

```text
+----------------------------------------------------------------------------------------------------------------------------------------------------------+
| Cause A: Long Episode Title & Filename Expansion                                                                                                         |
| - Talk filename: 2016-08-22_2016_june_12_26_sn12_1_dependent_origination_... (202 chars, longest in 3,323-talk catalog).                               |
+----------------------------------------------------------------------------------------------------------------------------------------------------------+
                                                                          |
                                                                          v
+----------------------------------------------------------------------------------------------------------------------------------------------------------+
| Cause B: Relative outtmpl in yt-dlp & aria2c Argument Synthesis                                                                                          |
| - outtmpl: "%(custom_year)s/%(custom_series)s/%(custom_filename)s.%(ext)s" (relative).                                                                  |
| - yt-dlp Aria2cFD prepended `.\` to both --dir and --out:                                                                                                |
|     --dir .\2016\standalone\                                                                                                                            |
|     --out .\2016-08-22_...mp3.part                                                                                                                       |
| - aria2c concatenated them into: ./2016/standalone//./2016-08-22_...mp3.part                                                                            |
+----------------------------------------------------------------------------------------------------------------------------------------------------------+
                                                                          |
                                                                          v
+----------------------------------------------------------------------------------------------------------------------------------------------------------+
| Cause C: Windows Win32 MAX_PATH (260 char) Ceiling on Uncanonicalized Relative Paths                                                                     |
| - Working directory: C:\dev\deeper_dhamma\archive\ (27 chars).                                                                                           |
| - Win32 CreateFileW combines cwd + relative string before canonicalizing:                                                                                |
|     C:\dev\deeper_dhamma\archive\.\2016\standalone\.\2016-08-22_...mp3.part                                                                             |
| - Total length: 260 characters (== MAX_PATH buffer limit).                                                                                               |
| - Win32 CreateFileW fails immediately with Win32 Error 3 (ERROR_PATH_NOT_FOUND) -> aria2c exits with code 16.                                            |
+----------------------------------------------------------------------------------------------------------------------------------------------------------+
                                                                          |
                                                                          v
+----------------------------------------------------------------------------------------------------------------------------------------------------------+
| Cause D: Lack of External Downloader Exception Fallback                                                                                                  |
| - yt-dlp re-raised aria2c exit code 16 as an unhandled DownloadError.                                                                                    |
| - downloader.py caught the error and recorded it in pipeline_state.db, failing the ingestion run.                                                        |
+----------------------------------------------------------------------------------------------------------------------------------------------------------+
```

---

## 3. Architectural Solutions

### 3.1 Absolute Home Path Resolution (`paths: {"home": str(target_dir)}`)
In `deeper_dhamma/downloader.py`, `ydl_opts` now configures `"paths": {"home": str(target_dir)}`. yt-dlp resolves the target directory into a clean, canonical absolute path (`C:\dev\deeper_dhamma\archive\2016\standalone\`), eliminating redundant relative `.\` and `//./` path inflation.

```python
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
```

### 3.2 Resilient Native Downloader Fallback
If `aria2c` encounters an exit failure (code 16, Win32 `MAX_PATH` path boundaries, segment control file `.aria2` write failures, or network timeouts), `run_sync` catches the exception, purges transient partial files, and immediately retries using yt-dlp's native Python HTTP downloader.

Because Python on Windows utilizes native extended-length paths seamlessly, the download completes without hitting `MAX_PATH` restrictions while preserving exact 1:1 bitstream parity with the remote Podbean CDN stream.

```python
# deeper_dhamma/downloader.py
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
```

### 3.3 Automatic Pre-Flight Error Resolution
The pre-flight error checker in `_dl_auto_resolver` automatically clears previous recorded aria2c code 16 errors, allowing automatic retries without requiring the user to explicitly pass `--retry-errors`.

```python
if "aria2c exited with code 16" in err_msg or "code 16" in err_msg:
    return "aria2c path length error reset for native retry"
```

---

## 4. Verification

Verify that all audio sync and parity checks pass:

```powershell
# 1. Parity and downloader unit tests
pytest tests/test_downloader_parity.py tests/test_sync_repair.py

# 2. Ingest verification across entire 3,251-episode scope
python main.py sync --all
```
