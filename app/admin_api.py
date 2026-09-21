"""Admin dashboard API and access control."""
from __future__ import annotations

import logging
import time
from typing import Any

from flask import jsonify, render_template, request

import auth
import db
import server_info_cache
from config import (
    allow_register,
    ocr_ephemeral,
    quota_bytes_from_mb,
    server_ocr_enabled,
    SMTP_HOST,
    user_admin_flags,
    user_is_admin,
    user_is_admin_email,
)
from plans import PLAN_BASIC, PLAN_PRO, normalize_plan

log = logging.getLogger("deeperguard.admin")


def admin_required_json():
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user or not user_is_admin(user):
        return None, (jsonify({"error": "forbidden"}), 403)
    return user, None


def user_admin_payload(user_row: dict[str, Any]) -> dict[str, Any]:
    uid = int(user_row["id"])
    stats = db.user_vault_stats(uid)
    watermark = db.get_sync_watermark(uid)
    quota = db.user_storage_quota_bytes(user_row)
    used = int(stats["storage_bytes"])
    flags = user_admin_flags(user_row)
    return {
        "id": uid,
        "email": user_row["email"],
        "auth_method": db.user_auth_method(user_row),
        "totp_enabled": bool(user_row["totp_enabled"]),
        "is_admin": flags["is_admin"],
        "is_admin_db": flags["is_admin_db"],
        "is_admin_env": flags["is_admin_env"],
        "admin_env_locked": flags["admin_env_locked"],
        "storage_used_bytes": used,
        "storage_quota_bytes": quota,
        "storage_quota_effective": db.user_storage_quota_effective(user_row),
        "storage_percent": round((used / quota) * 100, 1) if quota > 0 else None,
        "plan": db.user_plan(user_row),
        "plan_label": normalize_plan(db.user_plan(user_row)).capitalize(),
        "item_count": int(stats["item_count"]),
        "active_items": int(stats["active_items"]),
        "deleted_items": int(stats["deleted_items"]),
        "vault_bytes": int(stats["vault_bytes"]),
        "sync_watermark": float(watermark.get("watermark") or 0),
        "passkey_count": len(db.list_webauthn_credentials(uid)),
        "created_at": float(user_row["created_at"] or 0),
        "updated_at": float(user_row["updated_at"] or 0),
        "password_changed_at": db.user_password_changed_at(user_row),
    }


