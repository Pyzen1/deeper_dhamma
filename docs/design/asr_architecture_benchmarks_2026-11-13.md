# ASR Architecture Evaluation: Parakeet-TDT & Hybrid Cascade vs. `faster-whisper`

**Date:** `2026-11-13`  
**Status:** Evaluated & Archived — **`faster-whisper` `turbo` retained as production default**  
**Related Spec:** [speaker_transcription_pipeline_design.md](speaker_transcription_pipeline_design.md)

---

## 1. Decision Summary

We prototyped and benchmarked **NVIDIA Parakeet-TDT 0.6B v2** (via `onnx-asr` / ONNX Runtime on both CPU and GPU) both as a standalone ASR engine and in a two-pass hybrid cascade (**Parakeet-TDT Pass 1 → English/Pali confusion triage → Selective `faster-whisper` `large-v3` Pass 2**) against Deeper Dhamma's current `faster-whisper` (`turbo` and `large-v3`) pipeline.

**Outcome:** Retain `faster-whisper-large-v3-turbo` (`turbo`, CUDA `float16`, `batch_size=1`) as the production default:
- On our RTX 5070 Ti GPU, **`turbo` remains faster end-to-end than the Hybrid GPU cascade** (`72.7x` vs. `46.5x` real-time on a full 45.5-minute talk) and avoids dual-runtime GPU CUDA allocator contention between ONNX Runtime and CTranslate2.
- **`turbo` achieves substantially lower general English WER** (`4.56%` vs. `10.88%–13.68%` on `1997-05-23 [300s]`; `8.03%` vs. `9.91%–10.42%` on `2025-11-27 [FULL 45.5m]`) and cleaner non-US conversational phrasing, partly because Parakeet transcribes verbatim hesitations (`"uh"`, `"um"`) and lacks Whisper's multilingual/dialect robustness.
- **Where Parakeet & the Hybrid stood out:** Parakeet-TDT alone hit **`114.7x` RT on GPU (`fp32`)** and **`47.5x` RT on CPU alone (`int8`)**, and the Hybrid cascade reached **`87.5%` (`21/24`) Pali recall** on dense Sutta excerpts—outperforming even full-pass `large-v3` (`79.2%`) and `turbo` (`66.7%`) thanks to dynamic `BuddhismLexiconDatabase.search_context()` prompting on flagged segments. Because overall English fidelity and operational simplicity favor `turbo`, the added dependency complexity and Pass 2 slice overhead do not justify changing the default pipeline.

---

## 2. Evaluated Pipeline & Test Environment

- **Hardware Platform:** NVIDIA GeForce RTX 5070 Ti (16 GB VRAM, CUDA 13.0, Driver `616.56`), AMD Ryzen 7 9800X3D (`cpu_threads=8` / `intra_op_num_threads=8`), Windows 11, Python `3.13.15`.
- **Engines Evaluated:**
  - `faster-whisper 1.2.1` (`turbo` and `large-v3`, `float16`, `CUDA`, `PALI_PROMPT` + teacher prompt steering, `hotwords=None`).
  - `onnx-asr 0.12.0` + `onnxruntime-gpu 1.31.1` loading `istupakov/parakeet-tdt-0.6b-v2-onnx` (`int8` and `fp32`) paired with `istupakov/silero-vad-onnx` on CPU (`threshold=0.25`, `min_silence_duration_ms=450`, `max_speech_duration_s=28.0`, `speech_pad_ms=150`).
- **Post-Processing:** Every configuration ran through the identical production `TranscriptPostProcessor` (`postprocess.py` + `terminology.py`) and passed `1:1` `words` synchronization blob parity (`pack_words_blob`).

### Hybrid Cascade Topology (Evaluated Prototype)

