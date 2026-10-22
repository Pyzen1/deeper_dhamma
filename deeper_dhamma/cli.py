"""
Unified Command-Line Interface for BSWA Deeper Dhamma Application.

Subcommands:
  sync        Sync podcast catalog and download audio files
  voiceprints Build or inspect reference speaker embeddings gallery
  transcribe  Transcribe audio with faster-whisper, diarization, and Pali editing
  search      Instant full-text search across transcripts using SQLite FTS5
  export      Generate Markdown, WebVTT, or JSON on demand from database
  lexicon     Query and search the Buddhism Lexicon Database (buddhism_lexicon.db)
  curate      Curate and verify gold-standard reference transcripts
  benchmark   Evaluate transcription accuracy against gold-standard references
  test        Run end-to-end verification test on a 120s audio sample
"""

import argparse
import json
import logging
import sys
from pathlib import Path

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("deeper_dhamma")

from deeper_dhamma.config import ARCHIVE_DIR, TRANSCRIPTS_DB_PATH
from deeper_dhamma.storage import TranscriptDatabase


def cmd_sync(args):
    """Executes podcast sync & audio downloading."""
    from deeper_dhamma.downloader import run_sync
    run_sync(
        limit=args.limit,
        series=args.series,
        year=args.year,
        dry_run=args.dry_run,
        workers=args.workers,
    )


def cmd_voiceprints(args):
    """Builds or inspects reference speaker embeddings."""
    from deeper_dhamma.voiceprints import VoiceprintDatabase, bootstrap_voiceprints

    if args.rebuild:
        print("[*] Rebuilding voiceprints gallery from audio archive...")
        count = bootstrap_voiceprints(
            archive_dir=args.archive_dir,
            samples_per_teacher_era=args.samples_per_cluster,
            device=args.device,
        )
        print(f"[✓] Voiceprint gallery populated with {count} embeddings.")
        return

    # List mode
    db = VoiceprintDatabase()
    gallery = db.load_gallery(era=args.era)
    print(f"\n[*] Total voiceprints in database: {len(gallery)}")
    counts = {}
    for g in gallery:
        key = (g["display_name"], g["era"])
        counts[key] = counts.get(key, 0) + 1

    for (name, era), count in sorted(counts.items()):
        print(f"  - {name:<22} [{era}]: {count} voiceprint sample(s)")
    print()


def cmd_transcribe(args):
    """Transcribes audio talks and indexes them into SQLite."""
    from deeper_dhamma.pipeline import TranscriptionPipeline

    archive_dir = Path(args.archive_dir)
    pipeline = TranscriptionPipeline(device=args.device)

    # Collect target files
    files = []
    if args.file:
        p = Path(args.file)
        if not p.exists():
            print(f"[-] File not found: {args.file}")
            sys.exit(1)
        files = [p]
    elif args.year:
        year_dir = archive_dir / str(args.year)
        if not year_dir.exists():
            print(f"[-] Year directory not found: {year_dir}")
            sys.exit(1)
        files = sorted(list(year_dir.rglob("*.mp3")))
    elif args.series:
        for p in archive_dir.rglob("*.mp3"):
            if args.series.lower() in str(p).lower():
                files.append(p)
        files = sorted(files)
    elif args.all:
        files = sorted(list(archive_dir.rglob("*.mp3")))

    if not files:
        print("[-] No audio files matched the filter.")
        return

    # Filter already transcribed files unless --force
    to_process = []
    for f in files:
        if pipeline.db.has_episode(f.stem) and not args.force:
            continue
        to_process.append(f)

    if args.limit:
        to_process = to_process[: args.limit]

    print("=" * 75)
    print("BSWA Deeper Dhamma Transcription Pipeline")
    print("=" * 75)
    print(f"[*] Total files matched: {len(files)}")
    print(f"[*] Pending processing: {len(to_process)} (skipping {len(files) - len(to_process)} existing)")
    if args.max_duration:
        print(f"[*] Testing mode active: duration capped at {args.max_duration:.1f}s per file.")
    print("-" * 75)

    if not to_process:
        print("[✓] All target episodes have already been transcribed. Nothing to do.")
        return

    completed = 0
    failed = 0

    for idx, f in enumerate(to_process, 1):
        print(f"\n[{idx}/{len(to_process)}] Processing: {f.name}")
        try:
            result = pipeline.process_file(
                audio_path=f,
                max_duration_sec=args.max_duration,
            )
            completed += 1
            print(f"    [✓] Finished in {result['elapsed_sec']}s: {result['episode_id']} ({result['turns_count']} turns)")
        except Exception as e:
            failed += 1
            logger.error(f"    [!] Error transcribing {f.name}: {e}")

    print("\n" + "=" * 75)
    print(f"[✓] Batch transcription complete: {completed} successful, {failed} failed.")
    print("=" * 75)


