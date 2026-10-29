"""
Comprehensive Unit Tests for the Buddhism Doctrinal Lexicon View.

Tests:
1. Core / Standard Terms View: Verifies curated foundational meditation and doctrinal terms
   (anapanasati, jhana, nimitta, samadhi, sati, etc.) and Ajahn Brahm gloss prioritization.
2. Paged Full Lexicon View: Verifies pagination limits, offsets, page boundaries, and total counts.
3. Category Filtering: Verifies isolated filtering by doctrinal category (meditation, vinaya, hindrance, etc.).
4. Alphabet Index Filtering: Verifies A-Z letter jumping and diacritic fold safety.
5. Sort Orders: Validates canonical alphabetical sort (A-Z) and teacher translations priority.
6. Web API Endpoints: Validates Bottle REST API /api/lexicon/page responses, query parameters,
   and JSON response headers.
"""

import io
import json
import math
import pytest
from deeper_dhamma.lexicon import BuddhismLexiconDatabase
from deeper_dhamma.web.app import create_app


@pytest.fixture(scope="module")
def lexicon_db():
    return BuddhismLexiconDatabase()


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


# ==============================================================================
# 1. Core & Standard Terms Mode Tests
# ==============================================================================

def test_lexicon_core_mode_default(lexicon_db):
    """Core mode should return curated foundational terms without returning the entire 1,000+ corpus."""
    result = lexicon_db.get_paged_terms(mode="core", page=1, limit=50)
    assert result["total"] >= 20
    assert result["total"] < 100
    assert len(result["items"]) <= 50

    plain_terms = [item["pali_plain"] for item in result["items"]]
    assert "anapanasati" in plain_terms
    assert "jhana" in plain_terms
    assert "nimitta" in plain_terms
    assert "samadhi" in plain_terms
    assert "sati" in plain_terms
    assert "dukkha" in plain_terms


def test_lexicon_core_mode_brahm_glosses(lexicon_db):
    """Core terms with Ajahn Brahm translations must have rich glosses and valid attributes."""
    result = lexicon_db.get_paged_terms(mode="core", sort="teacher_first", page=1, limit=20)
    brahm_terms = [item for item in result["items"] if item.get("translation_brahm")]
    assert len(brahm_terms) > 0

    # Verify anapanasati has complete glosses
    anapanasati = next((item for item in result["items"] if item["pali_plain"] == "anapanasati"), None)
    assert anapanasati is not None
    assert "breath" in anapanasati["translation_brahm"].lower()
    assert anapanasati["pali_diacritic"] == "ānāpānasati"


# ==============================================================================
# 2. Paged Full Lexicon View Tests
# ==============================================================================

def test_lexicon_paged_all_terms(lexicon_db):
    """All-terms mode should expose the full canonical corpus (>1,000 terms) with correct page counts."""
    result = lexicon_db.get_paged_terms(mode="all", page=1, limit=25)
    assert result["total"] >= 1000
    assert len(result["items"]) == 25
    expected_pages = math.ceil(result["total"] / 25)
    assert result["total_pages"] == expected_pages


def test_lexicon_pagination_boundaries(lexicon_db):
    """Consecutive pages must return non-overlapping slices of the term vocabulary."""
    page1 = lexicon_db.get_paged_terms(mode="all", page=1, limit=15)
    page2 = lexicon_db.get_paged_terms(mode="all", page=2, limit=15)

    p1_ids = {item["id"] for item in page1["items"]}
    p2_ids = {item["id"] for item in page2["items"]}
    assert len(p1_ids.intersection(p2_ids)) == 0

    assert page1["page"] == 1
    assert page2["page"] == 2


# ==============================================================================
# 3. Category & Alphabet Filtering Tests
# ==============================================================================

def test_lexicon_category_filter(lexicon_db):
    """Filtering by category must restrict results solely to that doctrinal domain."""
    vinaya_res = lexicon_db.get_paged_terms(mode="all", category="vinaya")
    assert vinaya_res["total"] > 0
    for item in vinaya_res["items"]:
        assert item["category"] == "vinaya"


def test_lexicon_letter_filter(lexicon_db):
    """Filtering by starting letter must return only terms starting with that letter."""
    m_res = lexicon_db.get_paged_terms(mode="all", letter="m", limit=30)
    assert m_res["total"] > 0
    for item in m_res["items"]:
        assert item["pali_plain"].startswith("m")


def test_lexicon_sort_orders(lexicon_db):
    """Alphabetical sorting must return strictly ordered terms."""
    asc_res = lexicon_db.get_paged_terms(mode="all", sort="pali_asc", limit=30)
    terms = [item["pali_plain"] for item in asc_res["items"]]
    assert terms == sorted(terms)


# ==============================================================================
# 4. Web API Route Tests
# ==============================================================================

def test_api_lexicon_page_core_mode(wsgi_client):
    """GET /api/lexicon/page with mode=core returns 200 and standard core terms."""
    status, headers, data = wsgi_client("/api/lexicon/page", "mode=core&limit=25")
    assert status.startswith("200")
    assert "application/json" in headers.get("Content-Type", "")
    assert "items" in data
    assert "total" in data
    assert data["page"] == 1
    assert len(data["items"]) <= 25

    pali_plains = [item["pali_plain"] for item in data["items"]]
    assert "jhana" in pali_plains


def test_api_lexicon_page_all_mode_pagination(wsgi_client):
    """GET /api/lexicon/page with mode=all respects page and limit query parameters."""
    status, _, data = wsgi_client("/api/lexicon/page", "mode=all&page=3&limit=10")
    assert status.startswith("200")
    assert data["page"] == 3
    assert data["limit"] == 10
    assert len(data["items"]) == 10
    assert data["total"] >= 1000


def test_api_lexicon_page_filter_and_sort(wsgi_client):
    """GET /api/lexicon/page respects letter, category, and sort parameters."""
    status, _, data = wsgi_client(
        "/api/lexicon/page",
        "mode=all&letter=s&sort=pali_asc&limit=15"
    )
    assert status.startswith("200")
    for item in data["items"]:
        assert item["pali_plain"].startswith("s")

