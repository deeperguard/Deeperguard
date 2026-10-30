"""Stripe Checkout + Customer Portal subscription billing (Basic / Pro)."""
from __future__ import annotations

import os
import time
from typing import Any

from plans import PLAN_BASIC, PLAN_FREE, PLAN_PRO, normalize_plan

# Lazy import so tests run without stripe installed until used.
_stripe = None


def _stripe_module():
    global _stripe
    if _stripe is None:
        import stripe as stripe_mod

        _stripe = stripe_mod
    return _stripe


def stripe_secret_key() -> str:
    return os.environ.get("STRIPE_SECRET_KEY", "").strip()


def stripe_webhook_secret() -> str:
    return os.environ.get("STRIPE_WEBHOOK_SECRET", "").strip()


def stripe_publishable_key() -> str:
    return os.environ.get("STRIPE_PUBLISHABLE_KEY", "").strip()


def billing_enabled() -> bool:
    """True when Stripe secret key and all four price IDs are configured."""
    if os.environ.get("STRIPE_BILLING_ENABLED", "").strip().lower() in {"0", "false", "no"}:
        return False
    if not stripe_secret_key():
        return False
    return all(_price_ids().values())


def _price_ids() -> dict[str, str]:
    return {
        f"{PLAN_BASIC}:month": os.environ.get("STRIPE_PRICE_BASIC_MONTHLY", "").strip(),
        f"{PLAN_BASIC}:year": os.environ.get("STRIPE_PRICE_BASIC_YEARLY", "").strip(),
        f"{PLAN_PRO}:month": os.environ.get("STRIPE_PRICE_PRO_MONTHLY", "").strip(),
        f"{PLAN_PRO}:year": os.environ.get("STRIPE_PRICE_PRO_YEARLY", "").strip(),
    }


def price_id_for(plan: str, interval: str) -> str | None:
    plan = normalize_plan(plan)
    if plan not in {PLAN_BASIC, PLAN_PRO}:
        return None
    iv = "year" if str(interval or "").strip().lower() in {"year", "yearly", "annual"} else "month"
    pid = _price_ids().get(f"{plan}:{iv}", "")
    return pid or None


def plan_for_price_id(price_id: str | None) -> str | None:
    if not price_id:
        return None
    for key, pid in _price_ids().items():
        if pid and pid == price_id:
            return key.split(":", 1)[0]
    return None


def _configure_stripe() -> None:
    key = stripe_secret_key()
    if not key:
        raise RuntimeError("Stripe is not configured")
    mod = _stripe_module()
    mod.api_key = key


def billing_public_payload(user) -> dict[str, Any]:
    """Account-facing billing flags (no secrets)."""
    enabled = billing_enabled()
    customer_id = ""
    sub_id = ""
    cancel_at_period_end = False
    period_end = 0.0
    if user:
        try:
            customer_id = str(user["stripe_customer_id"] or "").strip()
        except (KeyError, TypeError):
            customer_id = ""
        try:
            sub_id = str(user["stripe_subscription_id"] or "").strip()
        except (KeyError, TypeError):
            sub_id = ""
        try:
            cancel_at_period_end = bool(int(user["stripe_cancel_at_period_end"] or 0))
        except (KeyError, TypeError, ValueError):
            cancel_at_period_end = False
        try:
            period_end = float(user["stripe_subscription_period_end"] or 0)
        except (KeyError, TypeError, ValueError):
            period_end = 0.0
    return {
        "enabled": enabled,
        "has_customer": bool(customer_id),
        "has_subscription": bool(sub_id),
        "cancel_at_period_end": cancel_at_period_end,
        "subscription_period_end": period_end if period_end > 0 else None,
    }


def checkout_success_url(base_url: str, entry_path: str) -> str:
    base = base_url.rstrip("/")
    path = entry_path if entry_path.startswith("/") else f"/{entry_path}"
    return f"{base}{path}?billing=return&session_id={{CHECKOUT_SESSION_ID}}"


def checkout_cancel_url(base_url: str, entry_path: str) -> str:
    base = base_url.rstrip("/")
    path = entry_path if entry_path.startswith("/") else f"/{entry_path}"
    return f"{base}{path}?billing=canceled"


def portal_return_url(base_url: str, entry_path: str) -> str:
    base = base_url.rstrip("/")
    path = entry_path if entry_path.startswith("/") else f"/{entry_path}"
    return f"{base}{path}?billing=portal"