```text
[16 kHz Mono Audio]
        |
        v
[Silero VAD + Parakeet-TDT 0.6B v2]  <-- ONNX Runtime (CPU int8/fp32 or GPU fp32)
        |  (segments + absolute timestamps + per-token exp(logprob))
        v
[English/Pali Confusion Triage (<10 ms/talk)]
  - Signal 1: Out-of-English OOV dip (prob < 0.70, filtered against 5,748 lexicon English words)
  - Signal 2: Lexicon phonetic skeleton & TerminologyEditor false-friend/compound matches
  - Signal 3: Doctrinal-context homophones, low-prob bigrams, mid-sentence capitalization anomalies
        |
        +--- Unflagged (~80-95% of talk / ~51-72% on dense Sutta talks) ----------------+
        |                                                                               |
        v Flagged spans (merged within 1.5s, padded <= 0.6s into adjacent silence gaps) |
[faster-whisper large-v3 GPU Pass 2]                                                    |
  - Steered with PALI_PROMPT + teacher terms + dynamic search_context(neighbor_text)    |
        |                                                                               |
        +---------------------------------------+---------------------------------------+
                                                |
                                                v
                       [Exact Boundary Splice + TranscriptPostProcessor]
```

---

## 3. Empirical Benchmark Results

### 3.1 Gold-Standard Transcripts (`discover_active_benchmarks()`)

> **Notes:**
> - `1997-05-23` is a `300.0s` audio run evaluated against `285` curated human reference tokens where hesitations (`"uh"`, `"um"`) were removed; **`noUh` WER** shows edit rate after stripping `"uh"`/`"um"` from hypotheses purely to separate hesitation verbosity from acoustic accuracy.
> - `2025-11-27` (`2,729.3s` / `45.5m` full talk, `5,517` reference tokens) uses archived YouTube auto-captions as the baseline reference.

| Dataset / Window | Configuration | Provider | Elapsed | Speed | WER | `noUh` WER | Vocab F1 | Flagged Audio | `Uh/Um` | Stut Dedup |
| :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `1997-05-23` Jhana `[300s]` | `whisper_turbo_gpu` | CUDA `fp16` | `3.69s` | `81.3x` | `4.56%` | `4.56%` | `0.9805` | `100.0%` | `0` | `0` |
| | `whisper_large_v3_gpu` | CUDA `fp16` | `10.51s` | `28.6x` | **`3.16%`** | **`3.16%`** | **`0.9961`** | `100.0%` | `0` | `1` |
| | `parakeet_cpu_int8` | ONNX CPU | `6.11s` | `49.1x` | `10.88%` | `3.86%` | `0.9524` | `0.0%` | `16` | `2` |
| | `parakeet_cpu_fp32` | ONNX CPU | `7.51s` | `39.9x` | `11.93%` | `4.21%` | `0.9524` | `0.0%` | `17` | `2` |
| | `parakeet_gpu_fp32` | ONNX CUDA | **`2.06s`** | **`146.0x`** | `11.93%` | `4.21%` | `0.9524` | `0.0%` | `17` | `2` |
| | `hybrid_cpu_p1_gpu_p2` | CPU + CUDA | `6.95s` | `43.2x` | `12.63%` | `5.61%` | `0.9524` | `5.1%` | `16` | `2` |
| | `hybrid_gpu_p1_gpu_p2` | CUDA + CUDA | `3.15s` | `95.2x` | `13.68%` | `5.96%` | `0.9524` | `8.8%` | `16` | `2` |
| `2025-11-27` Playful `[300s]` | `whisper_turbo_gpu` | CUDA `fp16` | `3.45s` | `86.9x` | **`14.97%`** | `14.97%` | `0.9400` | `100.0%` | `0` | `1` |
| | `whisper_large_v3_gpu` | CUDA `fp16` | `10.24s` | `29.3x` | `17.47%` | `17.47%` | **`0.9437`** | `100.0%` | `0` | `0` |
| | `parakeet_cpu_int8` | ONNX CPU | `7.07s` | `42.4x` | `16.12%` | `16.19%` | `0.9210` | `0.0%` | `3` | `1` |
| | `parakeet_cpu_fp32` | ONNX CPU | `10.04s` | `29.9x` | `17.79%` | `17.86%` | `0.9219` | `0.0%` | `3` | `2` |
| | `parakeet_gpu_fp32` | ONNX CUDA | **`2.74s`** | **`109.5x`** | `17.79%` | `17.86%` | `0.9219` | `0.0%` | `3` | `2` |
| | `hybrid_cpu_p1_gpu_p2` | CPU + CUDA | `11.95s` | `25.1x` | `17.62%` | `17.62%` | `0.9341` | `40.0%` | `0` | `0` |
| | `hybrid_gpu_p1_gpu_p2` | CUDA + CUDA | `15.86s` | `18.9x` | `19.22%` | `19.22%` | `0.9178` | `29.3%` | `0` | `1` |
| `2025-11-27` Playful **`[FULL 45.5m]`** | `whisper_turbo_gpu` | CUDA `fp16` | `37.53s` | `72.7x` | **`8.03%`** | `8.14%` | **`0.9433`** | `100.0%` | `4` | `2` |
| | `whisper_large_v3_gpu` | CUDA `fp16` | `89.94s` | `30.3x` | `9.04%` | `9.04%` | `0.9394` | `100.0%` | `0` | `2` |
| | `parakeet_cpu_int8` | ONNX CPU | `57.49s` | `47.5x` | `9.91%` | `10.08%` | `0.9136` | `0.0%` | `20` | `15` |
| | `parakeet_gpu_fp32` | ONNX CUDA | **`23.80s`** | **`114.7x`** | `10.42%` | `10.59%` | `0.9142` | `0.0%` | `20` | `16` |
| | `hybrid_cpu_p1_gpu_p2` | CPU + CUDA | `84.11s` | `32.4x` | `10.42%` | `10.51%` | `0.9296` | `21.6%` | `13` | `11` |
| | `hybrid_gpu_p1_gpu_p2` | CUDA + CUDA | `58.72s` | `46.5x` | `10.33%` | `10.40%` | `0.9343` | `19.8%` | `14` | `14` |

