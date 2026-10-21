#!/usr/bin/env python3
"""
Scans and compiles a complete system inventory of local AI models, weights,
and pre-installed software. Generates C:\\ai-models\\models_catalog.md
and a reference copy in docs/system_inventory.md.
"""

import os
import sys
import subprocess
from pathlib import Path
from datetime import datetime

# Enforce UTF-8 output on Windows
if sys.platform == "win32":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def format_size(bytes_val: int) -> str:
    gb = bytes_val / (1024 ** 3)
    if gb >= 1.0:
        return f"{gb:6.2f} GB"
    mb = bytes_val / (1024 ** 2)
    return f"{mb:6.1f} MB"


def build_inventory_markdown() -> str:
    base = Path(r"C:\ai-models")
    now_date = datetime.now().strftime("%Y-%m-%d")

    # 1. Ollama Models
    ollama_rows = []
    try:
        res = subprocess.run(["ollama", "list"], capture_output=True, text=True, check=True)
        lines = res.stdout.strip().splitlines()
        if len(lines) > 1:
            for line in lines[1:]:
                parts = line.split()
                if len(parts) >= 3:
                    name = parts[0]
                    size = parts[2] + " " + (parts[3] if len(parts) > 3 and parts[3] in ["GB", "MB"] else "")
                    ollama_rows.append((name, size.strip()))
    except Exception as e:
        ollama_rows.append(("Error querying ollama", str(e)))

    # 2. Standalone GGUF Models in C:\ai-models\llm\gguf
    gguf_files = []
    gguf_dir = base / "llm" / "gguf"
    if gguf_dir.exists():
        for f in sorted(gguf_dir.glob("*.gguf")):
            gguf_files.append((f.name, format_size(f.stat().st_size)))

    # 3. Audio & Speech Models
    audio_models = [
        ("faster-whisper-large-v3", "C:\\ai-models\\cache\\huggingface\\hub\\models--Systran--faster-whisper-large-v3", "2.88 GB", "ASR / Transcription (CTranslate2, CUDA float16)"),
        ("speechbrain-spkrec-ecapa-voxceleb", "C:\\ai-models\\cache\\huggingface\\hub\\speechbrain-spkrec-ecapa-voxceleb", "79.5 MB", "Speaker Verification & Voiceprints (ECAPA-TDNN)"),
        ("CosyVoice2-0.5B", "C:\\ai-models\\audio\\cosyvoice2", "4.52 GB", "Zero-Shot Voice Cloning & High-Fidelity TTS"),
        ("Kokoro-82M", "C:\\ai-models\\audio\\kokoro", "340 MB", "Ultra-fast lightweight neural TTS (40+ voices)"),
    ]

    # 4. Image Synthesis & Diffusion Checkpoints
    image_checkpoints = []
    ckpt_dir = base / "image" / "checkpoints"
    if ckpt_dir.exists():
        for f in sorted(ckpt_dir.glob("*.safetensors")):
            image_checkpoints.append((f.name, format_size(f.stat().st_size), "image/checkpoints/"))

    hf_image_models = [
        ("RealVisXL V5.0 (Diffusers)", "models--SG161222--RealVisXL_V5.0", "6.46 GB"),
        ("SDXL Base 1.0 (Diffusers)", "models--stabilityai--stable-diffusion-xl-base-1.0", "6.62 GB"),
        ("SDXL Turbo (Diffusers)", "models--stabilityai--sdxl-turbo", "6.46 GB"),
        ("Animagine XL 3.1", "models--cagliostrolab--animagine-xl-3.1", "6.46 GB"),
        ("SDXL-Lightning", "models--ByteDance--SDXL-Lightning", "4.78 GB"),
        ("CLIP-ViT-bigG-14 (laion2B)", "models--laion--CLIP-ViT-bigG-14-laion2B-39B-b160k", "9.46 GB"),
        ("clip-vit-large-patch14", "models--openai--clip-vit-large-patch14", "1.60 GB"),
        ("all-MiniLM-L6-v2", "models--sentence-transformers--all-MiniLM-L6-v2", "0.91 GB"),
    ]

    # 5. 3D Asset Synthesis Models
    threed_models = [
        ("Tencent Hunyuan3D-1", "C:\\ai-models\\3d\\hunyuan3d", "14.99 GB", "Complete text/image-to-3D pipeline"),
        ("Tencent InstantMesh", "C:\\ai-models\\3d\\instantmesh", "6.77 GB", "Fast multi-view mesh reconstruction"),
        ("Microsoft TRELLIS", "C:\\ai-models\\3d\\trellis", "3.07 GB", "High-resolution 3D structured latents"),
        ("Stability AI TripoSR", "C:\\ai-models\\3d\\triposr", "1.56 GB", "Instant 0.5s feed-forward 3D mesh gen"),
    ]

    # Build Markdown Content
    md = []
    md.append(f"# System AI Model & Software Catalog")
    md.append(f"**Generated Date**: {now_date}")
    md.append(f"**Centralized Root**: `C:\\ai-models`")
    md.append(f"**Hardware Platform**: NVIDIA GeForce RTX 5070 Ti (16 GB VRAM) | CUDA 13.0 / Driver 616.56")
    md.append(f"**Active Python**: Python 3.13.15 with PyTorch 2.14.1+cu130 (Compute Capability 12.0 / `sm_120`)")
    md.append("")
    md.append("> **Notice for AI Assistants & Pair Programmers**:")
    md.append("> Before attempting to download, install, or pull any AI models or libraries, ALWAYS consult this catalog.")
    md.append("> Do not download redundant models. Enforce model paths strictly to `C:\\ai-models`.")
    md.append("")

    # Section 1: Architecture Summary
    md.append("## 1. System Directory Layout & Modalities")
    md.append("```text")
    md.append("+--------------------------------------------------------------------------------+")
    md.append("|                           C:\\ai-models System Root                             |")
    md.append("+--------------------+------------------------+----------------------------------+")
    md.append("| Directory          | Total Disk Usage       | Primary Modality                 |")
    md.append("+--------------------+------------------------+----------------------------------+")
    md.append("| 3d/                |  26.40 GB              | 3D mesh & asset synthesis        |")
    md.append("| audio/             |   4.86 GB              | Voice cloning, TTS, speech       |")
    md.append("| image/             |  15.22 GB              | SDXL checkpoints & embeddings    |")
    md.append("| llm/               |  84.42 GB              | Standalone GGUF LLMs (Ollama)    |")
    md.append("| cache/             | 131.18 GB              | HuggingFace & PyTorch Hub caches |")
    md.append("+--------------------+------------------------+----------------------------------+")
    md.append("```")
    md.append("")

    # Section 2: LLMs & Ollama
    md.append("## 2. Large Language Models (LLM / GGUF)")
    md.append("Models are stored in `C:\\ai-models\\llm\\gguf` and hardlinked directly to `C:\\ai-models\\cache\\ollama` (zero duplicate disk space).")
    md.append("")
    md.append("| Model Name | Disk Size | Ollama Identifier | Primary Capability |")
    md.append("| :--- | :--- | :--- | :--- |")
    for row in gguf_files:
        ollama_name = row[0].replace(".gguf", "")
        # map common tags
        md.append(f"| `{row[0]}` | {row[1]} | `ollama run {ollama_name}` | Local LLM / Reasoning |")
    md.append("")

    # Section 3: Audio & Speech
    md.append("## 3. Audio, Speech-to-Text & Voice Synthesis")
    md.append("| Model Identifier | Path | Size | Engine / Task |")
    md.append("| :--- | :--- | :--- | :--- |")
    for name, p, sz, desc in audio_models:
        md.append(f"| **{name}** | `{p}` | {sz} | {desc} |")
    md.append("")

    # Section 4: Image & Diffusion
    md.append("## 4. 2D Image Synthesis & Diffusion Checkpoints")
    md.append("### Standalone `.safetensors` Checkpoints (`image/checkpoints/`)")
    md.append("| Checkpoint Name | Size | Architecture |")
    md.append("| :--- | :--- | :--- |")
    for name, sz, _ in image_checkpoints:
        md.append(f"| `{name}` | {sz} | SDXL 1.0 Base / Finetune |")
    md.append("")
    md.append("### HuggingFace Diffusers Cache (`cache/huggingface/hub/`)")
    md.append("| Model Repository | Disk Usage | Purpose |")
    md.append("| :--- | :--- | :--- |")
    for name, repo, sz in hf_image_models:
        md.append(f"| **{name}** | {sz} | `{repo}` |")
    md.append("")

    # Section 5: 3D Synthesis
    md.append("## 5. 3D Asset & Mesh Synthesis")
    md.append("| Architecture | Path | Size | Description |")
    md.append("| :--- | :--- | :--- | :--- |")
    for name, p, sz, desc in threed_models:
        md.append(f"| **{name}** | `{p}` | {sz} | {desc} |")
    md.append("")

    # Section 6: Installed Software & CLI Tools
    md.append("## 6. Pre-Installed Software & AI Tools")
    md.append("- **GPU Driver & CUDA**: Driver 616.56 | CUDA 13.4 UMD | CUDA 13.0 PyTorch runtime")
    md.append("- **PyTorch Stack**: `torch==2.14.1+cu130`, `torchvision==0.29.1+cu130`, `torchaudio==2.11.0+cu130`")
    md.append("- **Audio Processing**: `faster-whisper`, `speechbrain`, `soundfile`, `librosa`, `dawdreamer`, `mido`, `sf2utils`")
    md.append("- **Computer Vision**: `opencv-python`, `pillow`")
    md.append("- **LLM Runtime**: `ollama` daemon")
    md.append("- **Downloaders & Media Utilities**: `aria2c`, `ffmpeg`, `yt-dlp`")
    md.append("- **VCS & CLI**: `git`, `gh` (GitHub CLI)")
    md.append("")

    # Section 7: Enforced Environment Variables
    md.append("## 7. Mandatory AI Environment Variables")
    md.append("```powershell")
    md.append("$env:HF_HOME       = 'C:\\ai-models\\cache\\huggingface'")
    md.append("$env:OLLAMA_MODELS = 'C:\\ai-models\\cache\\ollama'")
    md.append("$env:TORCH_HOME    = 'C:\\ai-models\\cache\\torch'")
    md.append("```")
    md.append("In Python entrypoints:")
    md.append("```python")
    md.append("import os")
    md.append("os.environ.setdefault('HF_HOME', r'C:\\ai-models\\cache\\huggingface')")
    md.append("os.environ.setdefault('OLLAMA_MODELS', r'C:\\ai-models\\cache\\ollama')")
    md.append("os.environ.setdefault('TORCH_HOME', r'C:\\ai-models\\cache\\torch')")
    md.append("```")

    return "\n".join(md) + "\n"


def main():
    content = build_inventory_markdown()

    # Destination 1: C:\ai-models\models_catalog.md
    dest1 = Path(r"C:\ai-models\models_catalog.md")
    dest1.write_text(content, encoding="utf-8")
    print(f"[✓] Generated system catalog at: {dest1}")

    # Destination 2: Workspace reference docs/system_inventory.md
    dest2 = Path(__file__).resolve().parent / "docs" / "system_inventory.md"
    dest2.parent.mkdir(parents=True, exist_ok=True)
    dest2.write_text(content, encoding="utf-8")
    print(f"[✓] Generated workspace reference at: {dest2}")


if __name__ == "__main__":
    main()
