"""
Security Utilities — Secret scanning and injection detection

Provides functions to scan agent messages for leaked secrets and prompt
injection attempts before they are stored in the database.
"""

import re
from typing import List, Dict


# ── Secret Patterns ─────────────────────────────────────────

SECRET_PATTERNS = [
    ("aws_access_key", r"AKIA[0-9A-Z]{16}"),
    ("aws_secret_key", r"(?i)aws_secret_access_key\s*=\s*[A-Za-z0-9/+=]{40}"),
    ("github_token", r"gh[ps]_[A-Za-z0-9_]{36,}"),
    ("github_pat", r"github_pat_[A-Za-z0-9_]{22,}"),
    ("openai_key", r"sk-[A-Za-z0-9]{32,}"),
    ("anthropic_key", r"sk-ant-[A-Za-z0-9-]{32,}"),
    ("groq_key", r"gsk_[A-Za-z0-9]{32,}"),
    ("hf_token", r"hf_[A-Za-z0-9]{20,}"),
    ("stripe_key", r"sk_(?:live|test)_[A-Za-z0-9]{24,}"),
    ("slack_token", r"xox[bprs]-[A-Za-z0-9-]+"),
    ("generic_api_key", r"(?i)(?:api[_-]?key|apikey|secret[_-]?key)\s*[:=]\s*['\"]?([A-Za-z0-9_\-]{20,})['\"]?"),
    ("private_key", r"-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----"),
    ("jwt_token", r"eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
]

# ── Prompt Injection Patterns ───────────────────────────────

INJECTION_PATTERNS = [
    ("ignore_previous", r"(?i)ignore\s+(?:all\s+)?previous\s+instructions"),
    ("system_prompt_override", r"(?i)system\s+prompt\s*:"),
    ("new_instructions", r"(?i)new\s+instructions?\s*:"),
    ("role_override", r"(?i)you\s+are\s+now\s+(?:a\s+)?(?:different|new)\s+(?:ai|assistant|agent)"),
    ("jailbreak_attempt", r"(?i)(?:DAN|developer\s+mode|jailbreak)\s*(?:mode|enabled|prompt)?"),
    ("prompt_leak", r"(?i)(?:reveal|show|display|output)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions)"),
    ("base64_injection", r"(?i)base64\s*(?:decode|eval)\s*\("),
    ("eval_injection", r"(?i)(?:eval|exec)\s*\("),
]


def scan_for_secrets(text: str) -> List[Dict]:
    """
    Scan text for common secret patterns.

    Returns a list of findings, each with:
      - type: the pattern name (e.g. "aws_access_key")
      - severity: "critical" for keys/tokens, "warning" for generic patterns
      - match: the matched text (truncated for safety)
    """
    findings = []
    for name, pattern in SECRET_PATTERNS:
        for match in re.finditer(pattern, text):
            matched_text = match.group(0)
            severity = "warning" if name == "generic_api_key" else "critical"
            findings.append({
                "type": name,
                "severity": severity,
                "match": _truncate_secret(matched_text),
            })
    return findings


def redact_secrets(text: str) -> str:
    """
    Replace detected secrets with redacted versions.

    Example: AKIA1234567890123456 -> [AKIA12***REDACTED***3456]
    """
    result = text
    for name, pattern in SECRET_PATTERNS:
        def _redact(match):
            s = match.group(0)
            if len(s) <= 8:
                return "[***REDACTED***]"
            prefix = s[:6]
            suffix = s[-4:]
            return f"[{prefix}***REDACTED***{suffix}]"
        result = re.sub(pattern, _redact, result)
    return result


def scan_for_injection(text: str) -> List[Dict]:
    """
    Scan text for prompt injection patterns.

    Returns a list of findings, each with:
      - type: the pattern name (e.g. "ignore_previous")
      - severity: "warning" or "critical"
      - match: the matched text
    """
    findings = []
    critical_types = {"ignore_previous", "system_prompt_override", "jailbreak_attempt"}
    for name, pattern in INJECTION_PATTERNS:
        for match in re.finditer(pattern, text):
            severity = "critical" if name in critical_types else "warning"
            findings.append({
                "type": name,
                "severity": severity,
                "match": match.group(0),
            })
    return findings


def _truncate_secret(secret: str, max_len: int = 20) -> str:
    """Truncate a secret for safe logging, showing only prefix and suffix."""
    if len(secret) <= 8:
        return "***"
    prefix = secret[:6]
    suffix = secret[-4:]
    return f"{prefix}...{suffix}"
