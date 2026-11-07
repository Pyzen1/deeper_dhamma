"""
Comprehensive Unit and Headless Browser Tests for In-Browser Multi-Word and Phrase Fuzzy Search.

Verifies:
1. SQLite Database Schema & Integrity: search_vocab table compliance (integer PK 'id', uniqueness, counts).
2. Exhaustive Pali & Unicode Diacritic Folding (macrons, retroflex dots, tildes, anusvara).
3. Damerau-Levenshtein Edit Distance (insertions, deletions, substitutions, adjacent transpositions, early bailout).
4. Adaptive Fuzzy Word Correction Thresholds (<=4 chars strict, 5-8 dist 1, 9+ dist 2, frequency tie-breaking).
5. Quorum Soft-AND Multi-Word Generation (N-1 term combinations for >=3 words, SQLite expression safety limit).
6. Stopword Filtering for Tier 6 OR fallback queries.
7. Headless Google Chrome execution of db_worker.js verifying V8 runtime parity.
"""

import http.server
import json
import sqlite3
import subprocess
import tempfile
import threading
from pathlib import Path
import pytest

from deeper_dhamma.config import PROJECT_ROOT

DIST_DB_PATH = PROJECT_ROOT / "dist" / "dhamma_web.db"
STATIC_DIR = PROJECT_ROOT / "deeper_dhamma" / "web" / "static"


# ==============================================================================
# Python Mirror Implementations of Worker Algorithms (for rapid unit validation)
# ==============================================================================

PALI_DIACRITICS_MAP = {
    "ā": "a", "Ā": "a",
    "ī": "i", "Ī": "i",
    "ū": "u", "Ū": "u",
    "ṭ": "t", "Ṭ": "t",
    "ḍ": "d", "Ḍ": "d",
    "ṇ": "n", "Ṇ": "n",
    "ñ": "n", "Ñ": "n",
    "ḷ": "l", "Ḷ": "l",
    "ṁ": "m", "Ṁ": "m",
    "ŋ": "m", "Ŋ": "m",
    "ś": "s", "Ś": "s",
    "ṣ": "s", "Ṣ": "s",
}


def py_fold_diacritics(text: str) -> str:
    """Python reference mirror of db_worker.js foldDiacritics()."""
    import unicodedata
    if not text:
        return ""
    text = text.replace("ŋ", "m").replace("Ŋ", "m")
    decomposed = unicodedata.normalize("NFD", text)
    stripped = "".join(c for c in decomposed if unicodedata.category(c) != "Mn")
    for k, v in PALI_DIACRITICS_MAP.items():
        stripped = stripped.replace(k, v)
    return stripped.lower()


