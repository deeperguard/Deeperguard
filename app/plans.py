"""Subscription plans (Basic / Pro). Billing is not wired yet — both are free during beta."""
from __future__ import annotations

import os
from typing import Any

PLAN_BASIC = "basic"
PLAN_PRO = "pro"
VALID_PLANS = frozenset({PLAN_BASIC, PLAN_PRO})

# Suggested retail pricing (EUR) for display only until billing ships.
PLAN_CATALOG: dict[str, dict[str, Any]] = {
    PLAN_BASIC: {
        "label": "Basic",
        "storage_quota_mb": 100,
        "suggested_price_eur_month": 2.99,
        "suggested_price_eur_year": 29.0,
        "tagline": "Private encrypted notes on every device",
    },
    PLAN_PRO: {
        "label": "Pro",
        "storage_quota_mb": 5120,
        "suggested_price_eur_month": 6.99,
        "suggested_price_eur_year": 69.0,
        "tagline": "Backups, security extras, and room to grow",
    },
}

FEATURE_CATALOG: dict[str, dict[str, Any]] = {
    "sync": {
        "label": "Encrypted note sync",
        "description": "End-to-end encrypted notes on phone, tablet, and desktop.",
        "plans": {PLAN_BASIC, PLAN_PRO},
    },
    "attachments": {
        "label": "Attachments & scans",
        "description": "Photos, PDFs, and files within your storage quota.",
        "plans": {PLAN_BASIC, PLAN_PRO},
    },
    "import_export": {
        "label": "Import & export",
        "description": "Manual vault export and Standard Notes import.",
        "plans": {PLAN_BASIC, PLAN_PRO},
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
    "document_ocr": {
        "label": "Document OCR & search",
        "description": "Search text inside scans and PDFs on your device.",
        "plans": {PLAN_PRO},
    },
    "vault_authenticator": {
        "label": "Vault authenticator",
        "description": "Store 2FA codes inside your encrypted vault.",
        "plans": {PLAN_PRO},
    },
}


def default_plan() -> str:
    raw = os.environ.get("NOTES_DEFAULT_PLAN", PLAN_PRO).strip().lower()
    return raw if raw in VALID_PLANS else PLAN_PRO


def normalize_plan(plan: str | None) -> str:
    raw = str(plan or default_plan()).strip().lower()
    return raw if raw in VALID_PLANS else default_plan()


def plan_storage_quota_bytes(plan: str | None) -> int:
    meta = PLAN_CATALOG[normalize_plan(plan)]
    return int(meta["storage_quota_mb"]) * 1024 * 1024


def plan_has(plan: str | None, feature: str) -> bool:
    entry = FEATURE_CATALOG.get(feature)
    if not entry:
        return False
    return normalize_plan(plan) in entry["plans"]


def plan_feature_flags(plan: str | None) -> dict[str, bool]:
    current = normalize_plan(plan)
    return {key: current in entry["plans"] for key, entry in FEATURE_CATALOG.items()}


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
        "billing_note": "Free during public beta",
    }


def account_plan_payload(plan: str | None) -> dict[str, Any]:
    current = normalize_plan(plan)
    meta = PLAN_CATALOG[current]
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
                "features": [
                    feat["label"]
                    for feat_key, feat in FEATURE_CATALOG.items()
                    if key in feat["plans"]
                ],
            }
            for key in sorted(VALID_PLANS)
        },
        "plan_pricing": plan_pricing_payload(current),
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