def create_checkout_session(
    *,
    user_id: int,
    email: str,
    plan: str,
    interval: str,
    customer_id: str | None,
    success_url: str,
    cancel_url: str,
) -> str:
    """Return Stripe Checkout Session URL."""
    import db

    _configure_stripe()
    mod = _stripe_module()
    price_id = price_id_for(plan, interval)
    if not price_id:
        raise ValueError("invalid plan or billing interval")
    normalized = normalize_plan(plan)
    if normalized == PLAN_FREE:
        raise ValueError("cannot checkout for free plan")

    session_params: dict[str, Any] = {
        "mode": "subscription",
        "line_items": [{"price": price_id, "quantity": 1}],
        "success_url": success_url,
        "cancel_url": cancel_url,
        "client_reference_id": str(int(user_id)),
        "metadata": {"user_id": str(int(user_id)), "plan": normalized},
        "subscription_data": {"metadata": {"user_id": str(int(user_id)), "plan": normalized}},
    }
    if customer_id:
        session_params["customer"] = customer_id
    else:
        session_params["customer_email"] = email

    session = mod.checkout.Session.create(**session_params)
    cid = str(getattr(session, "customer", None) or "")
    if cid and not customer_id:
        db.update_user_stripe_customer(int(user_id), cid)
    url = str(getattr(session, "url", None) or "")
    if not url:
        raise RuntimeError("checkout session missing url")
    return url


def create_portal_session(*, customer_id: str, return_url: str) -> str:
    _configure_stripe()
    mod = _stripe_module()
    session = mod.billing_portal.Session.create(customer=customer_id, return_url=return_url)
    url = str(getattr(session, "url", None) or "")
    if not url:
        raise RuntimeError("portal session missing url")
    return url


def verify_checkout_session_for_user(session_id: str, user_id: int) -> dict[str, Any]:
    """Retrieve checkout session; return status for post-redirect UI."""
    _configure_stripe()
    mod = _stripe_module()
    session = mod.checkout.Session.retrieve(session_id, expand=["subscription"])
    ref = str(getattr(session, "client_reference_id", None) or "")
    meta_uid = str((getattr(session, "metadata", None) or {}).get("user_id") or "")
    if ref != str(int(user_id)) and meta_uid != str(int(user_id)):
        return {"ok": False, "code": "forbidden"}
    payment_status = str(getattr(session, "payment_status", None) or "")
    status = str(getattr(session, "status", None) or "")
    if payment_status == "paid" or status == "complete":
        plan = str((getattr(session, "metadata", None) or {}).get("plan") or "")
        sub = getattr(session, "subscription", None)
        if sub and not plan:
            plan = _plan_from_subscription_object(sub) or plan
        plan = normalize_plan(plan) if plan in {PLAN_BASIC, PLAN_PRO} else None
        return {"ok": True, "code": "success", "plan": plan}
    return {"ok": False, "code": "payment_failed"}


def _subscription_price_id(subscription: Any) -> str | None:
    items = getattr(subscription, "items", None)
    data = getattr(items, "data", None) if items is not None else None
    if not data:
        if isinstance(subscription, dict):
            data = (subscription.get("items") or {}).get("data") or []
        else:
            return None
    if not data:
        return None
    first = data[0]
    price = first.get("price") if isinstance(first, dict) else getattr(first, "price", None)
    if isinstance(price, dict):
        return str(price.get("id") or "") or None
    return str(getattr(price, "id", None) or "") or None


def _plan_from_subscription_object(subscription: Any) -> str | None:
    meta = getattr(subscription, "metadata", None) if not isinstance(subscription, dict) else subscription.get("metadata")
    if isinstance(meta, dict):
        plan = str(meta.get("plan") or "")
        if plan in {PLAN_BASIC, PLAN_PRO}:
            return plan
    return plan_for_price_id(_subscription_price_id(subscription))