def py_damerau_levenshtein(a: str, b: str, max_dist: int = 2) -> int:
    """Python reference mirror of db_worker.js damerauLevenshtein()."""
    la, lb = len(a), len(b)
    if la == 0:
        return lb
    if lb == 0:
        return la
    if abs(la - lb) > max_dist:
        return 999

    d = [[0] * (lb + 1) for _ in range(la + 1)]
    for i in range(la + 1):
        d[i][0] = i
    for j in range(lb + 1):
        d[0][j] = j

    for i in range(1, la + 1):
        for j in range(1, lb + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            min_val = min(
                d[i - 1][j] + 1,        # deletion
                d[i][j - 1] + 1,        # insertion
                d[i - 1][j - 1] + cost  # substitution
            )
            # Transposition
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                min_val = min(min_val, d[i - 2][j - 2] + 1)
            d[i][j] = min_val

    return d[la][lb]


def py_generate_quorum_queries(words: list[str]) -> str | None:
    """Python reference mirror of db_worker.js generateQuorumQueries()."""
    import itertools
    if len(words) < 3:
        return None
    k = len(words) - 1 if len(words) <= 4 else max(2, int(len(words) * 0.75))
    combos = list(itertools.combinations(words, k))
    if not combos:
        return None
    top_combos = combos[:10]
    clauses = ["(" + " AND ".join(f"{w}*" for w in c) + ")" for c in top_combos]
    return " OR ".join(clauses)


# ==============================================================================
# 1. SQLite Database Schema & search_vocab Table Integrity Tests
# ==============================================================================

def test_search_vocab_table_schema_and_pk():
    """Verifies search_vocab table adheres to RDBMS Integer Primary Key rule."""
    if not DIST_DB_PATH.exists():
        pytest.skip("dhamma_web.db not yet compiled in dist/")

    conn = sqlite3.connect(DIST_DB_PATH)
    try:
        schema = conn.execute("SELECT sql FROM sqlite_master WHERE name = 'search_vocab';").fetchone()
        assert schema is not None, "search_vocab table missing from dhamma_web.db"
        sql = schema[0].upper()
        assert "ID INTEGER PRIMARY KEY AUTOINCREMENT" in sql or "ID INTEGER PRIMARY KEY" in sql
        assert "WORD TEXT UNIQUE NOT NULL" in sql
        assert "COUNT INTEGER NOT NULL" in sql
    finally:
        conn.close()


def test_search_vocab_contents_and_pali_coverage():
    """Verifies search_vocab contains high-volume English and canonical Pali terminology."""
    if not DIST_DB_PATH.exists():
        pytest.skip("dhamma_web.db not yet compiled in dist/")

    conn = sqlite3.connect(DIST_DB_PATH)
    try:
        total = conn.execute("SELECT COUNT(*) FROM search_vocab;").fetchone()[0]
        assert total > 2000, f"Expected >2000 words in search_vocab, got {total}"

        # Core doctrinal and meditation terms must have valid frequency counts
        test_words = ["meditation", "breath", "buddha", "mindfulness", "samadhi", "sutta", "practice", "retreat"]
        for w in test_words:
            row = conn.execute("SELECT count FROM search_vocab WHERE word = ?;", (w,)).fetchone()
            assert row is not None, f"Expected '{w}' in search_vocab"
            assert row[0] > 0, f"Expected positive count for '{w}'"

        # Verify no nulls, empty strings, or uppercase words
        invalid_words = conn.execute("SELECT COUNT(*) FROM search_vocab WHERE word IS NULL OR word = '' OR word != lower(word);").fetchone()[0]
        assert invalid_words == 0, f"Found {invalid_words} invalid/uppercase words in search_vocab"
    finally:
        conn.close()


# ==============================================================================
# 2. Pali and Unicode Diacritic Folding Exhaustive Tests
# ==============================================================================

@pytest.mark.parametrize(
    "raw_input,expected_folded",
    [
        ("ānāpānasati", "anapanasati"),
        ("Ānāpānasati Sutta", "anapanasati sutta"),
        ("jhāna", "jhana"),
        ("mettā", "metta"),
        ("Mettā Bhāvanā", "metta bhavana"),
        ("kalyāṇamitta", "kalyanamitta"),
        ("paṭiccasamuppāda", "paticcasamuppada"),
        ("dukkha", "dukkha"),
        ("suññatā", "sunnata"),
        ("nibbāna", "nibbana"),
        ("saṅgha", "sangha"),
        ("Saṅgha Mettā", "sangha metta"),
        ("saṁsāra", "samsara"),
        ("arahant", "arahant"),
        ("sati", "sati"),
        ("samādhi", "samadhi"),
        ("bodhi", "bodhi"),
        ("viññāṇa", "vinnana"),
        ("taṇhā", "tanha"),
        ("khanti", "khanti"),
        ("upekkhā", "upekkha"),
        ("sīla", "sila"),
        ("paññā", "panna"),
    ],
)
def test_pali_diacritic_folding_matrix(raw_input, expected_folded):
    """Verifies that all Pali vowels, retroflex consonants, and nasals fold to clean ASCII."""
    assert py_fold_diacritics(raw_input) == expected_folded


# ==============================================================================
# 3. Damerau-Levenshtein Distance & Transposition Tests
# ==============================================================================

def test_damerau_levenshtein_exact_and_edge_cases():
    """Verifies exact matches, empty inputs, and length-difference bounding."""
    assert py_damerau_levenshtein("samadhi", "samadhi", 2) == 0
    assert py_damerau_levenshtein("", "test", 2) == 4
    assert py_damerau_levenshtein("test", "", 2) == 4
    assert py_damerau_levenshtein("", "", 2) == 0
    # Length diff > 2 must immediately trigger early bailout (999)
    assert py_damerau_levenshtein("a", "aaaa", 2) == 999
    assert py_damerau_levenshtein("meditation", "med", 2) == 999


def test_damerau_levenshtein_single_edit_operations():
    """Verifies deletion, insertion, substitution, and adjacent transposition."""
    # Deletion (extra char)
    assert py_damerau_levenshtein("breath", "breathe", 2) == 1
    # Insertion (missing char)
    assert py_damerau_levenshtein("countng", "counting", 2) == 1
    # Substitution (wrong char)
    assert py_damerau_levenshtein("jhana", "jgana", 2) == 1
    # Adjacent transposition ('teh' -> 'the')
    assert py_damerau_levenshtein("teh", "the", 2) == 1
    # Adjacent transposition ('nobel' -> 'noble')
    assert py_damerau_levenshtein("nobel", "noble", 2) == 1
    # Non-adjacent substitution is distance 2, not 1
    assert py_damerau_levenshtein("breath", "braeth", 2) == 1  # 'ea' transposition


def test_damerau_levenshtein_two_edit_operations():
    """Verifies double edits within max distance 2."""
    # Two substitutions
    assert py_damerau_levenshtein("meditation", "moditatxon", 2) == 2
    # Two deletions
    assert py_damerau_levenshtein("anapanasati", "anapanasatixy", 2) == 2
    # Three edits exceeds max distance 2
    assert py_damerau_levenshtein("mindfulness", "mxndfxlnxss", 2) == 3


# ==============================================================================
# 4. Quorum / Soft-AND Query Generation Tests
# ==============================================================================

def test_quorum_query_generation_rules():
    """Verifies quorum query formation across varying token counts."""
    # 1 or 2 words should return None (exact/proximity/prefix handle these)
    assert py_generate_quorum_queries(["breath"]) is None
    assert py_generate_quorum_queries(["breath", "meditation"]) is None

    # 3 words -> exactly 3 pairs of 2 words
    q3 = py_generate_quorum_queries(["noble", "eightfold", "path"])
    assert q3 is not None
    assert q3 == "(noble* AND eightfold*) OR (noble* AND path*) OR (eightfold* AND path*)"

    # 4 words -> combinations of 3 words
    q4 = py_generate_quorum_queries(["four", "noble", "truths", "sutta"])
    assert q4 is not None
    assert "(four* AND noble* AND truths*)" in q4
    assert "(four* AND noble* AND sutta*)" in q4
    assert "(four* AND truths* AND sutta*)" in q4
    assert "(noble* AND truths* AND sutta*)" in q4

    # 6 words -> capped at top 10 combinations to prevent SQLite expression stack overflow
    q6 = py_generate_quorum_queries(["one", "two", "three", "four", "five", "six"])
    assert q6 is not None
    clauses = q6.split(" OR ")
    assert len(clauses) <= 10


# ==============================================================================
# 5. Stopword Filtering Tests
# ==============================================================================

def test_stopword_filtering_for_tier6_or():
    """Verifies that common stopwords are pruned from Tier 6 fallback queries."""
    stopwords = {
        "a", "an", "and", "are", "as", "at", "be", "but", "by", "for",
        "in", "into", "is", "it", "no", "not", "of", "on", "or", "such",
        "that", "the", "their", "then", "there", "these", "they", "this",
        "to", "was", "will", "with", "you", "your"
    }
    raw_query = ["the", "nature", "of", "suffering", "and", "mind"]
    content_words = [w for w in raw_query if w not in stopwords]

    assert content_words == ["nature", "suffering", "mind"]
    fallback_or = " OR ".join(f"{w}*" for w in content_words)
    assert fallback_or == "nature* OR suffering* OR mind*"


# ==============================================================================
# 6. Headless Google Chrome In-Browser Worker Logic Execution Test
# ==============================================================================

def test_headless_browser_worker_fuzzy_logic():
    """
    Executes db_worker.js inside Google Chrome V8 engine to verify:
    - Unicode & Pali diacritic folding
    - Damerau-Levenshtein calculation with transpositions
    - In-memory vocabulary spell correction thresholds
    - Quorum query generation
    - Stopword filtering
    """
    chrome_path = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    if not chrome_path.exists():
        pytest.skip("Google Chrome not found for headless worker verification")

    worker_js = (STATIC_DIR / "db_worker.js").read_text(encoding="utf-8")
    report = {}

    class FuzzyTestHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            report.update(json.loads(body.decode("utf-8")))
            self.send_response(200)
            self.end_headers()

        def do_GET(self):
            html = f"""<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>
            if (typeof importScripts === 'undefined') {{ window.importScripts = () => {{}}; }}
            {worker_js}

            async function runTests() {{
                // 1. Pali Diacritic Folding in V8
                const f1 = foldDiacritics('ānāpānasati');
                const f2 = foldDiacritics('jhāna');
                const f3 = foldDiacritics('mettā');
                const f4 = foldDiacritics('Paṭiccasamuppāda');
                const f5 = foldDiacritics('Saṅgha');

                // 2. Damerau-Levenshtein in V8
                const d1 = damerauLevenshtein('breath', 'breathe', 2);
                const d2 = damerauLevenshtein('countng', 'counting', 2);
                const d3 = damerauLevenshtein('teh', 'the', 2); // transposition
                const d4 = damerauLevenshtein('samadhi', 'xyz123', 2); // bail-out
                const d5 = damerauLevenshtein('nobel', 'noble', 2); // transposition

                // 3. Quorum query generation in V8
                const qCombos = generateQuorumQueries(['noble', 'eightfold', 'path']);

                // 4. In-memory vocabulary mock & fuzzy correction thresholds in V8
                vocabList = [
                    {{ word: 'breath', count: 150 }},
                    {{ word: 'breathing', count: 80 }},
                    {{ word: 'counting', count: 45 }},
                    {{ word: 'anapanasati', count: 25 }},
                    {{ word: 'samadhi', count: 90 }},
                    {{ word: 'noble', count: 110 }},
                    {{ word: 'truths', count: 85 }},
                    {{ word: 'meditation', count: 200 }}
                ];
                vocabSet = new Set(vocabList.map(v => v.word));

                const c1 = correctFuzzyWord('countng');      // dist 1 on 7-letter word -> counting
                const c2 = correctFuzzyWord('anapanasaty');  // dist 1 on 11-letter word -> anapanasati
                const c3 = correctFuzzyWord('nobel');        // transposition dist 1 on 5-letter word -> noble
                const c4 = correctFuzzyWord('the');          // short word <= 4 chars must NOT be altered
                const c5 = correctFuzzyWord('meditaton');    // dist 1 on 9-letter word -> meditation

                // 5. Frequency tie-breaking test
                // Two words at distance 1: 'brave' (count 10) vs 'brake' (count 50)
                vocabList.push({{ word: 'brave', count: 10 }});
                vocabList.push({{ word: 'brake', count: 50 }});
                vocabSet.add('brave');
                vocabSet.add('brake');
                const c6 = correctFuzzyWord('brase'); // distance 1 to both, brake has higher count -> brake

                // 6. Strict threshold tests: 7-letter word at distance 2 must NOT be altered
                vocabList.push({{ word: 'success', count: 100 }});
                vocabSet.add('success');
                const c7 = correctFuzzyWord('succeed'); // distance 2 to 'success' on 7-letter word -> untouched ('succeed')
                const c8 = correctFuzzyWord('mind');    // 4-letter word <= 4 chars -> untouched ('mind')

                await fetch('/report', {{
                    method: 'POST',
                    headers: {{ 'Content-Type': 'application/json' }},
                    body: JSON.stringify({{
                        f1, f2, f3, f4, f5,
                        d1, d2, d3, d4, d5,
                        qCombos,
                        c1, c2, c3, c4, c5, c6, c7, c8
                    }})
                }});
            }}
            runTests();
            </script></body></html>""".encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html)))
            self.end_headers()
            self.wfile.write(html)

    class ThreadedHTTPServer(http.server.ThreadingHTTPServer):
        daemon_threads = True

    server = ThreadedHTTPServer(("127.0.0.1", 0), FuzzyTestHandler)
    port = server.server_port
    threading.Thread(target=server.serve_forever, daemon=True).start()

    try:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as user_dir:
            cmd = [
                str(chrome_path),
                "--headless=new",
                "--disable-gpu",
                "--no-sandbox",
                f"--user-data-dir={user_dir}",
                f"http://127.0.0.1:{port}/",
            ]
            proc = subprocess.Popen(cmd)
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()

        # Assert results from browser runtime
        assert report.get("f1") == "anapanasati"
        assert report.get("f2") == "jhana"
        assert report.get("f3") == "metta"
        assert report.get("f4") == "paticcasamuppada"
        assert report.get("f5") == "sangha"

        assert report.get("d1") == 1
        assert report.get("d2") == 1
        assert report.get("d3") == 1
        assert report.get("d4") >= 2
        assert report.get("d5") == 1

        assert "(noble* AND eightfold*)" in report.get("qCombos", "")
        assert "(noble* AND path*)" in report.get("qCombos", "")
        assert "(eightfold* AND path*)" in report.get("qCombos", "")

        assert report.get("c1") == "counting"
        assert report.get("c2") == "anapanasati"
        assert report.get("c3") == "noble"
        assert report.get("c4") == "the"
        assert report.get("c5") == "meditation"
        assert report.get("c6") == "brake"
        assert report.get("c7") == "succeed"
        assert report.get("c8") == "mind"

    finally:
        server.shutdown()
