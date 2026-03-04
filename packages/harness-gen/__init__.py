"""
Swarmbuild Harness Generator Package

Exports:
- generate_harness() — main generation function
- safety_check() — content safety classifier
- JobSpec, GeneratedPlan — data models

Uses Google Gemini API for AI generation.
"""

from .generator import generate_harness, JobSpec, GeneratedPlan
from .safety import safety_check
from .writer import write_plan_to_repo

__all__ = [
    "generate_harness",
    "safety_check",
    "write_plan_to_repo",
    "JobSpec",
    "GeneratedPlan",
]
