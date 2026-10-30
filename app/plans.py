"""Subscription plans (Free / Basic / Pro) and Stripe billing integration."""
from __future__ import annotations

import os
from typing import Any

PLAN_FREE = "free"
PLAN_BASIC = "basic"
PLAN_PRO = "pro"
VALID_PLANS = frozenset({PLAN_FREE, PLAN_BASIC, PLAN_PRO})
PLAN_ORDER = (PLAN_FREE, PLAN_BASIC, PLAN_PRO)

# Optional single-line checkout status on marketing (empty = omit).
MARKETING_BILLING_NOTE = ""

# Soft cap on concurrent signed-in device sessions (None = unlimited).
PLAN_SESSION_CAPS: dict[str, int | None] = {
    PLAN_FREE: 3,
    PLAN_BASIC: 10,
    PLAN_PRO: None,
}

# Secure Send creates per UTC day (None = unlimited).
PLAN_SECURE_SEND_DAILY_LIMITS: dict[str, int | None] = {
    PLAN_FREE: 3,
    PLAN_BASIC: 10,
    PLAN_PRO: None,
}

# Suggested retail pricing (EUR) for display only until billing ships.
PLAN_CATALOG: dict[str, dict[str, Any]] = {
    PLAN_FREE: {
        "label": "Free",
        "storage_quota_mb": 50,
        "suggested_price_eur_month": 0.0,
        "suggested_price_eur_year": 0.0,
        "tagline": "Encrypted notes to get started",
        "active_sessions": PLAN_SESSION_CAPS[PLAN_FREE],
        "secure_send_per_day": PLAN_SECURE_SEND_DAILY_LIMITS[PLAN_FREE],
    },
    PLAN_BASIC: {
        "label": "Basic",
        "storage_quota_mb": 100,
        "suggested_price_eur_month": 2.99,
        "suggested_price_eur_year": 29.0,
        "tagline": "Private encrypted notes on every device",
        "active_sessions": PLAN_SESSION_CAPS[PLAN_BASIC],
        "secure_send_per_day": PLAN_SECURE_SEND_DAILY_LIMITS[PLAN_BASIC],
    },
    PLAN_PRO: {
        "label": "Pro",
        "storage_quota_mb": 5120,
        "suggested_price_eur_month": 6.99,
        "suggested_price_eur_year": 69.0,
        "tagline": "Backups, security extras, and room to grow",
        "active_sessions": PLAN_SESSION_CAPS[PLAN_PRO],
        "secure_send_per_day": PLAN_SECURE_SEND_DAILY_LIMITS[PLAN_PRO],
    },
}


def plan_structured_data_offers() -> list[dict[str, Any]]:
    """Schema.org Offer list for homepage JSON-LD (Free €0; paid tiers not €0)."""
    offers: list[dict[str, Any]] = []
    for key in PLAN_ORDER:
        meta = PLAN_CATALOG[key]
        month = float(meta["suggested_price_eur_month"])
        offers.append(
            {
                "@type": "Offer",
                "name": str(meta["label"]),
                "price": f"{month:.2f}",
                "priceCurrency": "EUR",
                "description": (
                    f"{meta['storage_quota_mb']} MB storage"
                    if key != PLAN_PRO
                    else f"{int(meta['storage_quota_mb'] / 1024)} GB storage"
                ),
            }
        )
    return offers

FEATURE_CATALOG: dict[str, dict[str, Any]] = {
    "sync": {
        "label": "Encrypted note sync",
        "description": "End-to-end encrypted notes on phone, tablet, and desktop.",
        "plans": {PLAN_FREE, PLAN_BASIC, PLAN_PRO},
    },
    "attachments": {
        "label": "Attachments & scans",
        "description": "Photos, PDFs, and files within your storage quota.",
        "plans": {PLAN_FREE, PLAN_BASIC, PLAN_PRO},
    },
    "import_export": {
        "label": "Import & export",
        "description": "Manual vault export and Standard Notes import.",
        "plans": {PLAN_FREE, PLAN_BASIC, PLAN_PRO},
    },
    "document_ocr": {
        "label": "Document OCR & search",
        "description": "Search text inside scans and PDFs on your device.",
        "plans": {PLAN_FREE, PLAN_BASIC, PLAN_PRO},
    },
    "passkeys": {
        "label": "Passkey sign-in",
        "description": "Sign in without typing your account password.",
        "plans": {PLAN_PRO},
    },
    "account_2fa": {
        "label": "Account two-factor authentication",
        "description": "TOTP on your Deeperguard login.",
        "plans": {PLAN_PRO},
    },
    "email_backup": {
        "label": "Daily email backup",
        "description": "Encrypted backup archive to your inbox.",
        "plans": {PLAN_PRO},
    },
    "pcloud_backup": {
        "label": "pCloud backup",
        "description": "Automated encrypted backups to your pCloud folder.",
        "plans": {PLAN_PRO},
    },
    "reminders": {
        "label": "Note reminders",
        "description": "Email when a note is due.",
        "plans": {PLAN_PRO},
    },
    "vault_authenticator": {
        "label": "Vault authenticator",
        "description": "Store 2FA codes inside your encrypted vault.",
        "plans": {PLAN_PRO},
    },
}


