"""Small immutable data types shared by the layers (no behaviour beyond JSON conversion)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class ModelConfig:
    classes: tuple[str, ...]  # in model output order
    image_size: tuple[int, int]  # (height, width) as stored in config.json
    temperature: float

    @property
    def resize_wh(self) -> tuple[int, int]:
        """Pillow's resize() wants (width, height), the opposite order of image_size."""
        return (self.image_size[1], self.image_size[0])


@dataclass(frozen=True)
class ThresholdRow:
    threshold: float
    answered: float  # share of web-test photos that scored >= threshold
    accuracy: float  # accuracy on those answered photos


@dataclass(frozen=True)
class ScoredLabel:
    label: str
    confidence: float


@dataclass(frozen=True)
class Decision:
    status: Literal["known", "unknown"]
    label: str | None  # None when unknown


@dataclass(frozen=True)
class PredictionResult:
    probabilities: tuple[ScoredLabel, ...]  # every class, highest first
    decision: Decision
    threshold: float
    elapsed_ms: int

    def to_json(self) -> dict[str, object]:
        return {
            "probabilities": [
                {"label": p.label, "confidence": round(p.confidence, 6)} for p in self.probabilities
            ],
            "decision": {"status": self.decision.status, "label": self.decision.label},
            "threshold": self.threshold,
            "elapsed_ms": self.elapsed_ms,
        }


class InputError(Exception):
    """The upload is unusable; carries an HTTP status, a stable code and a friendly message."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
