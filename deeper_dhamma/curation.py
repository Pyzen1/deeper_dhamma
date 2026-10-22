"""
Gold-Standard Reference Curation & Self-Correction Engine.

Enables examining, editing, and validating pipeline transcription outputs
for Pali terminology, phonetic slips, and acoustic discrepancies.
Includes an autonomous self-correction pipeline that adapts decoder prompts
and enforces anti-drift certainty guardrails to synthesize gold references without human fatigue.
"""

import json
import logging
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from deeper_dhamma.config import ARCHIVE_DIR, PROJECT_ROOT
from deeper_dhamma.lexicon import BuddhismLexiconDatabase
from deeper_dhamma.pipeline import TranscriptionPipeline
from deeper_dhamma.self_correction import SelfCorrectionEngine

logger = logging.getLogger("curation")

REF_DIR = PROJECT_ROOT / "benchmarks" / "reference_transcripts"


def get_curation_slug(audio_path: Path) -> str:
    """Generates a clean reference slug from audio filename (YYYY-MM-DD_title_teacher)."""
    stem = audio_path.stem
    m = re.match(r"^(\d{4}-\d{2}-\d{2})_(.*)$", stem)
    if m:
        date_part = m.group(1)
        rest = m.group(2)
        rest = re.sub(
            r"_\d+_(?:january|february|march|april|may|june|july|august|september|october|november|december)_\d{4}",
            "",
            rest,
            flags=re.IGNORECASE,
        )
        rest = re.sub(r"_\d+$", "", rest)
        return f"{date_part}_{rest}"
    return stem


def list_curated_references() -> Dict[str, List[Dict]]:
    """Lists currently verified gold references and pending candidate drafts."""
    REF_DIR.mkdir(parents=True, exist_ok=True)

    verified = []
    candidates = []

    for p in sorted(REF_DIR.glob("*.txt")):
        if p.name.endswith("_candidate.txt"):
            slug = p.name[:-14]
            candidates.append({
                "slug": slug,
                "file": p.name,
                "path": str(p),
                "size_bytes": p.stat().st_size,
            })
        else:
            slug = p.stem
            review_file = REF_DIR / f"{slug}_curation_review.md"
            verified.append({
                "slug": slug,
                "file": p.name,
                "path": str(p),
                "size_bytes": p.stat().st_size,
                "has_review": review_file.exists(),
            })

    return {"verified": verified, "candidates": candidates}


def inspect_lexicon_discrepancies(text: str, lexicon_db: Optional[BuddhismLexiconDatabase] = None) -> Dict:
    """
    Scans transcript text against buddhism_lexicon.db for:
    1. Canonical Pali terms present
    2. Potential acoustic false-friends or ambiguous words requiring contextual verification
    """
    db = lexicon_db or BuddhismLexiconDatabase()
    words = re.findall(r"\b[a-zA-Z\-]+\b", text.lower())
    found_canonical = []

    # Check terms present
    for w in set(words):
        if len(w) > 3 and db.lookup_term(w):
            found_canonical.append(w)
    found_canonical = sorted(found_canonical)

    flagged_candidates = []
    suspicious_patterns = [
        (r"\b(?:vains|veins|reins|vanes)\b", "vains/veins (possibly 'rains')"),
        (r"\b(?:ghana|gana|jana)\b", "ghana/gana/jana (possibly 'jhana')"),
        (r"\b(?:dharma|karma|sutra|nirvana)\b", "Sanskrit spelling (preferred Pali: dhamma, kamma, sutta, nibbana)"),
        (r"\b(?:tarpaulin|torper)\b", "tarpaulin/torper (possibly 'torpor' in sloth & torpor)"),
        (r"\b(?:anata|anatta)\b", "anatta (verify non-self context)"),
        (r"\b(?:nimiter|namita)\b", "nimiter (possibly 'nimitta')"),
        (r"\b(?:party\s*mocker)\b", "party mocker (possibly 'patimokkha')"),
    ]

    for pat, reason in suspicious_patterns:
        matches = re.findall(pat, text, flags=re.IGNORECASE)
        if matches:
            flagged_candidates.append({
                "pattern": pat,
                "found": list(set(matches)),
                "reason": reason,
            })

    return {
        "found_canonical": found_canonical,
        "flagged_candidates": flagged_candidates,
    }


