"""
Swarmbuild Harness Generator Package

Exports:
- generate_harness() — main generation function
- safety_check() — content safety classifier
- JobSpec, GeneratedPlan — data models

Uses Hugging Face Inference API for AI generation.
"""

from .generator import generate_harness, JobSpec, GeneratedPlan
from .safety import safety_check

__all__ = [
    "generate_harness",
    "safety_check",
    "JobSpec",
    "GeneratedPlan",
]
