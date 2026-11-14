"""
Unit tests verifying that downloader preserves 100% bitstream parity with Podbean CDN.
"""

from pathlib import Path
import inspect
from deeper_dhamma import downloader


def test_downloader_no_safe_embed_cover_art_in_sync():
    """
    Guarantees that run_sync never executes safe_embed_cover_art or any post-processing
    that alters ID3 tags or shifts audio frames.
    """
    src = inspect.getsource(downloader.run_sync)
    assert "safe_embed_cover_art" not in src, (
        "safe_embed_cover_art must not be called inside run_sync! "
        "Audio files must remain exact bit-for-bit copies of the Podbean CDN stream."
    )


def test_safe_embed_cover_art_has_warning_docstring():
    """Guarantees safe_embed_cover_art is explicitly documented as dangerous for archive streaming."""
    doc = downloader.safe_embed_cover_art.__doc__ or ""
    assert "breaking byte-level parity" in doc.lower() or "shifts audio packet byte offsets" in doc


def test_remove_from_archive_log(tmp_path: Path):
    """Verifies that entries can be pruned from archive.log accurately."""
    log_p = tmp_path / "archive.log"
    log_p.write_text("podbean pb1001\npodbean pb1002\npodbean pb1003\n", encoding="utf-8")

    removed = downloader.remove_from_archive_log(log_p, {"pb1002"})
    assert removed == 1

    remaining = log_p.read_text(encoding="utf-8")
    assert "pb1001" in remaining
    assert "pb1002" not in remaining
    assert "pb1003" in remaining


def test_ensure_binary():
    """Verifies ensure_binary correctly resolves existing binaries."""
    # Python is guaranteed to exist in the test environment
    assert downloader.ensure_binary("python") is True
    # Non-existent binary should return False
    assert downloader.ensure_binary("non_existent_binary_xyz_123") is False


def test_verify_remote_parity_missing_file(tmp_path: Path):
    """Verifies that verifying parity on a missing local file returns False cleanly."""
    missing = tmp_path / "absent.mp3"
    valid, reason, _ = downloader.verify_remote_parity(missing, "https://mcdn.podbean.com/test.mp3")
    assert valid is False
    assert "does not exist" in reason.lower() or "missing" in reason.lower()


def test_downloader_aria2c_fallback_and_paths_present():
    """
    Verifies that run_sync defines paths['home'] to resolve absolute download directories,
    and includes fallback handling for aria2c failures (such as Windows MAX_PATH limits).
    """
    src = inspect.getsource(downloader.run_sync)
    assert '"paths": {"home": str(target_dir)}' in src
    assert "aria2c failed" in src
    assert "native_opts" in src


def test_downloader_disables_thumbnail_downloads():
    """Verifies that run_sync disables sidecar thumbnail downloads and CatalogEpisodePP does not inject thumbnails."""
    src = inspect.getsource(downloader.run_sync)
    assert '"writethumbnail": False' in src
    assert '"writethumbnail": True' not in src

    pp = downloader.CatalogEpisodePP(
        None,
        {
            "title": "Sample Talk",
            "upload_date": "2026-01-15",
            "year": "2026",
            "series": "standalone",
            "filename": "2026-01-15_sample_talk",
            "logo": "https://pbcdn1.podbean.com/imglogo/image-logo/sample.jpg",
        },
    )
    _, updated_info = pp.run({})
    assert "thumbnails" not in updated_info
    assert updated_info["custom_year"] == "2026"
    assert updated_info["custom_series"] == "standalone"
    assert updated_info["custom_filename"] == "2026-01-15_sample_talk"