### 3.2 ONNX Runtime Quantization Probe (`60s` warmup slice)

| Execution Provider | Quantization | Batch Size | Elapsed (`60s`) | Speed | Observation |
| :--- | :--- | ---: | ---: | ---: | :--- |
| `CPUExecutionProvider` (`8` threads) | `int8` | `4` | `1.456s` | `41.2x` | Sweet spot for CPU via AVX integer kernels (`0` threads: `40.4x`, `16` threads: `38.4x`). |
| `CPUExecutionProvider` (`1` batch) | `fp32` | `1` | `1.936s` | `31.0x` | ~`25–30%` slower than `int8` on CPU. |
| `CUDAExecutionProvider` | `int8` | `16` | `1.824s` | `32.9x` | QDQ INT8 dequantization ops regress GPU performance **4.4x** relative to `fp32`. |
| `CUDAExecutionProvider` | `fp32` | `32` | **`0.412s`** | **`145.6x`** | Peak ONNX GPU throughput (`batch_size=16`: `126.0x`). |

### 3.3 Pali-Dense Sutta Stress Suite (`400s` total, `24` canonical doctrinal targets)

Tested across three Pali-dense excerpts: `Anapanasati_Intro` (`1995-04-07`, `45–175s`, `8` targets), `Anapanasati_Tetrad2` (`1995-04-07`, `2540–2630s`, `6` targets), and `Sattasuriya_Sutta` (`2014-12-14 AN7.66`, `0–180s`, `10` targets):

