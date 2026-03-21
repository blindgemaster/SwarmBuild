"""
harness-gen/generator.py — Core harness generation logic

Takes a job spec and produces the complete agent environment:
AGENT_PROMPT.md, test harness, and task list.

Tries Hugging Face Inference API first, falls back to Groq.
"""

import json
import asyncio
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class JobSpec:
    title: str
    description: str
    output_type: str  # rest-api | cli | library | script | fullstack
    tech_stack: list[str] = field(default_factory=list)
    constraints: Optional[str] = None
    examples: Optional[str] = None
    agent_count: int = 1
    discussion: Optional[str] = None  # Community comments to inform the plan


@dataclass
class GeneratedPlan:
    agent_prompt: str
    test_files: dict  # filename -> content
    task_list: list[str]
    required_roles: list[str]
    quality_score: int = 0
    estimated_tokens: int = 0


SYSTEM_PROMPT = """You are an expert software architect. Given a project spec,
generate a complete agent working environment.

You MUST respond with valid JSON only — no markdown, no explanation, no code fences.

The JSON must have exactly these keys:
{
    "agent_prompt": "# Full markdown prompt for AI coding agents to build this project...",
    "test_files": {
        "test_harness/run_tests.sh": "#!/bin/bash\\n...",
        "test_harness/test_basic.py": "import pytest\\n..."
    },
    "task_list": ["task_1_description", "task_2_description"],
    "required_roles": ["lead", "backend", "frontend"],
    "quality_score": 8
}

Rules:
- task_list items should be small, specific, independently testable (~10 min each)
- agent_prompt should be comprehensive enough for an AI agent to build the entire project. Add a specific section informing the agents: "Your local code is globally synced via Git AUTOMATICALLY. The CLI runs 'git pull' when you claim a task, and 'git push' when you complete a task. Do NOT run git commits or pushes manually. Use the chat channel STRICTLY to coordinate architecture decisions with other agents, not for sending code."
- test_files should actually validate the project works end-to-end
- required_roles MUST always start with "lead" as the first entry — the lead is mandatory on every job.
- required_roles MUST contain exactly the number of roles requested by the user (e.g. ["lead", "backend", "frontend"]).
- quality_score is your confidence from 1-10"""


def _build_user_prompt(spec: JobSpec) -> str:
    """Build the user prompt for plan generation."""
    return f"""Generate an agent harness for this project:

**Title:** {spec.title}
**Description:** {spec.description}
**Output Type:** {spec.output_type}
**Tech Stack:** {', '.join(spec.tech_stack) if spec.tech_stack else 'Any'}
**Constraints:** {spec.constraints or 'None'}
**Examples:** {spec.examples or 'None'}
**Required Agent Count:** {spec.agent_count}
**Community Discussion:**
{spec.discussion if spec.discussion else 'No discussion yet.'}

Use the community discussion above to refine the plan — incorporate any feedback, clarifications, or feature requests raised there.
The FIRST role MUST be "lead". Output exactly {spec.agent_count} required_roles in your JSON. Respond with valid JSON only. No markdown code fences. No extra text."""


def _parse_response(text: str, spec: JobSpec, source: str) -> GeneratedPlan:
    """Parse LLM response text into a GeneratedPlan."""
    # Strip markdown code fence if present
    if text.startswith("```"):
        first_newline = text.index("\n")
        text = text[first_newline + 1:]
    if text.endswith("```"):
        text = text[:-3].strip()

    parsed = json.loads(text)

    print(f"[harness-gen] Success with {source}")
    return GeneratedPlan(
        agent_prompt=parsed["agent_prompt"],
        test_files=parsed.get("test_files", {}),
        task_list=parsed.get("task_list", []),
        required_roles=parsed.get("required_roles", ["teammate"] * spec.agent_count),
        quality_score=parsed.get("quality_score", 5),
        estimated_tokens=len(text),
    )


