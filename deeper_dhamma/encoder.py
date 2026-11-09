"""
SpeechBrain ECAPA-TDNN Speaker Embedding Extractor.
"""

import deeper_dhamma.config  # Enforces HF_HOME and TORCH_HOME under C:\ai-models
import logging
from pathlib import Path
from typing import Union
import numpy as np
import torch
from speechbrain.inference.speaker import SpeakerRecognition

logger = logging.getLogger("speaker_encoder")


class SpeakerEncoder:
    """Wrapper around SpeechBrain ECAPA-TDNN for 192-d speaker embeddings."""

    def __init__(
        self,
        model_source: str = "speechbrain/spkrec-ecapa-voxceleb",
        device: str = "cuda:0",
        check_updates: bool = False,
    ):
        self.device = device if torch.cuda.is_available() and "cuda" in device else "cpu"
        logger.info(f"Loading SpeechBrain ECAPA-TDNN from '{model_source}' on {self.device}...")

        # Disable Windows symlink warning in SpeechBrain
        import warnings
        warnings.filterwarnings("ignore", message=".*symlink.*")

        import os
        local_dir = Path(os.environ.get("HF_HOME", r"C:\ai-models\cache\huggingface")) / "hub" / "speechbrain-spkrec-ecapa-voxceleb"
        if Path(model_source).exists():
            target_source = Path(model_source)
        elif model_source == "speechbrain/spkrec-ecapa-voxceleb" and local_dir.exists():
            target_source = local_dir
        else:
            target_source = None

        if not check_updates and target_source and (target_source / "hyperparams.yaml").exists():
            from speechbrain.utils.fetching import LocalStrategy
            self.model = SpeakerRecognition.from_hparams(
                source=str(target_source),
                savedir=str(target_source),
                overrides={"pretrained_path": str(target_source)},
                local_strategy=LocalStrategy.NO_LINK,
                run_opts={"device": self.device},
            )
        else:
            if check_updates:
                logger.info("Checking Hugging Face Hub for SpeechBrain ECAPA-TDNN updates...")
            self.model = SpeakerRecognition.from_hparams(
                source=model_source,
                run_opts={"device": self.device},
            )
        logger.info("ECAPA-TDNN model ready.")

    def encode_waveform(self, waveform_16k: Union[torch.Tensor, np.ndarray]) -> np.ndarray:
        """
        Extracts 192-d unit-normalized embedding from 16kHz mono audio.
        Input: Tensor of shape (1, T) or (T,)
        Output: 1D numpy array of shape (192,)
        """
        if isinstance(waveform_16k, np.ndarray):
            waveform_16k = torch.from_numpy(waveform_16k)

        if waveform_16k.dim() == 1:
            waveform_16k = waveform_16k.unsqueeze(0)

        waveform_16k = waveform_16k.to(self.device)

        with torch.no_grad():
            embeddings = self.model.encode_batch(waveform_16k)
            vec = embeddings.squeeze().cpu().numpy()

        # Unit normalize (L2 norm)
        norm = np.linalg.norm(vec)
        if norm > 0:
            vec = vec / norm

        return vec
