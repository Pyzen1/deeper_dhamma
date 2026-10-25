"""
Bottle.py Web Application and JSON REST API for Deeper Dhamma.
Enables instant full-text search, turn-level audio timeline playback via Podbean CDN,
episode transcript browsing, and Buddhist doctrinal lexicon lookups.
"""

import json
import logging
import os
import sqlite3
import time
from pathlib import Path
from typing import Dict, List, Optional

from bottle import Bottle, HTTPResponse, request, response, static_file

from deeper_dhamma.config import (
    BUDDHISM_LEXICON_DB_PATH,
    DEFAULT_WEB_HOST,
    DEFAULT_WEB_PORT,
    TRANSCRIPTS_DB_PATH,
)
from deeper_dhamma.lexicon import BuddhismLexiconDatabase
from deeper_dhamma.storage import TranscriptDatabase

logger = logging.getLogger("deeper_dhamma.web")

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
VIEWS_DIR = BASE_DIR / "views"


def json_response(data: dict, status: int = 200) -> HTTPResponse:
    """Helper to return JSON responses with proper headers and UTF-8 encoding."""
    return HTTPResponse(
        body=json.dumps(data, ensure_ascii=False),
        status=status,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        },
    )


def create_app() -> Bottle:
    """Factory creating and configuring the Bottle web application."""
    app = Bottle()
    db = TranscriptDatabase()
    lexicon_db = BuddhismLexiconDatabase()

    @app.route("/static/db_client.js")
    @app.route("/db_client.js")
    def serve_db_client():
        return static_file("api_client.js", root=str(STATIC_DIR / "adapters"), mimetype="application/javascript")

    @app.route("/static/<filepath:path>", name="static")
    def serve_static(filepath: str):
        return static_file(filepath, root=str(STATIC_DIR))

    @app.route("/")
    def index():
        index_file = VIEWS_DIR / "index.html"
        if not index_file.exists():
            return "Web UI template missing."
        with open(index_file, "r", encoding="utf-8") as f:
            html = f.read()
        return HTTPResponse(body=html, status=200, headers={"Content-Type": "text/html; charset=utf-8"})

    @app.route("/api/search")
    def api_search():
        """
        Instant full-text search returning speech segments, snippets, timestamps,
        and direct Podbean CDN streaming URLs.
        """
        q = request.query.get("q", "").strip()
        limit = min(int(request.query.get("limit", 30)), 100)
        exact = request.query.get("exact", "0").lower() in ("1", "true", "yes")
        year_filter = request.query.get("year")
        teacher_filter = request.query.get("teacher")

        if not q:
            return json_response({
                "query": "",
                "results": [],
                "meta": {"tier": "none"},
                "count": 0,
                "elapsed_ms": 0.0,
            })

        t0 = time.perf_counter()
        results, meta = db.search_fts(query=q, limit=limit, return_meta=True, exact=exact)

        # Apply client-requested filters if present
        if year_filter:
            try:
                y = int(year_filter)
                results = [r for r in results if r.get("date", "").startswith(str(y))]
            except ValueError:
                pass

        if teacher_filter:
            tf = teacher_filter.lower()
            results = [r for r in results if tf in (r.get("teacher") or "").lower()]

        elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 2)

        return json_response({
            "query": q,
            "results": results,
            "meta": meta,
            "count": len(results),
            "elapsed_ms": elapsed_ms,
        })

    @app.route("/api/episodes")
    def api_episodes():
        """Lists episodes with optional year, teacher, or transcription status filtering."""
        year = request.query.get("year")
        teacher = request.query.get("teacher")
        transcribed_only = request.query.get("transcribed_only", "1") in ("1", "true")
        limit = min(int(request.query.get("limit", 50)), 200)
        offset = max(int(request.query.get("offset", 0)), 0)

        query_sql = "SELECT id, title, date, year, primary_display as teacher, media_url, permalink, duration_sec, is_transcribed FROM episodes WHERE 1=1"
        params = []

        if transcribed_only:
            query_sql += " AND is_transcribed = 1"
        if year:
            try:
                query_sql += " AND year = ?"
                params.append(int(year))
            except ValueError:
                pass
        if teacher:
            query_sql += " AND (primary_display LIKE ? OR id IN (SELECT episode_id FROM episode_teachers et JOIN teachers t ON et.teacher_id = t.id WHERE t.display_name LIKE ?))"
            params.extend([f"%{teacher}%", f"%{teacher}%"])

        query_sql += " ORDER BY date DESC, id DESC LIMIT ? OFFSET ?;"
        params.extend([limit, offset])

        with sqlite3.connect(TRANSCRIPTS_DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(query_sql, params).fetchall()
            episodes = [dict(r) for r in rows]

            # Count total
            count_sql = "SELECT COUNT(*) FROM episodes WHERE 1=1"
            c_params = []
            if transcribed_only:
                count_sql += " AND is_transcribed = 1"
            if year:
                try:
                    count_sql += " AND year = ?"
                    c_params.append(int(year))
                except ValueError:
                    pass
            if teacher:
                count_sql += " AND (primary_display LIKE ? OR id IN (SELECT episode_id FROM episode_teachers et JOIN teachers t ON et.teacher_id = t.id WHERE t.display_name LIKE ?))"
                c_params.extend([f"%{teacher}%", f"%{teacher}%"])
            total = conn.execute(count_sql, c_params).fetchone()[0]

        return json_response({
            "episodes": episodes,
            "total": total,
            "limit": limit,
            "offset": offset,
        })

    @app.route("/api/episodes/<episode_id>")
    def api_episode_detail(episode_id: str):
        """Returns full episode metadata and turn-by-turn transcribed speech segments."""
        ep = db.get_episode(episode_id)
        if not ep:
            return json_response({"error": "Episode not found"}, status=404)
        return json_response(ep)

    @app.route("/api/lexicon/lookup")
    def api_lexicon_lookup():
        """Looks up a Pali Buddhist doctrinal term."""
        term = request.query.get("term", "").strip()
        if not term:
            return json_response({"error": "term parameter required"}, status=400)
        data = lexicon_db.lookup_term(term)
        return json_response({
            "term": term,
            "found": data is not None,
            "data": data,
        })

    @app.route("/api/lexicon/search")
    def api_lexicon_search():
        """Searches Pali terms conceptually related to a query."""
        q = request.query.get("q", "").strip()
        limit = min(int(request.query.get("limit", 10)), 20)
        results = lexicon_db.search_context(q, limit=limit)
        return json_response({
            "query": q,
            "results": results,
            "count": len(results),
        })

    @app.route("/api/stats")
    def api_stats():
        """Returns archive catalog status, transcription progress, and filter options."""
        with sqlite3.connect(TRANSCRIPTS_DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            total_episodes = conn.execute("SELECT COUNT(*) FROM episodes;").fetchone()[0]
            transcribed_episodes = conn.execute("SELECT COUNT(*) FROM episodes WHERE is_transcribed = 1;").fetchone()[0]
            total_segments = conn.execute("SELECT COUNT(*) FROM speech_segments;").fetchone()[0]
            duration_row = conn.execute("SELECT SUM(duration_sec) FROM episodes WHERE is_transcribed = 1;").fetchone()
            total_duration_sec = duration_row[0] if duration_row and duration_row[0] else 0.0

            # Authoritative monastic teachers list from teachers table in DB
            teachers = [
                r[0] for r in conn.execute(
                    "SELECT display_name FROM teachers WHERE default_role != 'unregistered' AND slug != 'unknown_teacher' ORDER BY display_name;"
                ).fetchall()
            ]

            years = [
                r[0] for r in conn.execute(
                    "SELECT DISTINCT year FROM episodes WHERE is_transcribed = 1 AND year IS NOT NULL ORDER BY year DESC;"
                ).fetchall()
            ]

        return json_response({
            "total_episodes": total_episodes,
            "transcribed_episodes": transcribed_episodes,
            "transcribed_hours": round(total_duration_sec / 3600.0, 1),
            "total_segments": total_segments,
            "teachers": teachers,
            "years": years,
        })

    return app


def run_server(
    host: str = DEFAULT_WEB_HOST,
    port: int = DEFAULT_WEB_PORT,
    reloader: bool = False,
):
    """Starts the Bottle WSGI server."""
    app = create_app()
    logger.info("Starting Deeper Dhamma Web UI on http://%s:%d", host, port)
    app.run(host=host, port=port, reloader=reloader, server="wsgiref")


if __name__ == "__main__":
    run_server()
