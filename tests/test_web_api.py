"""
Tests for Bottle web API endpoints including date range filters, sorting, and episode search.
"""

import io
import json
import pytest
from deeper_dhamma.web.app import create_app


@pytest.fixture(scope="module")
def wsgi_client():
    app = create_app()

    def _get(path: str, qs: str = ""):
        status_box, headers_box = [], []

        def start_response(s, h, exc_info=None):
            status_box.append(s)
            headers_box.extend(h)

        environ = {
            "REQUEST_METHOD": "GET",
            "PATH_INFO": path,
            "QUERY_STRING": qs,
            "SERVER_NAME": "localhost",
            "SERVER_PORT": "80",
            "wsgi.version": (1, 0),
            "wsgi.url_scheme": "http",
            "wsgi.input": io.BytesIO(),
            "wsgi.errors": io.StringIO(),
            "wsgi.multithread": False,
            "wsgi.multiprocess": False,
            "wsgi.run_once": False,
        }
        body = b"".join(app(environ, start_response))
        data = json.loads(body.decode("utf-8")) if body else {}
        return status_box[0], dict(headers_box), data

    return _get


def test_api_episodes_listing(wsgi_client):
    status, headers, data = wsgi_client("/api/episodes", "limit=5&sort=date_desc")
    assert status.startswith("200")
    assert "episodes" in data
    assert len(data["episodes"]) <= 5
    assert data["total"] >= len(data["episodes"])


def test_api_episodes_date_range_filter(wsgi_client):
    status, headers, data = wsgi_client("/api/episodes", "start_date=2026-01-01&end_date=2026-12-31")
    assert status.startswith("200")
    for ep in data["episodes"]:
        assert ep["date"] >= "2026-01-01"
        assert ep["date"] <= "2026-12-31"


def test_api_episodes_sorting(wsgi_client):
    status, _, data_asc = wsgi_client("/api/episodes", "sort=date_asc&limit=10")
    assert status.startswith("200")
    dates_asc = [e["date"] for e in data_asc["episodes"] if e.get("date")]
    assert dates_asc == sorted(dates_asc)

    status, _, data_desc = wsgi_client("/api/episodes", "sort=date_desc&limit=10")
    assert status.startswith("200")
    dates_desc = [e["date"] for e in data_desc["episodes"] if e.get("date")]
    assert dates_desc == sorted(dates_desc, reverse=True)


def test_api_search_with_filters(wsgi_client):
    status, _, data = wsgi_client("/api/search", "q=mind&start_date=2026-01-01&end_date=2026-12-31&sort=date_desc")
    assert status.startswith("200")
    assert "results" in data
    for r in data["results"]:
        assert r["date"] >= "2026-01-01"
        assert r["date"] <= "2026-12-31"


def test_api_search_empty_query(wsgi_client):
    status, _, data = wsgi_client("/api/search", "q=")
    assert status.startswith("200")
    assert data["results"] == []
    assert data["count"] == 0
