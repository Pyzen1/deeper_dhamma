#!/usr/bin/env python3
"""
Main entry point for BSWA Deeper Dhamma Application.

Usage:
  python main.py sync        # Syncs podcast feed & downloads audio talks
  python main.py voiceprints # Manages reference speaker voiceprint embeddings
  python main.py transcribe  # Transcribes audio files & commits to SQLite
  python main.py search      # Instant full-text search across transcripts
  python main.py export      # Exports Markdown, WebVTT, or JSON on demand
  python main.py lexicon     # Queries Buddhism Lexicon DB (buddhism_lexicon.db)
  python main.py curate      # Curates & inspects gold-standard reference transcripts
  python main.py benchmark   # Evaluates accuracy against gold standards
  python main.py test        # Runs end-to-end sanity verification test
  python main.py status      # Inspects transcription progress and archive catalog
  python main.py audit       # Inspects, audits integrity, and cleans/scrubs archive
  python main.py serve       # Launches Bottle-based Web UI & search server
  python main.py web         # Compiles static site distribution or runs preview
"""

import sys
from pathlib import Path

# Ensure project root is on sys.path
PROJECT_ROOT = Path(__file__).resolve().parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from deeper_dhamma.cli import main

if __name__ == "__main__":
    main()
