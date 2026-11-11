# Sentence Tokenization, Punctuation Adhesion, & Word Timing Alignment

## 1. Symptom

When viewing episodes containing spoken times, decimal figures, or spaced numbering (most notably **`pb10641521`** *2018 December | Weekend KM Retreat Q&A | Venerable Cunda & Venerable Bodhidhaja*, **`pb28867656`**, and **`pb27802310`**):
- Turn 2/3 in the web interface appeared to begin mid-sentence with:
  > *"15 and technically you can carry on sitting here and using those two halls if you want..."*
- The initial 18 words (*"here from 6.15 onwards so we can sit here in the hall from 5.30 to 6."*) were completely absent from the UI.
- The active word highlight was ~18 words (~7 seconds) out of sync with the audible speech, creating the false impression that Voice Activity Detection (VAD) had pruned audio segments.

---

## 2. Root Cause Analysis

Three distinct factors contributed to this defect:

### Cause A: Fragile Sentence Splitting RegExp in Frontend Client
In `word_sync.js` and `app.js`, paragraph formatting split text into sentences using:
```javascript
const rawSentences = trimmed.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [trimmed];
```
- The sub-pattern `(?:\s+|$)` requires terminal punctuation to be followed immediately by whitespace or EOF.
- When encountering times or decimal numbers (such as `6.15`, `5.30`, `6 .15`, or sutta citation `46 .23`), the period `.` is immediately followed by digits (`15`, `30`, `23`).
- Because `String.prototype.match(/.../g)` silently discards all substrings that fail to match the expression, the entire initial sentence up to `...15 and technically...` was discarded from the DOM.

### Cause B: Downstream 1-to-1 Word Mapping Offset
- `WordSync.turnWordMap[turnIdx]` loaded all 212 physical word timings for the turn from `episode_words` (starting at `72.56s` for *"here"*).
- Because 18 words were dropped from the DOM, only 194 word `<span>` elements were generated.
- `WordSync` sequentially mapped timestamp 0 (`72.56s`, *"here"*) onto DOM token 0 (`"15"`), shifting all subsequent word highlights in the turn by 18 positions.

### Cause C: Backend Word Re-Assembly in SpeakerAligner
- In `aligner.py`, `SpeakerAligner.refine_turns_by_word_boundaries` stripped and joined word tokens using `" ".join(w["word"].strip() for w in words)` even when no bilateral speaker change occurred.
- Because Whisper word tokens adhere punctuation (e.g. `' 6'` and `'.15'`), stripping and joining with spaces artificially introduced spaces before periods and hyphens (`6 .15`, `5 .30`, `hand -peeling`).

### Cause D: `faster-whisper` Sub-Word Continuation Splitting vs. Whitespace DOM Tokenization (`pb22228026`)
- In `faster_whisper/tokenizer.py` (`split_tokens_on_spaces`) and `faster_whisper/transcribe.py` (`merge_punctuations`), `faster-whisper` starts a new `Word` timing entry whenever a subword contains punctuation (`-`, `%`, `.`, `,`, `&`, `'`, `/`) and only merges standalone single prepended/appended punctuation marks.
- Consequently, single whitespace-delimited tokens containing internal punctuation—such as hyphenated Pali compounds (`citta-viveka,`, `citta-bhavana.`, `Citta-viveka`, `piti-sukha,`, `samadhi-ja,`, `in-breath.`, `one-pointedness`), percentages (`100%`), decimals/times (`6.15`, `5.30`), and abbreviations (`i.e.`, `Q&A`)—are emitted as **2 or 3 separate `Word` entries** in `s.words` (where continuation pieces lack a leading space `" "`), while `s.text` joins them with zero spaces into **1 whitespace-delimited token**.
- In **`pb22228026`** (*"1998 Rains Retreat (6/10) | Contentment Deepens Samadhi | Ajahn Brahm"*) Turn 2 (`60.92s - 291.39s`), the opening three tokens `"citta-viveka, citta-bhavana. Citta-viveka"` were stored as **6 word timing entries** in `episode_words`, while `WordSync.formatTurnParagraphs` split the turn text on whitespace into **3 DOM tokens**, shifting all 429 subsequent word highlights in Turn 2 by 3 words (`~3-4 seconds`) for over 4 minutes.
- Furthermore, `TerminologyEditor.edit_segments` (`terminology.py`) previously invoked `_sync_word_timings` only when `changes` was non-empty, leaving hyphenated/punctuation-split sub-words uncoalesced whenever no lexical substitution fired in that turn.

### Cause E: Stranded Lead-In Word 0 on Pre-Speech Silence / Rustle (`pb22228026` Turn 1)
- In **`pb22228026`** Turn 1 (`"This evening I'm going to talk some more about meditation, about"`), following the opening `Namo Tassa` homage (`1.58s - 37.74s`), there is 17 seconds of bowing silence (`37.8s - 54.5s`) containing a brief 200ms robe rustle at `42.2s - 42.4s`.
- Silero VAD (`threshold=0.20, speech_pad_ms=600`) included the `42.2s` rustle in the segment window. `faster-whisper`'s `add_word_timestamps` anchored Word 0 (`"This"`) onto the rustle (`42.46s - 43.24s`, duration `0.78s`) and Word 1 (`"evening"`) onto actual speech onset (`54.52s - 55.30s`, duration `0.78s`).
- Because `faster-whisper`'s boundary heuristic checks `if words[1]["end"] - words[1]["start"] > max_duration` (`0.78s > 0.78s` is `False`), it failed to advance `words[0]` to `words[1]["start"]`, stranding `"This"` and `speech_segments.start_sec` **11.28 seconds early** at `42.46s` in silence (affecting 39 turns across the 114-episode archive).

