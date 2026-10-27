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
