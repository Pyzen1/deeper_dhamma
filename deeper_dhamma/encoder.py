"""
SpeechBrain ECAPA-TDNN Speaker Embedding Extractor.
"""

import deeper_dhamma.config  # Enforces HF_HOME and TORCH_HOME under C:\ai-models
import logging
from pathlib import Path
from typing import Dict, List, Union
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

    def encode_waveforms_batch(
        self,
        waveforms: List[Union[torch.Tensor, np.ndarray]],
        max_batch_size: int = 32,
    ) -> List[np.ndarray]:
        """
        Extracts 192-d unit-normalized embeddings for a list of 16kHz mono waveforms.
        Groups waveforms of identical frame length into zero-padded GPU batches to avoid
        any boundary padding artifacts while deferring CPU synchronization to a single pass.
        """
        if not waveforms:
            return []

        tensors_1d: List[torch.Tensor] = []
        length_groups: Dict[int, List[int]] = {}
        for idx, w in enumerate(waveforms):
            if isinstance(w, np.ndarray):
                w = torch.from_numpy(w)
            if w.dim() > 1:
                w = w.squeeze(0)
            tensors_1d.append(w)
            length_groups.setdefault(int(w.shape[-1]), []).append(idx)

        results_gpu: List[torch.Tensor] = [None] * len(waveforms)  # type: ignore[list-item]
        with torch.no_grad():
            for length, indices in length_groups.items():
                if length <= 0:
                    for idx in indices:
                        results_gpu[idx] = torch.zeros(192, device=self.device)
                    continue
                if len(indices) == 1:
                    idx = indices[0]
                    w_gpu = tensors_1d[idx].unsqueeze(0).to(self.device)
                    emb = self.model.encode_batch(w_gpu).reshape(-1)
                    results_gpu[idx] = emb
                else:
                    for start in range(0, len(indices), max_batch_size):
                        chunk_idxs = indices[start : start + max_batch_size]
                        batch_gpu = torch.stack([tensors_1d[i] for i in chunk_idxs], dim=0).to(self.device)
                        batch_embs = self.model.encode_batch(batch_gpu).reshape(len(chunk_idxs), -1)
                        for b_pos, orig_idx in enumerate(chunk_idxs):
                            results_gpu[orig_idx] = batch_embs[b_pos]

            all_vecs = torch.stack(results_gpu, dim=0).cpu().numpy()

        out: List[np.ndarray] = []
        for vec in all_vecs:
            norm = float(np.linalg.norm(vec))
            if norm > 0:
                vec = vec / norm
            out.append(vec)
        return out