def register_admin_routes(app, build_id: str) -> None:
    @app.get("/admin")
    def admin_page():
        uid = auth.current_user_id()
        user = db.get_user_by_id(uid) if uid else None
        if not user or not user_is_admin(user):
            return render_template("admin-denied.html", build=build_id), 403
        return render_template("admin.html", build=build_id, email=user["email"])

    @app.get("/privacy")
    def privacy_page():
        return render_template("legal.html", build=build_id, page="privacy")

    @app.get("/terms")
    def terms_page():
        return render_template("legal.html", build=build_id, page="terms")

    @app.get("/self-host")
    def self_host_page():
        from pathlib import Path
        doc = Path(__file__).resolve().parent.parent / "docs" / "SELF_HOST.md"
        body = doc.read_text(encoding="utf-8") if doc.is_file() else "Self-host guide not found."
        return render_template("doc-page.html", build=build_id, title="Self-host guide", body=body)

    @app.get("/api/admin/overview")
    def api_admin_overview():
        _, err = admin_required_json()
        if err:
            return err
        users = [user_admin_payload(row) for row in db.list_users()]
        total_used = sum(int(u["storage_used_bytes"]) for u in users)
        server = server_info_cache.compute_server()
        try:
            page_count = db.connection().execute("PRAGMA page_count").fetchone()[0]
            page_size = db.connection().execute("PRAGMA page_size").fetchone()[0]
            db_bytes = int(page_count) * int(page_size)
        except Exception:
            db_bytes = 0
        disk_free = int(server.get("disk_free_bytes") or 0)
        disk_total = int(server.get("disk_total_bytes") or 0)
        disk_ok = disk_total == 0 or disk_free > disk_total * 0.05
        try:
            db.connection().execute("SELECT 1").fetchone()
            db_ok = True
        except Exception:
            db_ok = False
        return jsonify(
            {
                "ok": True,
                "generated_at": time.time(),
                "user_count": len(users),
                "total_storage_used_bytes": total_used,
                "users": users,
                "csrf": auth.csrf_token(),
                "build": build_id,
                "server": {
                    **server,
                    "db_bytes": db_bytes,
                    "ocr_ephemeral": ocr_ephemeral(),
                },
                "ops": {
                    "health_ok": db_ok and disk_ok,
                    "database_ok": db_ok,
                    "disk_ok": disk_ok,
                    "registration_open": allow_register(),
                    "smtp_configured": bool(SMTP_HOST and SMTP_HOST not in {"localhost", "127.0.0.1"}),
                    "ocr_mode": "client" if not server_ocr_enabled() else "server",
                    "ocr_ephemeral": ocr_ephemeral(),
                    "backup_cron": "deploy/cron/deeperguard-backup",
                },
            }
        )

    @app.patch("/api/admin/users/<int:user_id>")
    def api_admin_update_user(user_id: int):
        admin_user, err = admin_required_json()
        if err:
            return err
        body = request.get_json(silent=True) or {}
        target = db.get_user_by_id(user_id)
        if not target:
            return jsonify({"error": "not found"}), 404
        target_email = str(target["email"] or "")
        if "storage_quota_mb" in body:
            try:
                mb = int(body.get("storage_quota_mb"))
            except (TypeError, ValueError):
                return jsonify({"error": "invalid quota"}), 400
            quota_bytes = quota_bytes_from_mb(mb)
            db.update_user_storage_quota(user_id, quota_bytes)
            log.info(
                "admin quota user=%s target=%s mb=%s by=%s",
                user_id,
                target_email,
                mb,
                admin_user["email"],
            )
        if "plan" in body:
            plan = str(body.get("plan") or "").strip().lower()
            if plan not in {PLAN_BASIC, PLAN_PRO}:
                return jsonify({"error": "invalid plan"}), 400
            db.update_user_plan(user_id, plan)
            log.info(
                "admin plan user=%s target=%s plan=%s by=%s",
                user_id,
                target_email,
                plan,
                admin_user["email"],
            )
        if "is_admin" in body:
            want_admin = bool(body.get("is_admin"))
            if int(target["id"]) == int(admin_user["id"]) and not want_admin:
                return jsonify({"error": "cannot remove your own admin access"}), 400
            if not want_admin and user_is_admin_email(target_email):
                return jsonify({
                    "error": "admin is configured via NOTES_ADMIN_EMAILS and cannot be removed here",
                }), 400
            db.update_user_admin_flag(user_id, want_admin)
            log.info(
                "admin flag user=%s target=%s is_admin=%s by=%s",
                user_id,
                target_email,
                want_admin,
                admin_user["email"],
            )
        target = db.get_user_by_id(user_id)
        return jsonify({"ok": True, "user": user_admin_payload(target)})

    @app.delete("/api/admin/users/<int:user_id>")
    def api_admin_delete_user(user_id: int):
        admin_user, err = admin_required_json()
        if err:
            return err
        if int(user_id) == int(admin_user["id"]):
            return jsonify({"error": "cannot delete your own account"}), 400
        target = db.get_user_by_id(user_id)
        if not target:
            return jsonify({"error": "not found"}), 404
        target_email = str(target["email"] or "")
        if not db.purge_user_data(user_id):
            return jsonify({"error": "delete failed"}), 500
        server_info_cache.drop_user(user_id)
        log.info("admin delete user=%s target=%s by=%s", user_id, target_email, admin_user["email"])
        return jsonify({"ok": True, "deleted": user_id})