def curate_audio_talk(
    audio_path: Path,
    max_duration_sec: Optional[float] = None,
    device: str = "cuda:0",
    self_correct: bool = True,
    auto_approve: bool = False,
) -> Dict:
    """
    Transcribes an audio talk with autonomous self-correction and anti-drift guardrails.
    Produces either an auto-approved gold reference or a candidate draft + review report.
    """
    REF_DIR.mkdir(parents=True, exist_ok=True)
    slug = get_curation_slug(audio_path)

    print("=" * 75)
    print(f"BSWA Curation & Self-Correction Pipeline: {slug}")
    print("=" * 75)
    print(f"[*] Source Audio:      {audio_path.name}")
    if max_duration_sec:
        print(f"[*] Duration Capped:   {max_duration_sec:.1f}s")
    print(f"[*] Self-Correction:   {self_correct} (Dual-pass in-context prompt adaptation)")
    print(f"[*] Auto-Approve:      {auto_approve} (Anti-drift confidence threshold)")
    print("-" * 75)

    if self_correct:
        sc_engine = SelfCorrectionEngine(device=device)
        sc_result = sc_engine.run_self_correction(
            audio_path=audio_path,
            max_duration_sec=max_duration_sec,
        )

        full_text = sc_result["synthetic_reference"]
        changelog = sc_result["changelog"]
        status = sc_result["status"]
        vetted_count = sc_result["vetted_segments_count"]
        total_count = sc_result["total_segments_count"]

        print(f"\n[✓] Self-Correction Complete:")
        print(f"    - Status:                  {status}")
        print(f"    - Iteration Passes:        {sc_result['iterations']}")
        print(f"    - Pass 1 Modifications:    {sc_result['pass1_corrections']}")
        print(f"    - Pass 2 Modifications:    {sc_result['pass2_corrections']}")
        if "corrections_reduced_pct" in sc_result:
            print(f"    - Acoustic Error Drop:     {sc_result['corrections_reduced_pct']}%")
        print(f"    - High-Certainty Segments: {vetted_count}/{total_count} (Passed Anti-Drift Guardrail)")
    else:
        pipeline = TranscriptionPipeline(device=device)
        result = pipeline.process_file(audio_path=audio_path, max_duration_sec=max_duration_sec)
        episode = pipeline.db.get_episode(result["episode_id"])
        segments = episode.get("segments", []) if episode else []
        changelog = episode.get("terminology_changelog", []) if episode else []
        full_text = " ".join([seg["text"].strip() for seg in segments if seg["text"].strip()])
        status = "STANDARD_RUN"

    # Inspect terminology
    inspection = inspect_lexicon_discrepancies(full_text)

    # Save final or candidate file
    if auto_approve and full_text:
        final_file = REF_DIR / f"{slug}.txt"
        final_file.write_text(full_text, encoding="utf-8")
        print(f"\n[✓] Auto-approved Synthetic Gold Standard saved directly to:")
        print(f"    {final_file} ({final_file.stat().st_size:,} bytes)")
        out_target = final_file
    else:
        candidate_file = REF_DIR / f"{slug}_candidate.txt"
        candidate_file.write_text(full_text, encoding="utf-8")
        print(f"\n[✓] Candidate transcript saved to:")
        print(f"    {candidate_file} ({candidate_file.stat().st_size:,} bytes)")
        out_target = candidate_file

    # Write review markdown
    review_file = REF_DIR / f"{slug}_curation_review.md"
    review_lines = [
        f"# Gold Standard Reference Curation: {slug}",
        "",
        "## Pipeline & Self-Correction Metadata",
        f"- **Audio File**: `{audio_path.name}`",
        f"- **Convergence Status**: `{status}`",
        f"- **Lexicon DB**: `databases/buddhism_lexicon.db` (SuttaCentral Bodhi/Sujato & BSWA Brahm/Brahmali)",
        f"- **Self-Correction Active**: `{self_correct}`",
        f"- **Status**: `{'APPROVED GOLD STANDARD' if auto_approve else 'PENDING HUMAN REVIEW'}`",
        "",
        "## Automated Buddhist Terminology Replacements & Context Disambiguation",
    ]

    if changelog:
        review_lines.append("| Original Matched | Normalized Replacement | Category | Rationale / Context | Count |")
        review_lines.append("|---|---|---|---|---|")
        for c in changelog:
            rat = c.get("rationale") or c.get("explanation") or "Lexicon match"
            review_lines.append(f"| `{c['original']}` | **{c['replacement']}** | `{c['category']}` | {rat} | {c['count']} |")
    else:
        review_lines.append("*Zero post-ASR corrections required (voice-to-text directly matched canonical vocabulary).*")

    review_lines.extend([
        "",
        "## Discrepancy & Ambiguity Audit",
        f"- **Canonical Pali Terms Detected**: {len(inspection['found_canonical'])} (`{', '.join(inspection['found_canonical'][:15])}`...)",
    ])

    if inspection["flagged_candidates"]:
        review_lines.append("\n### Flagged Ambiguities (Anti-Drift Guardrail):")
        for flag in inspection["flagged_candidates"]:
            review_lines.append(f"- **Found**: `{', '.join(flag['found'])}` -> *{flag['reason']}*")
    else:
        review_lines.append("- *No suspicious acoustic false-friends or unverified variants detected.*")

    if not auto_approve:
        review_lines.extend([
            "",
            "## Approval Command",
            f"Run: `python main.py curate --approve {slug}` to promote candidate to active benchmark gold standard.",
        ])

    review_file.write_text("\n".join(review_lines), encoding="utf-8")
    print(f"[✓] Curation audit review saved to:")
    print(f"    {review_file}\n")

    return {
        "slug": slug,
        "target_file": str(out_target),
        "review_file": str(review_file),
        "status": status,
        "full_text_len": len(full_text),
    }


def approve_curated_candidate(slug: str) -> Path:
    """Promotes candidate to verified gold standard benchmark reference."""
    cand_path = REF_DIR / f"{slug}_candidate.txt"
    final_path = REF_DIR / f"{slug}.txt"
    review_path = REF_DIR / f"{slug}_curation_review.md"

    if not cand_path.exists():
        if final_path.exists():
            print(f"[!] '{final_path.name}' is already an approved gold standard reference.")
            return final_path
        raise FileNotFoundError(f"Candidate file not found: {cand_path}")

    content = cand_path.read_text(encoding="utf-8")
    final_path.write_text(content, encoding="utf-8")
    cand_path.unlink()

    if review_path.exists():
        review_content = review_path.read_text(encoding="utf-8")
        review_content = review_content.replace("`PENDING HUMAN REVIEW`", "`APPROVED GOLD STANDARD`")
        review_path.write_text(review_content, encoding="utf-8")

    print("=" * 75)
    print(f"[✓] Candidate approved and promoted to Gold Standard:")
    print(f"    {final_path} ({final_path.stat().st_size:,} bytes)")
    print("    This reference is now active in benchmark evaluations.")
    print("=" * 75)

    return final_path
