# System AI Model & Software Catalog
**Generated Date**: 2026-10-21
**Centralized Root**: `C:\ai-models`
**Hardware Platform**: NVIDIA GeForce RTX 5070 Ti (16 GB VRAM) | CUDA 13.0 / Driver 616.56
**Active Python**: Python 3.13.15 with PyTorch 2.14.1+cu130 (Compute Capability 12.0 / `sm_120`)

> **Notice for AI Assistants & Pair Programmers**:
> Before attempting to download, install, or pull any AI models or libraries, ALWAYS consult this catalog.
> Do not download redundant models. Enforce model paths strictly to `C:\ai-models`.

## 1. System Directory Layout & Modalities
```text
+--------------------------------------------------------------------------------+
|                           C:\ai-models System Root                             |
+--------------------+------------------------+----------------------------------+
| Directory          | Total Disk Usage       | Primary Modality                 |
+--------------------+------------------------+----------------------------------+
| 3d/                |  26.40 GB              | 3D mesh & asset synthesis        |
| audio/             |   4.86 GB              | Voice cloning, TTS, speech       |
| image/             |  15.22 GB              | SDXL checkpoints & embeddings    |
| llm/               |  84.42 GB              | Standalone GGUF LLMs (Ollama)    |
| cache/             | 131.18 GB              | HuggingFace & PyTorch Hub caches |
+--------------------+------------------------+----------------------------------+
```

## 2. Large Language Models (LLM / GGUF)
Models are stored in `C:\ai-models\llm\gguf` and hardlinked directly to `C:\ai-models\cache\ollama` (zero duplicate disk space).

| Model Name | Disk Size | Ollama Identifier | Primary Capability |
| :--- | :--- | :--- | :--- |
| `bge-m3.gguf` |   1.08 GB | `ollama run bge-m3` | Local LLM / Reasoning |
| `deepseek-r1-32b-q4_k_m.gguf` |  18.49 GB | `ollama run deepseek-r1-32b-q4_k_m` | Local LLM / Reasoning |
| `llama3.2-vision-11b-q4_k_m.gguf` |   7.28 GB | `ollama run llama3.2-vision-11b-q4_k_m` | Local LLM / Reasoning |
| `minicpm-v-8b-q4_k_m.gguf` |   4.13 GB | `ollama run minicpm-v-8b-q4_k_m` | Local LLM / Reasoning |
| `mmproj-minicpm-v-8b.gguf` |  996.0 MB | `ollama run mmproj-minicpm-v-8b` | Local LLM / Reasoning |
| `openbiollm-8b-q8_0.gguf` |   7.95 GB | `ollama run openbiollm-8b-q8_0` | Local LLM / Reasoning |
| `qwen2.5-32b-q4_k_m.gguf` |  18.49 GB | `ollama run qwen2.5-32b-q4_k_m` | Local LLM / Reasoning |
| `qwen2.5-coder-32b-q4_k_m.gguf` |  18.49 GB | `ollama run qwen2.5-coder-32b-q4_k_m` | Local LLM / Reasoning |
| `qwen2.5-math-7b-q8_0.gguf` |   7.54 GB | `ollama run qwen2.5-math-7b-q8_0` | Local LLM / Reasoning |

## 3. Audio, Speech-to-Text & Voice Synthesis
| Model Identifier | Path | Size | Engine / Task |
| :--- | :--- | :--- | :--- |
| **faster-whisper-large-v3** | `C:\ai-models\cache\huggingface\hub\models--Systran--faster-whisper-large-v3` | 2.88 GB | ASR / Transcription (CTranslate2, CUDA float16) |
| **speechbrain-spkrec-ecapa-voxceleb** | `C:\ai-models\cache\huggingface\hub\speechbrain-spkrec-ecapa-voxceleb` | 79.5 MB | Speaker Verification & Voiceprints (ECAPA-TDNN) |
| **CosyVoice2-0.5B** | `C:\ai-models\audio\cosyvoice2` | 4.52 GB | Zero-Shot Voice Cloning & High-Fidelity TTS |
| **Kokoro-82M** | `C:\ai-models\audio\kokoro` | 340 MB | Ultra-fast lightweight neural TTS (40+ voices) |

