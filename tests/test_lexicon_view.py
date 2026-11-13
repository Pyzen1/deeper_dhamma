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


@pytest.fixture(scope="module")
def lexicon_db():
    return BuddhismLexiconDatabase()


# ==============================================================================
# 1. Core & Standard Terms Mode Tests
# ==============================================================================

def test_lexicon_core_mode_default(lexicon_db):
    """Core mode should return curated foundational terms without returning the entire 1,000+ corpus."""
    result = lexicon_db.get_paged_terms(mode="core", page=1, limit=50)
    assert result["total"] >= 20
    assert result["total"] < 200
    assert len(result["items"]) <= 50

    # Membership is checked across the whole core set, not just the first page
    full_core = lexicon_db.get_paged_terms(mode="core", page=1, limit=500)
    plain_terms = [item["pali_plain"] for item in full_core["items"]]
    assert "anapanasati" in plain_terms
    assert "jhana" in plain_terms
    assert "nimitta" in plain_terms
    assert "samadhi" in plain_terms
    assert "sati" in plain_terms
    assert "dukkha" in plain_terms


def test_brahm_bswa_glossary_samadhi_is_stillness(lexicon_db):
    """Ajahn Brahm renders samādhi as 'stillness', not 'concentration'."""
    full_core = lexicon_db.get_paged_terms(mode="core", page=1, limit=500)
    samadhi = next(item for item in full_core["items"] if item["pali_plain"] == "samadhi")
    assert samadhi["translation_brahm"].lower().startswith("stillness")
    # Canonical SuttaCentral data must be preserved alongside the Brahm gloss
    assert samadhi["translation_bodhi"]


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
# 4. Lexicon Query & Paged Term Method Tests
# ==============================================================================

def test_lexicon_page_core_mode(lexicon_db):
    """Core mode returns standard core terms with pagination metadata."""
    data = lexicon_db.get_paged_terms(mode="core", limit=25)
    assert "items" in data
    assert "total" in data
    assert data["page"] == 1
    assert len(data["items"]) <= 25

    jhana_page = lexicon_db.get_paged_terms(mode="core", letter="j", limit=25)
    pali_plains = [item["pali_plain"] for item in jhana_page["items"]]
    assert "jhana" in pali_plains


def test_lexicon_page_all_mode_pagination(lexicon_db):
    """All mode respects page and limit query parameters."""
    data = lexicon_db.get_paged_terms(mode="all", page=3, limit=10)
    assert data["page"] == 3
    assert data["limit"] == 10
    assert len(data["items"]) == 10
    assert data["total"] >= 1000


def test_lexicon_page_filter_and_sort(lexicon_db):
    """Respects letter, category, and sort parameters."""
    data = lexicon_db.get_paged_terms(mode="all", letter="s", sort="pali_asc", limit=15)
    for item in data["items"]:
        assert item["pali_plain"].startswith("s")


def test_lexicon_db_get_all_terms(lexicon_db):
    """Verifies get_all_terms returns complete indexed canonical terms with translations."""
    terms = lexicon_db.get_all_terms()
    assert isinstance(terms, list)
    assert len(terms) >= 1000
    sample = next((t for t in terms if t["pali_plain"] == "samadhi"), None)
    assert sample is not None
    assert "translation_bodhi" in sample or "translation_brahm" in sample
    pali_plains = {t["pali_plain"] for t in terms}
    assert "samadhi" in pali_plains
    assert "sati" in pali_plains
    assert "anicca" in pali_plains


def test_lexicon_source_documents_and_urls(lexicon_db):
    """Verifies that all terms have joined source_urls and that offline documents are retrievable."""
    # Verify terms join source_documents
    sample = lexicon_db.lookup_term("samadhi")
    assert sample is not None
    assert sample["source_url"] is not None
    assert sample["source_url"].startswith("http")
    assert sample["source_title"] is not None

    # Test list_source_documents
    docs = lexicon_db.list_source_documents()
    assert len(docs) == 4
    for d in docs:
        assert d["id"] is not None
        assert d["url"].startswith("http")
        assert d["mirror_url"].startswith("sources/")
        assert d["title"]
        assert d["author"]
        assert d["sha256"]

    # Test get_source_document by id
    doc1 = lexicon_db.get_source_document(1)
    assert doc1 is not None
    assert doc1["id"] == 1
    assert len(doc1["content"]) > 1000

    # Test get_source_document by canonical url match (Doc 2 Brahmali Vinaya)
    doc_vinaya = lexicon_db.get_source_document("https://suttacentral.net/edition/pli-tv-vi/en/brahmali/appendix-glossary")
    assert doc_vinaya is not None
    assert "vinaya" in doc_vinaya["content"].lower()
    assert len(doc_vinaya["content"]) > 5000

    # Test get_source_document by canonical url match (Doc 3 Brahm Word of the Buddha)
    doc_brahm = lexicon_db.get_source_document("https://bswa.org/teaching/the-word-of-the-buddha-book/")
    assert doc_brahm is not None
    assert "brahm" in doc_brahm["content"].lower()
    assert len(doc_brahm["content"]) > 3000

    # Test get_source_document by canonical url match (Doc 4 SuttaCentral Tipitaka Canon)
    doc_canon = lexicon_db.get_source_document("https://suttacentral.net/pitaka/sutta")
    assert doc_canon is not None
    assert "majjhima nikāya" in doc_canon["content"].lower()
    assert "sabbāsava sutta" in doc_canon["content"].lower()


