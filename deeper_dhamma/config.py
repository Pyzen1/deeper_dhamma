"""
Global Configuration & Environment Setup for Deeper Dhamma.

Enforces system AI model storage policies under C:\\ai-models and handles
Windows dynamic DLL loading for NVIDIA CUDA 12, cuBLAS, and cuDNN.
"""

import os
import sys
from pathlib import Path

# 0. Windows Console UTF-8 Reconfiguration (prevents charmap UnicodeEncodeError)
if sys.platform == "win32":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# 1. AI Model Storage Policy (Strictly under C:\ai-models)
os.environ.setdefault("HF_HOME", r"C:\ai-models\cache\huggingface")
os.environ.setdefault("OLLAMA_MODELS", r"C:\ai-models\cache\ollama")
os.environ.setdefault("TORCH_HOME", r"C:\ai-models\cache\torch")

# 2. Configure Windows DLL search paths for CTranslate2 / faster-whisper (CUDA 12 cuBLAS & cuDNN)
if sys.platform == "win32":
    py_lib = Path(sys.prefix) / "Lib" / "site-packages"
    for sub in [
        py_lib / "nvidia" / "cublas" / "bin",
        py_lib / "nvidia" / "cuda_nvrtc" / "bin",
        py_lib / "torch" / "lib",
    ]:
        if sub.exists():
            try:
                os.add_dll_directory(str(sub))
            except Exception:
                pass
            os.environ["PATH"] = str(sub) + ";" + os.environ.get("PATH", "")

# 3. Canonical Project Paths
PACKAGE_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = PACKAGE_ROOT.parent

ARCHIVE_DIR = PROJECT_ROOT / "archive"
DATABASES_DIR = PROJECT_ROOT / "databases"
LOGS_DIR = PROJECT_ROOT / "logs"
CATALOG_PATH = PROJECT_ROOT / "catalog.json"
ARCHIVE_LOG_PATH = PROJECT_ROOT / "archive.log"
DEFAULT_SYNC_LOG = LOGS_DIR / "sync.log"

BUDDHISM_LEXICON_DB_PATH = DATABASES_DIR / "buddhism_lexicon.db"
LEXICON_DB_PATH = BUDDHISM_LEXICON_DB_PATH
VOICEPRINTS_DB_PATH = DATABASES_DIR / "voiceprints.db"
TRANSCRIPTS_DB_PATH = DATABASES_DIR / "dhamma_transcripts.db"

# Legacy directory aliases for backward compatibility
DATA_DIR = DATABASES_DIR
VOICEPRINTS_DIR = DATABASES_DIR
TRANSCRIPTS_DIR = DATABASES_DIR
