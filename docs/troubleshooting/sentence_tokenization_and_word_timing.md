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

---

## 3. Architectural Fix

```text
+-----------------------------------------------------------------------------+
|               DETERMINISTIC ZERO-LOSS SENTENCE SCANNER                      |
+-----------------------------------------------------------------------------+
                                       |
  1. Character-by-character scan for terminal punctuation ('.', '!', '?')
  2. Lookahead look-through for closing quotes/brackets (e.g. '"Let it go."')
  3. Validate genuine boundary: followed by whitespace or EOF
     (Internal decimals '6.15', '5.30', '3.14', '6 .15' are preserved intact)
  4. Slice clean sentence [start .. j], consume trailing whitespace, reset start
  5. Capture any unpunctuated tail segment as the final sentence
                                       |
                                       v
+-----------------------------------------------------------------------------+
| Result: Zero characters dropped, all 212 word spans match timestamps 1-to-1 |
+-----------------------------------------------------------------------------+
```

1. **Frontend Zero-Loss Sentence Scanner**:
   Replaced regex matching with a deterministic scanner `splitSentences(text)` across `word_sync.js` and `app.js`. It preserves internal decimals, spaced dots, abbreviations, and quotation marks without dropping text.
2. **Pristine Text Preservation in Aligner**:
   Updated `SpeakerAligner.refine_turns_by_word_boundaries` to preserve Whisper's original `seg["text"]` intact when no speaker change occurs, and added `_reconstruct_text_from_words` to maintain punctuation adhesion for split turns.
3. **Automated Regression Verification**:
   Added `test_pb10641521_turn_sentence_splitting_and_word_highlight_alignment` to `tests/test_cross_browser_word_sync.py`, verifying in headless Chrome that Turn 2 renders all 212 words and synchronizes word highlights with 100% precision.

---

## 4. Verification

Run the automated test verifying deterministic sentence splitting and word alignment:

```powershell
pytest tests/test_cross_browser_word_sync.py -k "test_pb10641521_turn_sentence_splitting_and_word_highlight_alignment"
```
