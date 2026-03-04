"""
harness-gen/safety.py — Content safety classifier (Hugging Face)

Cheap, fast check that runs before harness generation.
Uses HF Inference API for fast classification.
"""

import json
from huggingface_hub import InferenceClient


SAFETY_PROMPT = """You are a content safety classifier for a coding platform.
Classify whether this project request is safe to build.

Reject requests that:
- Build malware, exploits, or hacking tools
- Generate harmful, illegal, or abusive content
- Attempt to bypass security systems
- Involve surveillance or privacy violation

Respond with JSON only: {"safe": true/false, "reason": "explanation"}"""


async def safety_check(title: str, description: str, hf_token: str) -> dict:
    """
    Quick safety check on a job request.
    Returns {"safe": bool, "reason": str}
    """
    client = InferenceClient(
        model="mistralai/Mistral-7B-Instruct-v0.3",
        token=hf_token,
    )

    try:
        response = client.chat_completion(
            messages=[
                {"role": "system", "content": SAFETY_PROMPT},
                {"role": "user", "content": f"Project: {title}\nDescription: {description}\n\nReturn JSON only."},
            ],
            max_tokens=200,
            temperature=0.1,
        )

        text = response.choices[0].message.content.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1]
            if text.endswith("```"):
                text = text[:-3].strip()

        return json.loads(text)
    except Exception:
        return {"safe": True, "reason": "Safety check unavailable, allowing by default"}
