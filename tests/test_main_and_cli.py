"""
Unit tests for main.py launcher and CLI subcommands.
"""

import subprocess
import sys
from pathlib import Path
import pytest

from deeper_dhamma.config import PROJECT_ROOT


def test_main_module_help():
    """Verifies that python main.py --help executes successfully and lists all subcommands."""
    proc = subprocess.run(
        [sys.executable, str(PROJECT_ROOT / "main.py"), "--help"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert proc.returncode == 0
    stdout = proc.stdout
    assert "sync" in stdout
    assert "transcribe" in stdout
    assert "search" in stdout
    assert "export" in stdout
    assert "lexicon" in stdout
    assert "status" in stdout
    assert "audit" in stdout
    assert "web" in stdout
    assert "serve" in stdout


def test_cli_serve_without_run_flag_prints_help():
    """Verifies that running 'serve' without -r/--run prints help per CLI Interaction Principle."""
    proc = subprocess.run(
        [sys.executable, str(PROJECT_ROOT / "main.py"), "serve"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert proc.returncode == 0
    assert "-r" in proc.stdout or "--run" in proc.stdout


def test_cli_web_without_flags_prints_help():
    """Verifies that running 'web' without --build or -r/--run prints help."""
    proc = subprocess.run(
        [sys.executable, str(PROJECT_ROOT / "main.py"), "web"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert proc.returncode == 0
    assert "--build" in proc.stdout or "--run" in proc.stdout


def test_cli_test_without_run_flag_prints_help():
    """Verifies that running 'test' without -r/--run prints help."""
    proc = subprocess.run(
        [sys.executable, str(PROJECT_ROOT / "main.py"), "test"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert proc.returncode == 0
    assert "-r" in proc.stdout or "--run" in proc.stdout


def test_cli_lexicon_lookup():
    """Verifies that 'lexicon --lookup' displays canonical Pali details."""
    proc = subprocess.run(
        [sys.executable, str(PROJECT_ROOT / "main.py"), "lexicon", "--lookup", "jhana"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert proc.returncode == 0
    assert "jhana" in proc.stdout.lower()