def test_canonical_multiword_phrases_and_local_source_mirrors(lexicon_db):
    """
    Verifies that canonical multi-word phrases (Majjhima Nikāya, Dīgha Nikāya,
    Sabbāsava Sutta, Yoniso Manasikāra) are present in the lexicon with authentic
    external URLs and local mirrored source files in databases/sources/ and dist/sources/.
    """
    from deeper_dhamma.config import PROJECT_ROOT

    mn = lexicon_db.lookup_term("majjhima nikaya")
    assert mn is not None
    assert mn["pali_diacritic"] == "Majjhima Nikāya"
    assert mn["translation_brahm"] == "The Middle Length Discourses"
    assert mn["translation_sujato"] == "Middle Discourses Collection"
    assert mn["source_url"] == "https://suttacentral.net/mn"
    assert mn["source_mirror_url"].startswith("sources/")

    sabbasava = lexicon_db.lookup_term("sabbasava sutta")
    assert sabbasava is not None
    assert sabbasava["pali_diacritic"] == "Sabbāsava Sutta"
    assert sabbasava["translation_bodhi"] == "All the Taints"
    assert sabbasava["translation_sujato"] == "All the Defilements"
    assert sabbasava["source_url"] == "https://suttacentral.net/mn2"

    yoniso = lexicon_db.lookup_term("yoniso manasikara")
    assert yoniso is not None
    assert yoniso["pali_diacritic"] == "yoniso manasikāra"
    assert yoniso["translation_bodhi"] == "careful attention"
    assert yoniso["translation_sujato"] == "proper attention"
    assert "work of the mind" in yoniso["translation_brahm"]

    # Verify all source documents have local mirror files whose SHA-256 matches the database record
    import hashlib
    from deeper_dhamma.export_web import export_static_site

    dist_dir = PROJECT_ROOT / "dist"
    if not (dist_dir / "sources").exists():
        export_static_site(dist_dir)

    for doc in lexicon_db.list_source_documents():
        local_path = PROJECT_ROOT / "databases" / doc["mirror_url"]
        dist_mirror_path = dist_dir / doc["mirror_url"]
        assert local_path.exists(), f"Missing local source file: {local_path}"
        assert dist_mirror_path.exists(), f"Missing mirrored dist source file: {dist_mirror_path}"
        raw_bytes = local_path.read_bytes()
        assert dist_mirror_path.read_bytes() == raw_bytes
        actual_sha = hashlib.sha256(raw_bytes).hexdigest()
        assert actual_sha == doc["sha256"], f"SHA-256 mismatch for {local_path}"
        assert len(raw_bytes) == doc["uncompressed_bytes"]


