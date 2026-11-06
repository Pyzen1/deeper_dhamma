"""
Unit tests for Static Web Application & SQLite WASM Compiler.
"""

from pathlib import Path
import sqlite3
import pytest

from deeper_dhamma.config import BUDDHISM_LEXICON_DB_PATH, TRANSCRIPTS_DB_PATH
from deeper_dhamma.export_web import compile_static_database


def test_compile_static_database_header_version_and_vocab_table(tmp_path: Path):
    """
    Verifies that compile_static_database consolidates transcripts and lexicon tables,
    stamps PRAGMA user_version in the SQLite 100-byte header, and builds the search_vocab table.
    """
    if not (TRANSCRIPTS_DB_PATH.exists() and BUDDHISM_LEXICON_DB_PATH.exists()):
        pytest.skip("Source databases not present for static compilation test")

    output_db = tmp_path / "test_dhamma_web.db"
    target_version = 20261106

    metrics = compile_static_database(output_db, version_int=target_version)

    assert output_db.exists()
    assert metrics["version"] == target_version
    assert metrics["size_bytes"] > 0
    assert metrics["episodes"] >= 0
    assert metrics["terms"] >= 1000

    # Inspect compiled database directly
    with sqlite3.connect(output_db) as conn:
        # 1. Header user_version
        user_version = conn.execute("PRAGMA user_version;").fetchone()[0]
        assert user_version == target_version

        # 2. search_vocab table compliance
        vocab_info = conn.execute("PRAGMA table_info(search_vocab);").fetchall()
        assert len(vocab_info) >= 3
        pk_col = next(r[1] for r in vocab_info if r[5] == 1)
        assert pk_col == "id", "search_vocab table must use integer primary key 'id'"

        vocab_count = conn.execute("SELECT COUNT(*) FROM search_vocab;").fetchone()[0]
        assert vocab_count > 100

        # 3. v_terms view and fts_terms virtual table exist
        v_terms_sample = conn.execute("SELECT id, pali_plain, translation_bodhi FROM v_terms LIMIT 1;").fetchone()
        assert v_terms_sample is not None

        fts_sample = conn.execute("SELECT * FROM fts_terms WHERE fts_terms MATCH 'jhana' LIMIT 1;").fetchone()
        assert fts_sample is not None

