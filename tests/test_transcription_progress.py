"""
Unit tests for TranscriptionProgressBar and live transcription progress reporting.
"""

from io import StringIO
from unittest.mock import MagicMock, patch
import pytest

from deeper_dhamma.asr import Transcriber, TranscriptionProgressBar
from deeper_dhamma.cli import main


def test_progress_bar_initialization():
    """Verifies that progress bar initializes state and guards zero or negative totals."""
    sio = StringIO()
    pbar = TranscriptionProgressBar(total_sec=3600.0, desc="Testing", file=sio)
    assert pbar.total_sec == 3600.0
    assert pbar.desc == "Testing"
    assert pbar.turn_count == 0
    assert pbar.current_sec == 0.0

    # Guard zero / negative
    pbar_zero = TranscriptionProgressBar(total_sec=0.0, file=sio)
    assert pbar_zero.total_sec > 0


def test_progress_bar_non_tty_milestones():
    """Verifies periodic milestone output when writing to non-TTY streams."""
    sio = StringIO()
    with TranscriptionProgressBar(total_sec=100.0, file=sio) as pbar:
        # Step through 10s increments
        for sec in range(10, 110, 10):
            pbar.update(current_sec=float(sec), text=f"turn at {sec}s")

    output = sio.getvalue()
    assert "Testing" not in output
    assert "10.0%" in output
    assert "50.0%" in output
    assert "100.0%" in output
    assert "[✓] Transcribing" in output
    assert "10 turns" in output


def test_progress_bar_tty_rendering_and_width_adaptation():
    """Verifies in-place carriage return rendering across different terminal widths."""
    sio = StringIO()
    sio.isatty = lambda: True

    with patch("shutil.get_terminal_size", return_value=MagicMock(columns=80)):
        with TranscriptionProgressBar(total_sec=3600.0, file=sio) as pbar:
            pbar.update(1800.0, text="A long phrase that should be truncated safely on narrow screens")

    output = sio.getvalue()
    assert "\r" in output
    assert "50.0%" in output or "50%" in output
    assert "[✓]" in output


def test_progress_bar_close_idempotent():
    """Verifies that calling close multiple times does not duplicate completion line."""
    sio = StringIO()
    pbar = TranscriptionProgressBar(total_sec=60.0, file=sio)
    pbar.update(60.0)
    pbar.close()
    first_output = sio.getvalue()
    pbar.close()
    assert sio.getvalue() == first_output


def test_transcriber_transcribe_progress_integration():
    """Verifies that Transcriber.transcribe drives the progress bar and callback."""
    import numpy as np

    # Mock WhisperModel
    mock_model = MagicMock()
    seg1 = MagicMock()
    seg1.start = 0.0
    seg1.end = 15.0
    seg1.text = "Hello dhamma world"
    seg1.words = []
    seg1.avg_logprob = -0.2
    seg1.no_speech_prob = 0.01

    seg2 = MagicMock()
    seg2.start = 15.0
    seg2.end = 30.0
    seg2.text = "Second segment of speech"
    seg2.words = []
    seg2.avg_logprob = -0.15
    seg2.no_speech_prob = 0.02

    mock_model.transcribe.return_value = ([seg1, seg2], MagicMock())

    with patch("deeper_dhamma.asr.WhisperModel", return_value=mock_model):
        transcriber = Transcriber(model_size="tiny", device="cpu", compute_type="float32")

    dummy_audio = np.zeros(30 * 16000, dtype=np.float32)

    callback_records = []
    def on_progress(cur, total, txt):
        callback_records.append((cur, total, txt))

    sio = StringIO()
    with patch("sys.stdout", sio):
        segs = transcriber.transcribe(
            dummy_audio,
            show_progress=True,
            progress_callback=on_progress,
        )

    assert len(segs) == 2
    assert segs[0]["text"] == "Hello dhamma world"
    assert segs[1]["text"] == "Second segment of speech"
    assert len(callback_records) == 2
    assert callback_records[0][0] == 15.0
    assert callback_records[1][0] == 30.0
    assert "Second segment" in callback_records[1][2]


def test_transcriber_transcribe_suppress_progress():
    """Verifies that show_progress=False suppresses progress bar output."""
    import numpy as np

    mock_model = MagicMock()
    seg = MagicMock()
    seg.start = 0.0
    seg.end = 10.0
    seg.text = "Silent progress"
    seg.words = []
    seg.avg_logprob = -0.1
    seg.no_speech_prob = 0.01

    mock_model.transcribe.return_value = ([seg], MagicMock())

    with patch("deeper_dhamma.asr.WhisperModel", return_value=mock_model):
        transcriber = Transcriber(model_size="tiny", device="cpu", compute_type="float32")

    dummy_audio = np.zeros(10 * 16000, dtype=np.float32)
    sio = StringIO()
    with patch("sys.stdout", sio):
        transcriber.transcribe(dummy_audio, show_progress=False)

    assert sio.getvalue() == ""


def test_cli_transcribe_no_progress_flag():
    """Verifies that --no-progress flag is parsed correctly by the CLI."""
    with patch("deeper_dhamma.cli.cmd_transcribe") as mock_cmd:
        main(["transcribe", "--id", "pb27940021", "--no-progress"])
        mock_cmd.assert_called_once()
        args = mock_cmd.call_args[0][0]
        assert args.no_progress is True