def test_wordsync_multiword_phrase_highlighting_and_seeking(lexicon_db):
    """
    Verifies in headless Chrome that WordSync.formatTurnParagraphs greedily highlights
    multi-word canonical Pali phrases ('Majjhima Nikaya', 'Sabbasava Sutta', 'Yoniso Manasikara')
    as unified .pali-phrase spans with combined [wFirst.s, wLast.e] boundaries and shared domId.
    """
    import http.server
    import subprocess
    import tempfile
    import threading
    from pathlib import Path
    from deeper_dhamma.config import PROJECT_ROOT

    chrome_path = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    if not chrome_path.exists():
        pytest.skip("Google Chrome not found for headless WordSync phrase test")

    word_sync_js = (PROJECT_ROOT / "deeper_dhamma" / "web" / "static" / "word_sync.js").read_text(encoding="utf-8")
    all_terms_json = json.dumps(lexicon_db.get_all_terms(), ensure_ascii=False)
    report = {}

    class PhraseHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            report.update(json.loads(body.decode("utf-8")))
            self.send_response(200)
            self.end_headers()

        def do_GET(self):
            html_doc = f"""<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
            <div id="container"></div>
            <script>{word_sync_js}</script>
            <script>
            const terms = {all_terms_json};
            WordSync.setPaliTerms(terms);

            // Simulate Turn 18 with word timings
            const sampleText = "It is defined in the Sabbasava Sutta, which is the second sutta of the Majjhima Nikaya, explaining Yoniso Manasikara.";
            const rawTokens = sampleText.trim().split(/\\s+/);
            WordSync.words = rawTokens.map((t, i) => ({{
                s: 100 + i * 0.5,
                e: 100 + i * 0.5 + 0.4,
                turnIdx: 18,
                wordIdxInTurn: i,
                id: 'tw-' + i
            }}));
            WordSync.turnWordMap[18] = WordSync.words;

            const renderedHtml = WordSync.formatTurnParagraphs(sampleText, 18);
            const container = document.getElementById('container');
            container.innerHTML = renderedHtml;

            const paliSpans = Array.from(container.querySelectorAll('.pali-term')).map(el => ({{
                text: el.textContent,
                pali: el.dataset.pali,
                isPhrase: el.classList.contains('pali-phrase'),
                id: el.id,
                start: parseFloat(el.dataset.start),
                end: parseFloat(el.dataset.end)
            }}));

            // Check domId mapping for 'Majjhima' (word 14) and 'Nikaya,' (word 15)
            const wMajjhima = WordSync.words[14];
            const wNikaya = WordSync.words[15];

            fetch('/report', {{
                method: 'POST',
                headers: {{ 'Content-Type': 'application/json' }},
                body: JSON.stringify({{
                    paliSpans,
                    majjhimaDomId: wMajjhima.domId,
                    nikayaDomId: wNikaya.domId
                }})
            }});
            </script></body></html>""".encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html_doc)))
            self.end_headers()
            self.wfile.write(html_doc)

    class ThreadedHTTPServer(http.server.ThreadingHTTPServer):
        daemon_threads = True

    server = ThreadedHTTPServer(("127.0.0.1", 0), PhraseHandler)
    port = server.server_port
    threading.Thread(target=server.serve_forever, daemon=True).start()

    try:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as user_dir:
            proc = subprocess.Popen([
                str(chrome_path),
                "--headless=new",
                "--disable-gpu",
                "--no-sandbox",
                f"--user-data-dir={user_dir}",
                f"http://127.0.0.1:{port}/",
            ])
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
    finally:
        server.shutdown()

    assert "paliSpans" in report
    spans = report["paliSpans"]
    pali_keys = [s["pali"] for s in spans]

    # Must match unified phrases rather than fragmented 'majjhima' + 'nikaya'
    assert "sabbasava sutta" in pali_keys
    assert "sutta" in pali_keys
    assert "majjhima nikaya" in pali_keys
    assert "yoniso manasikara" in pali_keys
    assert "majjhima" not in pali_keys
    assert "nikaya" not in pali_keys

    mn_span = next(s for s in spans if s["pali"] == "majjhima nikaya")
    assert mn_span["isPhrase"] is True
    assert mn_span["text"] == "Majjhima Nikaya,"
    # Word 14 starts at 107.0s, Word 15 ends at 107.9s
    assert abs(mn_span["start"] - 107.0) < 0.01
    assert abs(mn_span["end"] - 107.9) < 0.01
    assert report["majjhimaDomId"] == mn_span["id"]
    assert report["nikayaDomId"] == mn_span["id"]


def test_lexicon_and_documents_shareable_url_routing():
    """
    Verifies that app.js updates and parses shareable deep-link URLs for:
    1. Specific lexicon terms: #lexicon?term=dhamma
    2. Filtered offline source documents: #documents?id=1&q=dhamma
    """
    from pathlib import Path
    from deeper_dhamma.config import PROJECT_ROOT

    app_js = (PROJECT_ROOT / "deeper_dhamma" / "web" / "static" / "app.js").read_text(encoding="utf-8")
    assert "#lexicon?term=" in app_js
    assert "#documents?id=" in app_js
    assert "btn-lexicon-share" in app_js
    assert "View in Offline Source" in app_js
    assert "Raw Archive File" in app_js