def default_plan() -> str:
    """Plan for new registrations when NOTES_DEFAULT_PLAN is unset or invalid.

    Code default is Free. Set NOTES_DEFAULT_PLAN to basic or pro only when you
    intentionally override signup (staging); existing users keep stored plan values.
    """
    raw = os.environ.get("NOTES_DEFAULT_PLAN", PLAN_FREE).strip().lower()
    return raw if raw in VALID_PLANS else PLAN_FREE


def normalize_plan(plan: str | None) -> str:
    raw = str(plan or default_plan()).strip().lower()
    return raw if raw in VALID_PLANS else default_plan()


def plan_storage_quota_bytes(plan: str | None) -> int:
    meta = PLAN_CATALOG[normalize_plan(plan)]
    return int(meta["storage_quota_mb"]) * 1024 * 1024


def plan_active_session_limit(plan: str | None) -> int | None:
    """Max concurrent active device sessions, or None when unlimited."""
    return PLAN_SESSION_CAPS.get(normalize_plan(plan))


def plan_secure_send_daily_limit(plan: str | None) -> int | None:
    """Max Secure Send creates per UTC day, or None when unlimited."""
    return PLAN_SECURE_SEND_DAILY_LIMITS.get(normalize_plan(plan))


def secure_send_daily_cap_message(plan: str | None = None) -> str:
    limit = plan_secure_send_daily_limit(plan)
    if limit is None:
        limit = PLAN_SECURE_SEND_DAILY_LIMITS[PLAN_FREE]
    return (
        f"Daily Secure Send limit reached ({int(limit)} per day on your plan). "
        "Try again tomorrow."
    )


def utc_day_start_timestamp() -> float:
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return start.timestamp()


def secure_send_over_daily_limit(plan: str | None, creates_today: int) -> bool:
    """True when the user has already hit the plan's Secure Send daily cap."""
    limit = plan_secure_send_daily_limit(plan)
    if limit is None:
        return False
    try:
        return int(creates_today) >= int(limit)
    except (TypeError, ValueError):
        return False


def plan_has(plan: str | None, feature: str) -> bool:
    entry = FEATURE_CATALOG.get(feature)
    if not entry:
        return False
    return normalize_plan(plan) in entry["plans"]


def plan_feature_flags(plan: str | None) -> dict[str, bool]:
    current = normalize_plan(plan)
    return {key: current in entry["plans"] for key, entry in FEATURE_CATALOG.items()}


def plan_billing_note(plan: str | None) -> str:
    """Human-readable plan price line for Settings and API."""
    current = normalize_plan(plan)
    if current == PLAN_FREE:
        return "Free forever"
    meta = PLAN_CATALOG[current]
    month = float(meta["suggested_price_eur_month"])
    year = float(meta["suggested_price_eur_year"])
    return f"€{month:.2f}/mo or €{year:.0f}/yr"


def plan_pricing_payload(plan: str | None) -> dict[str, Any]:
    current = normalize_plan(plan)
    meta = PLAN_CATALOG[current]
    return {
        "plan": current,
        "label": meta["label"],
        "tagline": meta["tagline"],
        "price_eur_month": 0.0,
        "price_eur_year": 0.0,
        "suggested_price_eur_month": meta["suggested_price_eur_month"],
        "suggested_price_eur_year": meta["suggested_price_eur_year"],
        "billing_active": False,
        "billing_note": plan_billing_note(current),
        "active_sessions": meta.get("active_sessions"),
        "secure_send_per_day": meta.get("secure_send_per_day"),
    }


def account_plan_payload(plan: str | None, user=None) -> dict[str, Any]:
    current = normalize_plan(plan)
    meta = PLAN_CATALOG[current]
    try:
        from stripe_billing import billing_public_payload, plan_pricing_with_billing

        pricing = plan_pricing_with_billing(current, user)
        billing = billing_public_payload(user)
    except Exception:
        pricing = plan_pricing_payload(current)
        billing = {"enabled": False, "has_customer": False, "has_subscription": False}
    return {
        "plan": current,
        "plan_label": meta["label"],
        "plan_tagline": meta["tagline"],
        "plan_features": plan_feature_flags(current),
        "plan_catalog": {
            key: {
                "label": PLAN_CATALOG[key]["label"],
                "storage_quota_mb": PLAN_CATALOG[key]["storage_quota_mb"],
                "suggested_price_eur_month": PLAN_CATALOG[key]["suggested_price_eur_month"],
                "suggested_price_eur_year": PLAN_CATALOG[key]["suggested_price_eur_year"],
                "active_sessions": PLAN_CATALOG[key].get("active_sessions"),
                "secure_send_per_day": PLAN_CATALOG[key].get("secure_send_per_day"),
                "features": [
                    feat["label"]
                    for feat_key, feat in FEATURE_CATALOG.items()
                    if key in feat["plans"]
                ],
            }
            for key in PLAN_ORDER
        },
        "plan_pricing": pricing,
        "billing": billing,
    }


def plan_required_error(plan: str | None, feature: str) -> dict[str, Any]:
    current = normalize_plan(plan)
    feat = FEATURE_CATALOG.get(feature) or {}
    return {
        "error": "Pro plan required",
        "code": "plan_required",
        "plan": current,
        "required_plan": PLAN_PRO,
        "feature": feature,
        "feature_label": feat.get("label") or feature,
    }