| Configuration | Total Time (`400s`) | Speed | Pali Hits (`24`) | Intro (`8`) | Tetrad2 (`6`) | Sattasuriya (`10`) | Key Behavior |
| :--- | ---: | ---: | :---: | :---: | :---: | :---: | :--- |
| `parakeet_cpu_int8` | `10.44s` | `38.3x` | `16 / 24` (`66.7%`) | `6/8` | `2/6` | `8/10` | Misspelled unseen Pali phonetically (`shitta`, `Dooka`, `Puty`, `Kai Yanusati`, `Teri Gatar`, `nimita`) |
| `parakeet_gpu_fp32` | **`2.86s`** | **`139.8x`** | `16 / 24` (`66.7%`) | `6/8` | `2/6` | `8/10` | Same `66.7%` Pali recall at ~`140x` RT |
| `whisper_turbo_gpu` | `5.19s` | `77.0x` | `16 / 24` (`66.7%`) | `6/8` | `2/6` | `8/10` | Missed `citta`, `kayanupassana`, `kayasankhara`, `samadhi`, `nimitta`, `therigatha` |
| `whisper_large_v3_gpu` | `14.61s` | `27.4x` | `19 / 24` (`79.2%`) | `7/8` | `4/6` | `8/10` | Rescued `citta`, `pitisukha`, `samadhi`, `nimitta`; still missed `kayanupassana`, `kayasankhara`, `therigatha` |
| **`hybrid_cpu_p1_gpu_p2`** | `18.67s` | `21.4x` | **`21 / 24` (`87.5%`)** | `7/8` | **`5/6`** | **`9/10`** | Rescued `citta`, `pitisukha`, `nimitta`, **`kayanupassana`**, and **`therigatha`** |
| **`hybrid_gpu_p1_gpu_p2`** | `18.41s` | `21.7x` | **`21 / 24` (`87.5%`)** | `7/8` | **`5/6`** | **`9/10`** | Highest Pali recall overall; flagged `27.5%–43.4%` of audio across these Pali-dense slices |

---

## 4. Technical Lessons Learned

1. **Parakeet Confidence Signals Predict Pali Misses Reliably:** Almost every phonetic Pali distortion fell below token probability `0.60–0.68` (e.g., `shitta` `0.45`, `Dooka` `0.42–0.50`, `Puty`/`PewTisucca` `0.23–0.30`, `Teri Gatar` `0.35–0.58`, `Kai Yanusati` `0.44–0.53`, `nimita` `0.66`).
2. **Dynamic `search_context()` Prompting Outperformed Static Full-Talk Prompting on Pali:** Feeding locally retrieved terms from `buddhism_lexicon.db` (`search_context` over Pass 1 neighbor text) allowed targeted `large-v3` Pass 2 slices to recognize `kayanupassana` and `therigatha` where full-pass `large-v3` missed them. (This technique can be explored within Whisper itself independently of Parakeet if desired.)
3. **Why Hybrid Lost End-to-End Speed vs. `turbo`:**
   - Calling `faster-whisper` `large-v3` across ~65 short scattered slices (`19.8%` of a 45.5m talk) incurred `27.53s` in Pass 2 (`19.7x` effective slice RT vs. `30.3x` RT sequential) plus CTranslate2 / ONNX Runtime CUDA allocator switching (`t_p1` rose from `23.80s` standalone to `31.16s` when sharing GPU runs).
   - Pure English fluency, filler suppression, and accent adaptation on `turbo` remain superior for general talks (`8.03%` vs. `10.33%` WER; `72.7x` vs. `46.5x` RT).
4. **ONNX `onnx-asr` Integration Gotchas (for any future revisit):**
   - `with_vad(...).with_timestamps()` returns **segment-relative** `timestamps` (`0.0 .. seg_dur`), so `seg.start` must be added for global sync.
   - Its default `min_silence_duration_ms=100` chops mid-breath clauses cleanly fixed by raising to `450ms`.
   - `onnxruntime-gpu` QDQ INT8 runs slower on CUDA than FP32, whereas `int8` is optimal for `CPUExecutionProvider`.

---

## 5. Repository Status After Evaluation

- All temporary prototype code (`scratch/benchmark_parakeet_hybrid.py` and generated JSON metrics) and prototype `onnx-asr` / `onnxruntime-gpu` Python dependencies were removed after verification, restoring standard `onnxruntime` matching `faster-whisper`.
- `deeper_dhamma` production defaults remain unchanged (`faster-whisper-large-v3-turbo`, CUDA `float16`, `batch_size=1`).

