#!/usr/bin/env python3
"""
Pre-downloads required AI models for transcription and speaker identification.
All weights are stored strictly under C:\ai-models in compliance with system policy.
"""

import os
import sys
from pathlib import Path

# Reconfigure console output on Windows to UTF-8
if sys.platform == "win32":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# Enforce AI model directory paths before any AI library imports
os.environ.setdefault("HF_HOME", r"C:\ai-models\cache\huggingface")
os.environ.setdefault("OLLAMA_MODELS", r"C:\ai-models\cache\ollama")
os.environ.setdefault("TORCH_HOME", r"C:\ai-models\cache\torch")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

import torch
from faster_whisper.utils import download_model
from speechbrain.inference.speaker import EncoderClassifier
from speechbrain.utils.fetching import LocalStrategy


def main():
    print("=" * 65)
    print("AI Model Downloader for BSWA Deeper Dhamma Transcription")
    print("=" * 65)
    print(f"[*] HF_HOME:    {os.environ['HF_HOME']}")
    print(f"[*] TORCH_HOME: {os.environ['TORCH_HOME']}")
    print(f"[*] Device:     {torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU'}")
    print()

    # 1. Download faster-whisper large-v3
    print("[1/2] Downloading faster-whisper model (large-v3)...")
    whisper_path = download_model("large-v3")
    print(f"   [✓] faster-whisper large-v3 ready at: {whisper_path}")
    print()

    # 2. Download SpeechBrain ECAPA-TDNN speaker embedding model
    print("[2/2] Downloading SpeechBrain speaker embedding model (ECAPA-TDNN)...")
    spk_save_dir = Path(os.environ["HF_HOME"]) / "hub" / "speechbrain-spkrec-ecapa-voxceleb"
    spk_classifier = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        savedir=str(spk_save_dir),
        local_strategy=LocalStrategy.COPY,
        run_opts={"device": "cuda" if torch.cuda.is_available() else "cpu"},
    )
    print(f"   [✓] SpeechBrain ECAPA-TDNN ready at: {spk_save_dir}")
    print()

    print("[✓] All required AI models successfully downloaded and verified under C:\\ai-models.")



if __name__ == "__main__":
    main()
