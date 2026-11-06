"""
Unit tests for the Unified Command-Line Interface (cli.py).

Verifies:
1. "One Obvious Way" principle and deterministic help on incomplete input.
2. Argument parsing for all core subcommands (search, export, status, lexicon, audit, web, serve).
3. Explicit action trigger requirements (e.g. --run required for execution).
4. CLI command execution dispatching with non-destructive dry-run/read-only parameters.
"""

import sys
from io import StringIO
from pathlib import Path
from unittest.mock import patch
import pytest

from deeper_dhamma.cli import (
    cmd_audit,
    cmd_export,
    cmd_lexicon,
    cmd_search,
    cmd_status,
    cmd_web,
    main,
)


def test_cli_empty_argv_prints_top_level_help_and_exits():
    """Verifies running with no arguments prints top-level usage and exits cleanly with code 0."""
    with patch("sys.stdout", new_callable=StringIO) as mock_out:
        with pytest.raises(SystemExit) as exc_info:
            main([])
        assert exc_info.value.code == 0
        output = mock_out.getvalue()
        assert "BSWA Deeper Dhamma" in output
        assert "Available subcommands" in output


def test_cli_subcommand_without_args_prints_subparser_help_and_exits():
    """Verifies that invoking a subcommand alone prints that command's help and exits with code 0."""
    for subcmd in ["search", "export", "status", "lexicon", "audit", "serve", "web"]:
        with patch("sys.stdout", new_callable=StringIO) as mock_out:
            with pytest.raises(SystemExit) as exc_info:
                main([subcmd])
            assert exc_info.value.code == 0
            output = mock_out.getvalue()
            assert f"usage: " in output or "help" in output.lower()


def test_cli_search_subcommand_parsing():
    """Verifies search subcommand argument routing and parameter extraction."""
    with patch("deeper_dhamma.cli.cmd_search") as mock_cmd:
        main(["search", "mindfulness", "--limit", "10", "--exact"])
        mock_cmd.assert_called_once()
        args = mock_cmd.call_args[0][0]
        assert args.query == "mindfulness"
        assert args.limit == 10
        assert args.exact is True


def test_cli_status_subcommand_parsing():
    """Verifies status subcommand argument parsing across flags."""
    with patch("deeper_dhamma.cli.cmd_status") as mock_cmd:
        main(["status", "--summary", "--year", "2026", "--json"])
        mock_cmd.assert_called_once()
        args = mock_cmd.call_args[0][0]
        assert args.summary is True
        assert args.year == 2026
        assert args.json is True


def test_cli_export_subcommand_parsing():
    """Verifies export subcommand argument parsing."""
    with patch("deeper_dhamma.cli.cmd_export") as mock_cmd:
        main(["export", "--id", "pb28113880", "--format", "vtt", "--output-dir", "exports/"])
        mock_cmd.assert_called_once()
        args = mock_cmd.call_args[0][0]
        assert args.id == "pb28113880"
        assert args.format == "vtt"
        assert args.output_dir == "exports/"


def test_cli_lexicon_subcommand_parsing():
    """Verifies lexicon subcommand argument parsing."""
    with patch("deeper_dhamma.cli.cmd_lexicon") as mock_cmd:
        main(["lexicon", "--lookup", "jhana"])
        mock_cmd.assert_called_once()
        args = mock_cmd.call_args[0][0]
        assert args.lookup == "jhana"


def test_cli_audit_subcommand_parsing():
    """Verifies audit subcommand argument parsing with dry-run safety."""
    with patch("deeper_dhamma.cli.cmd_audit") as mock_cmd:
        main(["audit", "--scan", "--quick", "--dry-run", "--workers", "4"])
        mock_cmd.assert_called_once()
        args = mock_cmd.call_args[0][0]
        assert args.scan is True
        assert args.quick is True
        assert args.dry_run is True
        assert args.workers == 4


def test_cli_web_and_serve_explicit_run_flags():
    """
    Verifies that commands with side effects require explicit action flags (-r/--run)
    in compliance with the Interface Design Principle.
    """
    with patch("deeper_dhamma.cli.cmd_serve") as mock_serve:
        main(["serve", "--run", "--port", "34266"])
        mock_serve.assert_called_once()
        args = mock_serve.call_args[0][0]
        assert args.run is True
        assert args.port == 34266

    with patch("deeper_dhamma.cli.cmd_web") as mock_web:
        main(["web", "--build", "--run", "--port", "8080"])
        mock_web.assert_called_once()
        args = mock_web.call_args[0][0]
        assert args.build is True
        assert args.run is True
        assert args.port == 8080


def test_cli_lexicon_live_lookup_execution():
    """Executes a live read-only lexicon lookup through the CLI router and verifies formatted output."""
    with patch("sys.stdout", new_callable=StringIO) as mock_out:
        main(["lexicon", "--lookup", "anapanasati"])
        output = mock_out.getvalue()
        assert "anapanasati" in output.lower()
        assert "breath" in output.lower() or "mindfulness" in output.lower()


def test_cli_status_live_summary_execution():
    """Executes a live read-only status summary through the CLI router and verifies formatted output."""
    with patch("sys.stdout", new_callable=StringIO) as mock_out:
        main(["status", "--summary"])
        output = mock_out.getvalue()
        assert "Deeper Dhamma" in output or "Catalog" in output or "Archive" in output