### Cause F: Turn-Boundary Word Duplication in `WordSync.indexWordsByTurn` & Headerless MP3 Duration Estimate
- `WordSync.indexWordsByTurn` (`word_sync.js`) searched `[segSt - 0.25, segEn + 0.35]` per turn without advancing `wordCursor = tempIdx` monotonically or capping at the turn's whitespace token count. When adjacent turns were `< 0.60s` apart, boundary words were assigned to both Turn `k` and Turn `k + 1`.
- On headerless 22.05 kHz 32 kbps CBR MP3 recordings, `sf.info` estimated total frame count from the first unpadded 104-byte frame rather than the 104/105-byte padded average (`104.49` bytes), overestimating `episodes.duration_sec` by ~0.5% (`3873.00s` vs. true `3854.60s` on `pb22228026`).

---

## 3. Architectural Fix

```text
+-----------------------------------------------------------------------------+
|            END-TO-END 1:1 WORD TIMING & TOKENIZATION PIPELINE               |
+-----------------------------------------------------------------------------+
                                       |
  1. ASR Sub-Word Coalescing & Lead-In Sanitization (asr.py, terminology.py)
     - Coalesce non-space-prefixed continuation pieces ('citta' + '-viveka,',
       '6' + '.15', '100' + '%') into their preceding word timing entry.
     - Pull stranded unpunctuated Word 0 (gap >= 2.5s before Word 1) forward
       to immediately precede Word 1 (e.g. pb22228026 Turn 1: 42.46s -> 53.92s).
     - Prune trailing silence hallucinations ('Satsang with Mooji').
     - Record true decoded 16 kHz waveform duration in pipeline.py.
                                       |
                                       v
  2. Monotonic Turn Indexing & Hyphenated Pali Registration (word_sync.js)
     - Advance `wordCursor = tempIdx` monotonically and cap per-turn word
       assignment at `expectedTokens` so tight turn boundaries (< 0.60s)
       never duplicate or steal boundary words.
     - Register hyphenated variants (`plain.replace(/\s+/g, '-')`) in
       `setPaliTerms` so hyphenated Pali compounds match as single tokens.
                                       |
                                       v
  3. Deterministic Zero-Loss Sentence Scanner (word_sync.js, app.js)
     - Character-by-character scan for terminal punctuation ('.', '!', '?')
     - Lookahead look-through for closing quotes/brackets (e.g. '"Let it go."')
     - Validate genuine boundary: followed by whitespace or EOF
       (Internal decimals '6.15', '5.30', '3.14', '6 .15' are preserved intact)
                                       |
                                       v
+-----------------------------------------------------------------------------+
| Result: 100% 1-to-1 parity across all 114 episodes (2,604 turns, 790,829    |
| words) with 0 unmapped words, 0 boundary overlaps, and 0 stranded lead-ins. |
+-----------------------------------------------------------------------------+
```

1. **Sub-Word Coalescing & Lead-In Sanitization (`asr.py` & `terminology.py`)**:
   `Transcriber.transcribe` and `TerminologyEditor._coalesce_subword_timings` merge any continuation sub-word token lacking a leading space into the preceding word timing entry, sanitize stranded unpunctuated lead-in Word 0 timestamps (`gap >= 2.5s`), and filter trailing silence hallucinations.
2. **Monotonic Turn Indexing & Hyphenated Pali Matching (`word_sync.js`)**:
   `WordSync.indexWordsByTurn` enforces monotonic cursor progression and per-turn token counts, while `WordSync.setPaliTerms` indexes hyphenated compound forms alongside spaced and closed forms.
3. **Frontend Zero-Loss Sentence Scanner (`word_sync.js` & `app.js`)**:
   Replaced regex matching with a deterministic scanner `splitSentences(text)` that preserves internal decimals, spaced dots, abbreviations, and quotation marks without dropping text.
4. **Pristine Text Preservation in Aligner (`aligner.py`) & Decoded Duration (`pipeline.py`)**:
   Updated `SpeakerAligner.refine_turns_by_word_boundaries` to preserve Whisper's original `seg["text"]` intact when no speaker change occurs, and updated `TranscriptionPipeline.process_file` to store the exact decoded audio duration.
5. **Automated Regression Verification (`tests/test_cross_browser_word_sync.py`)**:
   Added `test_pb10641521_turn_sentence_splitting_and_word_highlight_alignment`, `test_pb22228026_word_sync_hyphenated_compounds_and_lead_in_alignment`, and `test_sampled_newly_transcribed_episodes_one_to_one_word_sync_parity` verifying 100% 1-to-1 word-to-token parity across all 114 episodes.

---

## 4. Verification

Run the automated tests verifying deterministic sentence splitting, sub-word coalescing, lead-in alignment, and archive-wide word-sync parity:

```powershell
pytest tests/test_cross_browser_word_sync.py -k "test_pb10641521 or test_pb22228026 or test_sampled_newly_transcribed"
```