## 4. 2D Image Synthesis & Diffusion Checkpoints
### Standalone `.safetensors` Checkpoints (`image/checkpoints/`)
| Checkpoint Name | Size | Architecture |
| :--- | :--- | :--- |
| `DreamShaper_8_pruned.safetensors` |   1.99 GB | SDXL 1.0 Base / Finetune |
| `RealVisXL_V5.0_fp16.safetensors` |   6.46 GB | SDXL 1.0 Base / Finetune |
| `sd_xl_base_1.0.safetensors` |   6.46 GB | SDXL 1.0 Base / Finetune |

### HuggingFace Diffusers Cache (`cache/huggingface/hub/`)
| Model Repository | Disk Usage | Purpose |
| :--- | :--- | :--- |
| **RealVisXL V5.0 (Diffusers)** | 6.46 GB | `models--SG161222--RealVisXL_V5.0` |
| **SDXL Base 1.0 (Diffusers)** | 6.62 GB | `models--stabilityai--stable-diffusion-xl-base-1.0` |
| **SDXL Turbo (Diffusers)** | 6.46 GB | `models--stabilityai--sdxl-turbo` |
| **Animagine XL 3.1** | 6.46 GB | `models--cagliostrolab--animagine-xl-3.1` |
| **SDXL-Lightning** | 4.78 GB | `models--ByteDance--SDXL-Lightning` |
| **CLIP-ViT-bigG-14 (laion2B)** | 9.46 GB | `models--laion--CLIP-ViT-bigG-14-laion2B-39B-b160k` |
| **clip-vit-large-patch14** | 1.60 GB | `models--openai--clip-vit-large-patch14` |
| **all-MiniLM-L6-v2** | 0.91 GB | `models--sentence-transformers--all-MiniLM-L6-v2` |

## 5. 3D Asset & Mesh Synthesis
| Architecture | Path | Size | Description |
| :--- | :--- | :--- | :--- |
| **Tencent Hunyuan3D-1** | `C:\ai-models\3d\hunyuan3d` | 14.99 GB | Complete text/image-to-3D pipeline |
| **Tencent InstantMesh** | `C:\ai-models\3d\instantmesh` | 6.77 GB | Fast multi-view mesh reconstruction |
| **Microsoft TRELLIS** | `C:\ai-models\3d\trellis` | 3.07 GB | High-resolution 3D structured latents |
| **Stability AI TripoSR** | `C:\ai-models\3d\triposr` | 1.56 GB | Instant 0.5s feed-forward 3D mesh gen |

## 6. Pre-Installed Software & AI Tools
- **GPU Driver & CUDA**: Driver 616.56 | CUDA 13.4 UMD | CUDA 13.0 PyTorch runtime
- **PyTorch Stack**: `torch==2.14.1+cu130`, `torchvision==0.29.1+cu130`, `torchaudio==2.11.0+cu130`
- **Audio Processing**: `faster-whisper`, `speechbrain`, `soundfile`, `librosa`, `dawdreamer`, `mido`, `sf2utils`
- **Computer Vision**: `opencv-python`, `pillow`
- **LLM Runtime**: `ollama` daemon
- **Downloaders & Media Utilities**: `aria2c`, `ffmpeg`, `yt-dlp`
- **VCS & CLI**: `git`, `gh` (GitHub CLI)

## 7. Mandatory AI Environment Variables
```powershell
$env:HF_HOME       = 'C:\ai-models\cache\huggingface'
$env:OLLAMA_MODELS = 'C:\ai-models\cache\ollama'
$env:TORCH_HOME    = 'C:\ai-models\cache\torch'
```
In Python entrypoints:
```python
import os
os.environ.setdefault('HF_HOME', r'C:\ai-models\cache\huggingface')
os.environ.setdefault('OLLAMA_MODELS', r'C:\ai-models\cache\ollama')
os.environ.setdefault('TORCH_HOME', r'C:\ai-models\cache\torch')
```
