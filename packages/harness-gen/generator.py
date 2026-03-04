"""
harness-gen/generator.py — Core harness generation logic (Hugging Face)

Takes a job spec and produces the complete agent environment:
AGENT_PROMPT.md, test harness, and task list.

Uses Hugging Face Inference API with free serverless models.
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


async def generate_harness(spec: JobSpec, hf_token: str) -> GeneratedPlan:
    """
    Generate a complete agent harness using Hugging Face Inference API.
    Tries multiple free models with retry logic.
    """
    from huggingface_hub import InferenceClient

    user_prompt = f"""Generate an agent harness for this project:

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

    # Free serverless models on HF, in preference order
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
                print(f"[harness-gen] Trying {model_id} (attempt {attempt + 1}/3)")

                response = client.chat_completion(
                    messages=[
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": user_prompt},
                    ],
                    max_tokens=4096,
                    temperature=0.3,
                )

                text = response.choices[0].message.content.strip()

                # Strip markdown code fence if present
                if text.startswith("```"):
                    first_newline = text.index("\n")
                    text = text[first_newline + 1:]
                if text.endswith("```"):
                    text = text[:-3].strip()

                parsed = json.loads(text)

                print(f"[harness-gen] Success with {model_id}")
                return GeneratedPlan(
                    agent_prompt=parsed["agent_prompt"],
                    test_files=parsed.get("test_files", {}),
                    task_list=parsed.get("task_list", []),
                    required_roles=parsed.get("required_roles", ["teammate"] * spec.agent_count),
                    quality_score=parsed.get("quality_score", 5),
                    estimated_tokens=response.usage.total_tokens if response.usage else len(text),
                )

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
                    wait = 10 * (2 ** attempt)  # 10s, 20s, 40s
                    print(f"[harness-gen] Rate limited on {model_id}, waiting {wait}s...")
                    await asyncio.sleep(wait)
                    continue
                elif "503" in error_str or "loading" in error_str.lower():
                    print(f"[harness-gen] Model {model_id} is loading, waiting 15s...")
                    await asyncio.sleep(15)
                    continue
                # Other errors — try next model
                print(f"[harness-gen] Error with {model_id}: {e}")
                break

    raise last_error or Exception("All Hugging Face models failed")