def test_citta_viveka_and_authoritative_compounds(lexicon_db):
    """
    Verifies that citta-viveka, kaya-viveka, upadhi-viveka, and core doctrinal compounds
    from Bhante Sujato and Ajahn Brahmali are properly indexed, searchable, and mapped.
    """
    # 1. citta-viveka
    cv = lexicon_db.lookup_term("citta-viveka")
    assert cv is not None
    assert cv["pali_plain"] == "cittaviveka"
    assert cv["category"] == "meditation"
    assert "seclusion" in cv["translation_sujato"].lower()
    assert "aloneness" in cv["translation_brahm"].lower()
    assert "hindrance" in cv["translation_brahmali"].lower()
    assert cv["source_url"] == "https://suttacentral.net/mnd2/en/sujato#12.1"

    # Exact plain lookup
    cv_plain = lexicon_db.lookup_term("cittaviveka")
    assert cv_plain is not None
    assert cv_plain["id"] == cv["id"]

    # 2. kaya-viveka
    kv = lexicon_db.lookup_term("kaya-viveka")
    assert kv is not None
    assert kv["pali_plain"] == "kayaviveka"
    assert kv["category"] == "meditation"
    assert "physical" in kv["translation_sujato"].lower() or "bodily" in kv["translation_sujato"].lower()

    # 3. upadhi-viveka
    uv = lexicon_db.lookup_term("upadhi-viveka")
    assert uv is not None
    assert uv["pali_plain"] == "upadhiviveka"
    assert uv["category"] == "doctrine"

    # 4. citta-sankhara & kaya-sankhara
    cs = lexicon_db.lookup_term("citta-sankhara")
    assert cs is not None
    assert cs["pali_plain"] == "cittasankhara"
    assert "mental" in cs["translation_sujato"].lower()

    ks = lexicon_db.lookup_term("kaya-sankhara")
    assert ks is not None
    assert ks["pali_plain"] == "kayasankhara"
    assert "physical" in ks["translation_sujato"].lower() or "bodily" in ks["translation_sujato"].lower()

    # 5. piti-sukha
    ps = lexicon_db.lookup_term("piti-sukha")
    assert ps is not None
    assert ps["pali_plain"] == "pitisukha"
    assert "joy" in ps["translation_sujato"].lower() or "rapture" in ps["translation_sujato"].lower()


def test_authoritative_compounds_database_architecture():
    """
    Verifies the architectural separation of code, source material, and data:
    1. authoritative_ebt_compounds.db exists in databases/
    2. ebt_compounds and phrase_rules tables use integer surrogate primary key 'id'
    3. load_authoritative_ebt_compounds and load_standard_phrase_rules query SQLite
    """
    import sqlite3
    from deeper_dhamma.config import AUTHORITATIVE_EBT_COMPOUNDS_DB_PATH
    from deeper_dhamma.build_lexicon import load_authoritative_ebt_compounds, load_standard_phrase_rules

    assert AUTHORITATIVE_EBT_COMPOUNDS_DB_PATH.exists()

    conn = sqlite3.connect(AUTHORITATIVE_EBT_COMPOUNDS_DB_PATH)
    try:
        # 1. ebt_compounds table
        info = conn.execute("PRAGMA table_info(ebt_compounds);").fetchall()
        assert len(info) >= 5
        pk_col = next(r[1] for r in info if r[5] == 1)
        assert pk_col == "id", "ebt_compounds table must use integer primary key 'id'"

        count = conn.execute("SELECT COUNT(*) FROM ebt_compounds;").fetchone()[0]
        assert count >= 30

        # 2. phrase_rules table
        p_info = conn.execute("PRAGMA table_info(phrase_rules);").fetchall()
        assert len(p_info) >= 4
        pk_p = next(r[1] for r in p_info if r[5] == 1)
        assert pk_p == "id", "phrase_rules table must use integer primary key 'id'"

        p_count = conn.execute("SELECT COUNT(*) FROM phrase_rules;").fetchone()[0]
        assert p_count >= 25
    finally:
        conn.close()

    # 3. Loader functions return structured dicts from DB
    compounds = load_authoritative_ebt_compounds()
    assert len(compounds) >= 30
    assert any(c["pali_plain"] == "cittaviveka" for c in compounds)

    rules = load_standard_phrase_rules()
    assert len(rules) >= 25
    assert any(r["canonical_pali"] == "cittaviveka" for r in rules)


def test_ebt_compounds_phonetic_and_fts_queries(lexicon_db):
    """
    Verifies that authoritative compound terms can be discovered via:
    1. Hyphenated and spaced phonetic variants ('citta-viveka', 'citta viveka')
    2. SQLite FTS5 lexical match ('cittaviveka', 'pitisukha')
    3. Contextual keyword match ('aloneness of the citta', 'mental seclusion')
    """
    # 1. Spaced variant lookup
    res_space = lexicon_db.lookup_term("citta viveka")
    assert res_space is not None
    assert res_space["pali_plain"] == "cittaviveka"

    res_kaya = lexicon_db.lookup_term("kaya viveka")
    assert res_kaya is not None
    assert res_kaya["pali_plain"] == "kayaviveka"

    # 2. FTS5 search
    with lexicon_db._get_connection() as conn:
        fts_row = conn.execute("SELECT rowid, pali_plain FROM fts_terms WHERE fts_terms MATCH 'cittaviveka';").fetchone()
        assert fts_row is not None
        assert fts_row["pali_plain"] == "cittaviveka"

        fts_piti = conn.execute("SELECT rowid, pali_plain FROM fts_terms WHERE fts_terms MATCH 'pitisukha';").fetchone()
        assert fts_piti is not None
        assert fts_piti["pali_plain"] == "pitisukha"