def apply_subscription_to_user(user_id: int, subscription: Any) -> None:
    """Sync plan + stripe fields from a Stripe subscription object or dict."""
    import db

    if isinstance(subscription, dict):
        sub_dict = subscription
    else:
        sub_dict = subscription.to_dict() if hasattr(subscription, "to_dict") else dict(subscription)

    status = str(sub_dict.get("status") or "")
    customer_id = str(sub_dict.get("customer") or "")
    sub_id = str(sub_dict.get("id") or "")
    cancel_at_period_end = bool(sub_dict.get("cancel_at_period_end"))
    period_end = float(sub_dict.get("current_period_end") or 0)

    db.update_user_stripe_subscription(
        int(user_id),
        customer_id=customer_id or None,
        subscription_id=sub_id or None,
        period_end=period_end,
        cancel_at_period_end=cancel_at_period_end,
    )

    if status in {"active", "trialing", "past_due"}:
        plan = _plan_from_subscription_object(sub_dict)
        if plan:
            db.update_user_plan(int(user_id), plan)
        return
    if status in {"canceled", "unpaid", "incomplete_expired"}:
        db.update_user_plan(int(user_id), PLAN_FREE)


def handle_webhook_payload(payload: bytes, sig_header: str) -> tuple[bool, str]:
    """Verify signature and apply events. Returns (ok, detail)."""
    import db

    secret = stripe_webhook_secret()
    if not secret:
        return False, "webhook not configured"
    _configure_stripe()
    mod = _stripe_module()
    try:
        event = mod.Webhook.construct_event(payload, sig_header, secret)
    except ValueError:
        return False, "invalid payload"
    except mod.error.SignatureVerificationError:
        return False, "invalid signature"

    etype = str(getattr(event, "type", None) or "")
    data_obj = getattr(getattr(event, "data", None), "object", None)

    if etype == "checkout.session.completed":
        session = data_obj
        uid = _user_id_from_checkout_session(session)
        if uid is None:
            return True, "checkout ignored (no user)"
        customer_id = str(getattr(session, "customer", None) or "")
        sub_id = str(getattr(session, "subscription", None) or "")
        if customer_id:
            db.update_user_stripe_customer(uid, customer_id)
        if sub_id:
            sub = mod.Subscription.retrieve(sub_id)
            apply_subscription_to_user(uid, sub)
        return True, "checkout applied"

    if etype in {"customer.subscription.updated", "customer.subscription.deleted"}:
        sub = data_obj
        uid = _user_id_from_subscription(sub, mod)
        if uid is None:
            return True, "subscription ignored (no user)"
        apply_subscription_to_user(uid, sub)
        return True, "subscription applied"

    if etype == "invoice.paid":
        sub_id = ""
        if isinstance(data_obj, dict):
            sub_id = str(data_obj.get("subscription") or "")
        else:
            sub_id = str(getattr(data_obj, "subscription", None) or "")
        if sub_id:
            sub = mod.Subscription.retrieve(sub_id)
            uid = _user_id_from_subscription(sub, mod)
            if uid is not None:
                apply_subscription_to_user(uid, sub)
                return True, "invoice subscription applied"
        return True, "invoice ignored"

    return True, "ignored"


def _user_id_from_checkout_session(session: Any) -> int | None:
    import db

    ref = str(getattr(session, "client_reference_id", None) or "")
    meta = getattr(session, "metadata", None) or {}
    for raw in (ref, str(meta.get("user_id") or "")):
        if raw.isdigit():
            return int(raw)
    customer_id = str(getattr(session, "customer", None) or "")
    if customer_id:
        user = db.get_user_by_stripe_customer(customer_id)
        if user:
            return int(user["id"])
    return None


def _user_id_from_subscription(sub: Any, mod: Any) -> int | None:
    import db

    meta = getattr(sub, "metadata", None) if not isinstance(sub, dict) else sub.get("metadata")
    if isinstance(meta, dict):
        raw = str(meta.get("user_id") or "")
        if raw.isdigit():
            return int(raw)
    customer_id = str(getattr(sub, "customer", None) or "" if not isinstance(sub, dict) else sub.get("customer") or "")
    if customer_id:
        user = db.get_user_by_stripe_customer(customer_id)
        if user:
            return int(user["id"])
    return None


def plan_pricing_with_billing(plan: str | None, user=None) -> dict[str, Any]:
    """Extend plan_pricing_payload with live billing_active and subscribed prices."""
    from plans import PLAN_CATALOG, plan_pricing_payload

    payload = plan_pricing_payload(plan)
    if not billing_enabled():
        return payload
    payload["billing_active"] = True
    current = normalize_plan(plan)
    meta = PLAN_CATALOG[current]
    payload["price_eur_month"] = float(meta["suggested_price_eur_month"])
    payload["price_eur_year"] = float(meta["suggested_price_eur_year"])
    return payload