async def _generate_with_hf(spec: JobSpec, hf_token: str) -> GeneratedPlan:
    """Generate plan using Hugging Face Inference API."""
    from huggingface_hub import InferenceClient

    user_prompt = _build_user_prompt(spec)

    models_to_try = [
        "Qwen/Qwen2.5-72B-Instruct",
        "mistralai/Mistral-7B-Instruct-v0.3",
        "meta-llama/Meta-Llama-3.1-8B-Instruct",
    ]

    last_error = None

    for model_id in models_to_try:
        client = InferenceClient(model=model_id, token=hf_token)

        for attempt in range(3):
            try:
                print(f"[harness-gen] Trying HF {model_id} (attempt {attempt + 1}/3)")

                response = client.chat_completion(
                    messages=[
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": user_prompt},
                    ],
                    max_tokens=4096,
                    temperature=0.3,
                )

                text = response.choices[0].message.content.strip()
                return _parse_response(text, spec, f"HF {model_id}")

            except json.JSONDecodeError as e:
                last_error = e
                print(f"[harness-gen] JSON parse error on {model_id}: {e}")
                if attempt < 2:
                    continue
                break

            except Exception as e:
                last_error = e
                error_str = str(e)
                if "429" in error_str or "rate" in error_str.lower() or "quota" in error_str.lower():
                    wait = 10 * (2 ** attempt)
                    print(f"[harness-gen] Rate limited on {model_id}, waiting {wait}s...")
                    await asyncio.sleep(wait)
                    continue
                elif "503" in error_str or "loading" in error_str.lower():
                    print(f"[harness-gen] Model {model_id} is loading, waiting 15s...")
                    await asyncio.sleep(15)
                    continue
                print(f"[harness-gen] Error with {model_id}: {e}")
                break

    raise last_error or Exception("All Hugging Face models failed")


async def _generate_with_groq(spec: JobSpec, groq_api_key: str) -> GeneratedPlan:
    """Generate plan using Groq API (OpenAI-compatible)."""
    from openai import OpenAI

    client = OpenAI(
        api_key=groq_api_key,
        base_url="https://api.groq.com/openai/v1",
    )

    user_prompt = _build_user_prompt(spec)

    models_to_try = [
        "llama-3.3-70b-versatile",
        "llama-3.1-8b-instant",
        "mixtral-8x7b-32768",
    ]

    last_error = None

    for model_id in models_to_try:
        for attempt in range(3):
            try:
                print(f"[harness-gen] Trying Groq {model_id} (attempt {attempt + 1}/3)")

                response = client.chat.completions.create(
                    model=model_id,
                    messages=[
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": user_prompt},
                    ],
                    max_tokens=4096,
                    temperature=0.3,
                )

                text = response.choices[0].message.content.strip()
                return _parse_response(text, spec, f"Groq {model_id}")

            except json.JSONDecodeError as e:
                last_error = e
                print(f"[harness-gen] JSON parse error on {model_id}: {e}")
                if attempt < 2:
                    continue
                break

            except Exception as e:
                last_error = e
                error_str = str(e)
                if "429" in error_str or "rate" in error_str.lower():
                    wait = 10 * (2 ** attempt)
                    print(f"[harness-gen] Rate limited on {model_id}, waiting {wait}s...")
                    await asyncio.sleep(wait)
                    continue
                print(f"[harness-gen] Error with {model_id}: {e}")
                break

    raise last_error or Exception("All Groq models failed")


async def generate_harness(spec: JobSpec, hf_token: str = "", groq_api_key: str = "") -> GeneratedPlan:
    """
    Generate a complete agent harness.
    Tries Hugging Face first, falls back to Groq.
    """
    errors = []

    # Try Hugging Face first
    if hf_token:
        try:
            return await _generate_with_hf(spec, hf_token)
        except Exception as e:
            print(f"[harness-gen] HuggingFace failed, trying Groq fallback: {e}")
            errors.append(f"HuggingFace: {e}")

    # Fallback to Groq
    if groq_api_key:
        try:
            return await _generate_with_groq(spec, groq_api_key)
        except Exception as e:
            print(f"[harness-gen] Groq failed: {e}")
            errors.append(f"Groq: {e}")

    if not hf_token and not groq_api_key:
        raise Exception("No AI API keys configured. Set HUGGING_FACE_TOKEN or GROQ_API_KEY in .env")

    raise Exception(f"All plan generation providers failed: {'; '.join(errors)}")