def cmd_search(args):
    """Runs instant full-text search across transcripts."""
    db = TranscriptDatabase(args.db)
    print(f"\n[*] Searching FTS5 index for: \"{args.query}\" ...\n")
    results = db.search_fts(args.query, limit=args.limit)
    if not results:
        print("[-] No matching speech segments found.")
        return

    print(f"[+] Found {len(results)} matching speech segments:\n")
    for i, r in enumerate(results, start=1):
        start_m = int(r['start_sec'] // 60)
        start_s = int(r['start_sec'] % 60)
        print(f"[{i}] {r['title']} ({r['date']}) - {r['teacher']} @ {start_m:02d}:{start_s:02d}")
        print(f"    ... {r['snippet_text']} ...")
        print()


def cmd_export(args):
    """Exports transcripts to Markdown, WebVTT, or JSON on demand."""
    db = TranscriptDatabase(args.db)

    # List mode
    if args.list:
        episodes = db.list_episodes(year=args.year)
        print(f"\n[*] Total episodes in database: {len(episodes)}")
        for ep in episodes:
            mins = int(ep['duration_sec'] // 60)
            print(f"  [{ep['date']}] {ep['id']} ({mins}m) - {ep['primary_display']}")
        return

    # Single episode export
    if args.id:
        ep = db.get_episode(args.id)
        if not ep:
            print(f"[!] Episode '{args.id}' not found in database.")
            sys.exit(1)

        if args.format == "md":
            content = db.generate_markdown(args.id)
            ext = ".md"
        elif args.format == "vtt":
            content = db.generate_webvtt(args.id)
            ext = ".vtt"
        elif args.format == "json":
            content = json.dumps(db.generate_json(args.id), indent=2, ensure_ascii=False)
            ext = ".json"

        if args.output_dir:
            out_dir = Path(args.output_dir)
            out_dir.mkdir(parents=True, exist_ok=True)
            out_file = out_dir / f"{args.id}{ext}"
            out_file.write_text(content, encoding="utf-8")
            print(f"[✓] Exported {args.id} -> {out_file}")
        else:
            print(content)
        return

    # Batch export
    if args.all or args.year:
        if not args.output_dir:
            print("[!] Please specify --output-dir when batch exporting.")
            sys.exit(1)

        out_dir = Path(args.output_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        episodes = db.list_episodes(year=args.year)
        print(f"[*] Exporting {len(episodes)} episode(s) to '{out_dir}' as {args.format.upper()}...")

        for ep in episodes:
            ep_id = ep["id"]
            if args.format == "md":
                content = db.generate_markdown(ep_id)
                ext = ".md"
            elif args.format == "vtt":
                content = db.generate_webvtt(ep_id)
                ext = ".vtt"
            elif args.format == "json":
                content = json.dumps(db.generate_json(ep_id), indent=2, ensure_ascii=False)
                ext = ".json"

            out_file = out_dir / f"{ep_id}{ext}"
            out_file.write_text(content, encoding="utf-8")

        print(f"[✓] Batch export complete: {len(episodes)} files written to {out_dir}")
        return

    print("[-] Please specify --id, --year, --all, or --list.")


def cmd_curate(args):
    """Curate, inspect, and approve gold-standard reference transcripts."""
    from deeper_dhamma.curation import curate_audio_talk, approve_curated_candidate, list_curated_references

    if args.list:
        refs = list_curated_references()
        print("\n" + "=" * 75)
        print("BSWA Deeper Dhamma: Gold Standard References Gallery")
        print("=" * 75)
        print(f"\n[✓] Verified Gold Standards ({len(refs['verified'])}):")
        for v in refs["verified"]:
            rev_flag = "[Review Available]" if v["has_review"] else ""
            print(f"  - {v['file']:<55} ({v['size_bytes']:,} bytes) {rev_flag}")

        print(f"\n[?] Pending Candidates Awaiting Review ({len(refs['candidates'])}):")
        if not refs["candidates"]:
            print("  - None (All reference transcripts verified)")
        else:
            for c in refs["candidates"]:
                print(f"  - {c['file']:<55} ({c['size_bytes']:,} bytes)")
                print(f"    -> Approve with: python main.py curate --approve {c['slug']}")
        print()
        return

    if args.approve:
        approve_curated_candidate(args.approve)
        return

    if args.file:
        target = Path(args.file)
        if not target.exists():
            print(f"[-] Target audio file not found: {args.file}")
            sys.exit(1)
        curate_audio_talk(
            audio_path=target,
            max_duration_sec=args.duration,
            device=args.device,
            self_correct=not args.no_self_correct,
            auto_approve=args.auto_approve,
        )
        return

    print("[-] Please specify an audio file, --approve <slug>, or --list.")


def cmd_lexicon(args):
    """Inspect or search terms in the Buddhism Lexicon Database."""
    from deeper_dhamma.lexicon import BuddhismLexiconDatabase
    db = BuddhismLexiconDatabase()

    if args.sources:
        docs = db.list_source_documents()
        print("\n" + "=" * 80)
        print("Buddhism Lexicon: Embedded Offline Source Documents")
        print("=" * 80)
        for doc in docs:
            ratio = (1.0 - (doc['compressed_bytes'] / doc['uncompressed_bytes'])) * 100 if doc['uncompressed_bytes'] else 0
            print(f"\n[+] Title:      {doc['title']}")
            print(f"    Author:     {doc['author']} ({doc['publisher']})")
            print(f"    Source URL: {doc['url']}")
            print(f"    Retrieved:  {doc['retrieved_date']} (Format: {doc['content_format']})")
            print(f"    Storage:    {doc['compressed_bytes']:,} bytes compressed (raw: {doc['uncompressed_bytes']:,} bytes, {ratio:.1f}% space saved)")
            print(f"    SHA-256:    {doc['sha256']}")
        print("\n[i] View full decompressed text with: python main.py lexicon --source-content <url_or_title>\n")
        return

    if args.source_content:
        doc = db.get_source_document(args.source_content)
        if not doc:
            print(f"[-] No source document found matching '{args.source_content}'.")
            return
        print("\n" + "=" * 80)
        print(f"Source Document: {doc['title']} ({doc['author']})")
        print(f"URL: {doc['url']}")
        print("=" * 80)
        print(doc["content"][:3000])
        if len(doc["content"]) > 3000:
            print(f"\n... [truncated {len(doc['content']) - 3000} characters] ...")
        print()
        return

    if args.lookup:
        term = db.lookup_term(args.lookup)
        if not term:
            print(f"[-] Term '{args.lookup}' not found in lexicon.")
            return
        print(f"\n[*] Lexicon Entry: {term['pali_plain']} ({term['pali_diacritic']})")
        print(f"    Category:     {term['category']}")
        print(f"    Bodhi:        {term['translation_bodhi']}")
        print(f"    Sujato:       {term['translation_sujato']}")
        print(f"    Brahm:        {term['translation_brahm']}")
        print(f"    Brahmali:     {term['translation_brahmali']}")
        print(f"    Description:  {term['english_description']}")
        print(f"    Keywords:     {term['context_keywords']}")
        print(f"    Source URL:   {term['source_url']}")
        print(f"    Source Ref:   {term['source']}\n")
    elif args.search:
        results = db.search_context(args.search, limit=args.limit)
        print(f"\n[*] Context search for \"{args.search}\" ({len(results)} matches):\n")
        for r in results:
            print(f"  - {r['pali_plain']:<20} ({r['pali_diacritic']}): {r['english_description'][:80]}...")
        print()
    else:
        print("[-] Please specify --lookup <term>, --search <query>, --sources, or --source-content <query>.")




def cmd_benchmark(args):
    """Runs gold-standard benchmark evaluations."""
    from deeper_dhamma.benchmark import run_benchmarks
    run_benchmarks(duration_sec=args.duration, device=args.device)


def cmd_test(args):
    """Runs end-to-end sanity verification test."""
    from deeper_dhamma.pipeline import TranscriptionPipeline

    print("=" * 75)
    print("BSWA Deeper Dhamma: End-to-End Test")
    print("=" * 75)

    sample_file = Path(args.file) if args.file else None
    if not sample_file or not sample_file.exists():
        available = list(Path(ARCHIVE_DIR).rglob("*.mp3"))
        if not available:
            print("[-] No audio files found in archive/.")
            sys.exit(1)
        sample_file = available[0]

    print(f"[*] Target audio file: {sample_file.name}")
    pipeline = TranscriptionPipeline(device=args.device)

    result = pipeline.process_file(
        audio_path=sample_file,
        max_duration_sec=args.duration,
    )

    print("\n" + "=" * 75)
    print("Pipeline Execution Summary:")
    print("=" * 75)
    print(f" - Duration Processed: {result['duration_sec']}s in {result['elapsed_sec']}s")
    print(f" - Primary Teacher:    {result['primary_teacher']} (Era: {result['era']})")
    print(f" - Speaker Turns:      {result['turns_count']}")
    print(f" - Canonical Database: {result['db_path']}")

    db = pipeline.db
    md = db.generate_markdown(result["episode_id"])
    vtt = db.generate_webvtt(result["episode_id"])
    json_data = db.generate_json(result["episode_id"])

    print(f"[✓] Markdown Generated: {len(md)} characters")
    print(f"[✓] WebVTT Generated:   {len(vtt)} characters")
    print(f"[✓] JSON Generated:     {len(json_data['segments'])} segments")
    print("\n[✓] End-to-end test passed successfully!")


def main():
    parser = argparse.ArgumentParser(
        description="BSWA Deeper Dhamma: Unified AI Audio Archiving, Transcription & Search Suite",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="subcommand", help="Available subcommands")

    # 1. Sync
    p_sync = subparsers.add_parser("sync", help="Sync podcast feed and download talks")
    p_sync.add_argument("--limit", "-n", type=int, help="Limit number of talks to download")
    p_sync.add_argument("--year", "-y", type=int, help="Filter downloads by year")
    p_sync.add_argument("--series", "-s", type=str, help="Filter downloads by series name")
    p_sync.add_argument("--dry-run", action="store_true", help="Preview downloads without fetching")
    p_sync.add_argument("--workers", "-w", type=int, default=3, help="Concurrent download workers (default: 3)")
    p_sync.set_defaults(func=cmd_sync)

    # 2. Voiceprints
    p_vp = subparsers.add_parser("voiceprints", help="Manage reference speaker voiceprints")
    p_vp.add_argument("--rebuild", action="store_true", help="Rebuild voiceprint gallery from archive")
    p_vp.add_argument("--samples-per-cluster", type=int, default=6, help="Samples per teacher/era cluster")
    p_vp.add_argument("--era", type=str, help="Filter listing by era (1997_2003, 2004_2014, 2015_2026)")
    p_vp.add_argument("--archive-dir", default=ARCHIVE_DIR, help="Audio archive directory")
    p_vp.add_argument("--device", default="cuda:0", help="Compute device (default: cuda:0)")
    p_vp.set_defaults(func=cmd_voiceprints)

    # 3. Transcribe
    p_trans = subparsers.add_parser("transcribe", help="Transcribe audio talks and index in SQLite")
    g_target = p_trans.add_mutually_exclusive_group(required=True)
    g_target.add_argument("--file", "-f", type=str, help="Single MP3 file to transcribe")
    g_target.add_argument("--year", "-y", type=int, help="Transcribe all talks for a given year")
    g_target.add_argument("--series", "-s", type=str, help="Transcribe all talks in a series")
    g_target.add_argument("--all", action="store_true", help="Transcribe entire audio archive")

    p_trans.add_argument("--max-duration", "-d", type=float, help="Cap processing duration in seconds")
    p_trans.add_argument("--limit", "-n", type=int, help="Limit number of files to process")
    p_trans.add_argument("--force", action="store_true", help="Re-transcribe files even if already in DB")
    p_trans.add_argument("--archive-dir", default=ARCHIVE_DIR, help="Audio archive directory")
    p_trans.add_argument("--device", default="cuda:0", help="Compute device (default: cuda:0)")
    p_trans.set_defaults(func=cmd_transcribe)

    # 4. Search
    p_search = subparsers.add_parser("search", help="Full-text search across transcripts")
    p_search.add_argument("query", type=str, help="Search query (supports boolean operators like AND, OR, NOT)")
    p_search.add_argument("--limit", "-n", type=int, default=20, help="Max results (default: 20)")
    p_search.add_argument("--db", default=TRANSCRIPTS_DB_PATH, help="Path to SQLite transcripts database")
    p_search.set_defaults(func=cmd_search)

    # 5. Export
    p_export = subparsers.add_parser("export", help="Export transcripts to Markdown, WebVTT, or JSON")
    p_export.add_argument("--id", type=str, help="Episode ID to export")
    p_export.add_argument("--year", "-y", type=int, help="Export all talks from a specific year")
    p_export.add_argument("--all", action="store_true", help="Export all talks in the archive")
    p_export.add_argument("--list", action="store_true", help="List all indexed episodes")
    p_export.add_argument("--format", choices=["md", "vtt", "json"], default="md", help="Export format (default: md)")
    p_export.add_argument("--output-dir", "-o", type=str, help="Destination directory for exported files")
    p_export.add_argument("--db", default=TRANSCRIPTS_DB_PATH, help="Path to SQLite transcripts database")
    p_export.set_defaults(func=cmd_export)

    # 6. Curate
    p_curate = subparsers.add_parser("curate", help="Curate and verify gold-standard reference transcripts")
    p_curate.add_argument("file", nargs="?", type=str, help="Audio MP3 file to curate")
    p_curate.add_argument("--duration", "-d", type=float, help="Duration limit in seconds (default: full talk)")
    p_curate.add_argument("--approve", type=str, help="Candidate slug to approve as verified gold standard")
    p_curate.add_argument("--list", action="store_true", help="List active and pending reference transcripts")
    p_curate.add_argument("--auto-approve", action="store_true", help="Directly save high-confidence synthetic reference as gold standard")
    p_curate.add_argument("--no-self-correct", action="store_true", help="Disable dual-pass self-correction loop")
    p_curate.add_argument("--device", default="cuda:0", help="Compute device (default: cuda:0)")
    p_curate.set_defaults(func=cmd_curate)

    # 7. Lexicon
    p_lex = subparsers.add_parser("lexicon", help="Query or search the Buddhism Lexicon Database")
    p_lex.add_argument("--lookup", "-l", type=str, help="Look up a specific Pali term")
    p_lex.add_argument("--search", "-s", type=str, help="Contextual FTS5 search across English descriptions and keywords")
    p_lex.add_argument("--sources", action="store_true", help="List all embedded offline source documents and compression metrics")
    p_lex.add_argument("--source-content", type=str, help="Decompress and display embedded source document text by URL or title")
    p_lex.add_argument("--limit", "-n", type=int, default=10, help="Max results for search (default: 10)")
    p_lex.set_defaults(func=cmd_lexicon)

    # 8. Benchmark
    p_bench = subparsers.add_parser("benchmark", help="Evaluate accuracy against gold-standard references")
    p_bench.add_argument("--duration", "-d", type=float, default=300.0, help="Benchmark duration in seconds (default: 300)")
    p_bench.add_argument("--device", default="cuda:0", help="Compute device (default: cuda:0)")
    p_bench.set_defaults(func=cmd_benchmark)

    # 8. Test
    p_test = subparsers.add_parser("test", help="Run end-to-end sanity verification test")
    p_test.add_argument("--file", "-f", type=str, help="Specific audio file to test")
    p_test.add_argument("--duration", "-d", type=float, default=120.0, help="Test duration in seconds (default: 120)")
    p_test.add_argument("--device", default="cuda:0", help="Compute device (default: cuda:0)")
    p_test.set_defaults(func=cmd_test)

    args = parser.parse_args()
    if hasattr(args, "func"):
        args.func(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
