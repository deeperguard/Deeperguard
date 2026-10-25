"""Pinned Ask AI (Ollama Cloud) provider disclosure for /verify and in-app notice."""

from __future__ import annotations

# Bump when the /verify Ask AI section changes (provider, terms pin, or server claims).
VERIFY_ASK_AI_PIN_ID = (
    "c12309b8e10a8d58ab99b46ea51f2efaa9e299d2beb0bedc14aa9dc4f7930345"
)

PRIVACY_URL = "https://ollama.com/privacy"
TERMS_URL = "https://ollama.com/terms"
DATE_CHECKED = "25 Oct 2026"


def template_globals() -> dict[str, str]:
    return {
        "verify_ask_ai_pin_id": VERIFY_ASK_AI_PIN_ID,
        "verify_ask_ai_date_checked": DATE_CHECKED,
        "verify_ask_ai_privacy_url": PRIVACY_URL,
        "verify_ask_ai_terms_url": TERMS_URL,
    }
