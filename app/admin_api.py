"""Admin dashboard API and access control."""
from __future__ import annotations

import logging
import time
from typing import Any

from flask import jsonify, render_template, request

import auth
import db
from auth_rate_limit import allow as rate_allow
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
from plans import PLAN_BASIC, PLAN_FREE, PLAN_PRO, VALID_PLANS, normalize_plan

log = logging.getLogger("deeperguard.admin")


def admin_required_json():
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user or not user_is_admin(user):
        return None, (jsonify({"error": "forbidden"}), 403)
    return user, None


PCLOUD_RATE_LIMIT = 5
PCLOUD_RATE_WINDOW = 300.0


def _pcloud_rate_ok(action: str, admin_user) -> bool:
    return rate_allow(
        f"admin-pcloud-{action}:{int(admin_user['id'])}",
        limit=PCLOUD_RATE_LIMIT,
        window=PCLOUD_RATE_WINDOW,
    )


def pcloud_service_payload() -> dict[str, Any]:
    """State only: never the token, nor any part of it."""
    import backup_pcloud
    import pcloud_service_token as pst

    st = pst.status()
    env_set = backup_pcloud.service_source() == backup_pcloud.SOURCE_ENV
    return {
        "env_remote": env_set,
        "read_only": env_set,
        "configured": bool(st["configured"]),
        "region": st["region"],
        "set_at": float(st["set_at"] or 0),
        "set_by": st["set_by"],
        "last_test_at": float(st["last_test_at"] or 0),
        "last_test_ok": bool(st["last_test_ok"]),
        "last_test_category": st["last_test_category"],
    }


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


def _site_nav(build_id: str) -> dict[str, str]:
    from config import CONTACT_EMAIL, NOTES_PUBLIC_URL, app_entry_path

    base = NOTES_PUBLIC_URL.rstrip("/")
    return {
        "build": build_id,
        "app_url": f"{base}{app_entry_path()}",
        "register_url": f"{base}/register",
        "login_url": f"{base}/login",
        "contact_email": CONTACT_EMAIL,
    }


def _escape_html(text: str) -> str:
    return (
        str(text or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _inline_md(text: str) -> str:
    """Escape then apply simple links, `code`, and **bold** spans."""
    import re

    out = _escape_html(text)

    def _rel_link(match: re.Match[str]) -> str:
        href = match.group(2)
        if not href.startswith("/"):
            return match.group(0)
        return f'<a href="{href}">{match.group(1)}</a>'

    out = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", _rel_link, out)
    out = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", out)
    out = re.sub(r"`([^`]+)`", r"<code>\1</code>", out)
    return out


def render_simple_markdown(src: str) -> str:
    """Minimal Markdown → HTML for docs/SELF_HOST.md (headings, lists, tables, code)."""
    import re

    lines = str(src or "").splitlines()
    html: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        if line.startswith("# "):
            html.append(f"<h1>{_inline_md(line[2:].strip())}</h1>")
            i += 1
            continue
        if line.startswith("## "):
            html.append(f"<h2>{_inline_md(line[3:].strip())}</h2>")
            i += 1
            continue
        if line.startswith("### "):
            html.append(f"<h3>{_inline_md(line[4:].strip())}</h3>")
            i += 1
            continue
        if line.strip().startswith("|") and i + 1 < len(lines) and re.match(r"^\s*\|?\s*[-:| ]+\|", lines[i + 1] or ""):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(lines[i])
                i += 1
            if len(rows) >= 2:
                def cells(row: str) -> list[str]:
                    parts = [c.strip() for c in row.strip().strip("|").split("|")]
                    return parts
                head = cells(rows[0])
                body_rows = [cells(r) for r in rows[2:]]
                html.append("<table><thead><tr>" + "".join(f"<th>{_inline_md(c)}</th>" for c in head) + "</tr></thead><tbody>")
                for br in body_rows:
                    html.append("<tr>" + "".join(f"<td>{_inline_md(c)}</td>" for c in br) + "</tr>")
                html.append("</tbody></table>")
            continue
        if re.match(r"^\d+\.\s+", line.strip()):
            html.append("<ol>")
            while i < len(lines) and re.match(r"^\d+\.\s+", (lines[i] or "").strip()):
                item = re.sub(r"^\d+\.\s+", "", lines[i].strip())
                html.append(f"<li>{_inline_md(item)}</li>")
                i += 1
            html.append("</ol>")
            continue
        if line.strip().startswith("- "):
            html.append("<ul>")
            while i < len(lines) and lines[i].strip().startswith("- "):
                html.append(f"<li>{_inline_md(lines[i].strip()[2:])}</li>")
                i += 1
            html.append("</ul>")
            continue
        html.append(f"<p>{_inline_md(line.strip())}</p>")
        i += 1
    return "\n".join(html)


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
        return render_template("legal.html", page="privacy", **_site_nav(build_id))

    @app.get("/terms")
    def terms_page():
        return render_template("legal.html", page="terms", **_site_nav(build_id))

    @app.get("/self-host")
    def self_host_page():
        from pathlib import Path
        doc = Path(__file__).resolve().parent.parent / "docs" / "SELF_HOST.md"
        body = doc.read_text(encoding="utf-8") if doc.is_file() else "Self-host guide not found."
        return render_template(
            "doc-page.html",
            title="Self-host guide",
            body_html=render_simple_markdown(body),
            **_site_nav(build_id),
        )

    @app.get("/help/recovery")
    def help_recovery_page():
        from pathlib import Path
        doc = Path(__file__).resolve().parent.parent / "docs" / "HELP_RECOVERY.md"
        body = doc.read_text(encoding="utf-8") if doc.is_file() else "Recovery help not found."
        return render_template(
            "doc-page.html",
            title="Account recovery",
            body_html=render_simple_markdown(body),
            **_site_nav(build_id),
        )

    @app.get("/help")
    def help_index_page():
        body = (
            "# Help\n\n"
            "- [Account recovery](/help/recovery): recovery codes, the vault recovery key and backups.\n"
            "- [Contacts](/help/contacts): add contacts, import them from other programs, duplicates, export and what the server can see.\n"
        )
        return render_template(
            "doc-page.html",
            title="Help",
            body_html=render_simple_markdown(body),
            **_site_nav(build_id),
        )

    @app.get("/help/contacts")
    def help_contacts_page():
        from pathlib import Path
        doc = Path(__file__).resolve().parent.parent / "docs" / "HELP_CONTACTS.md"
        body = doc.read_text(encoding="utf-8") if doc.is_file() else "Contacts help not found."
        return render_template(
            "doc-page.html",
            title="Contacts help",
            body_html=render_simple_markdown(body),
            **_site_nav(build_id),
        )

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
            if plan not in VALID_PLANS:
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

    @app.get("/api/admin/pcloud-service")
    def api_admin_pcloud_service():
        _, err = admin_required_json()
        if err:
            return err
        return jsonify({"ok": True, "pcloud": pcloud_service_payload()})

    def _pcloud_env_locked():
        import backup_pcloud

        if backup_pcloud.service_source() == backup_pcloud.SOURCE_ENV:
            return jsonify({"error": "set via server environment", "pcloud": pcloud_service_payload()}), 409
        return None

    @app.put("/api/admin/pcloud-service")
    def api_admin_pcloud_service_set():
        import pcloud_service_token as pst

        admin_user, err = admin_required_json()
        if err:
            return err
        locked = _pcloud_env_locked()
        if locked:
            return locked
        if not _pcloud_rate_ok("set", admin_user):
            return jsonify({"error": "too many attempts, try again later"}), 429
        body = request.get_json(silent=True)
        body = body if isinstance(body, dict) else {}
        try:
            pst.set_token(body.get("token"), body.get("region"), admin_user["email"])
        except pst.TokenError as exc:
            log.info("admin pcloud-service set rejected by=%s", admin_user["email"])
            return jsonify({"error": str(exc)}), 400
        finally:
            body = None
        log.info("admin pcloud-service set by=%s", admin_user["email"])
        return jsonify({"ok": True, "pcloud": pcloud_service_payload()})

    @app.post("/api/admin/pcloud-service/test")
    def api_admin_pcloud_service_test():
        import backup_pcloud
        import pcloud_service_token as pst

        admin_user, err = admin_required_json()
        if err:
            return err
        locked = _pcloud_env_locked()
        if locked:
            return locked
        if not _pcloud_rate_ok("test", admin_user):
            return jsonify({"error": "too many attempts, try again later"}), 429
        if not pst.status()["configured"]:
            return jsonify({"error": "not configured"}), 400
        result = backup_pcloud.test_connection()
        ok = bool(result.get("ok"))
        category = str(result.get("category") or "")
        pst.record_test(ok, category)
        log.info("admin pcloud-service test ok=%s result=%s by=%s", ok, category, admin_user["email"])
        return jsonify({"ok": True, "test_ok": ok, "pcloud": pcloud_service_payload()})

    @app.delete("/api/admin/pcloud-service")
    def api_admin_pcloud_service_remove():
        import pcloud_service_token as pst

        admin_user, err = admin_required_json()
        if err:
            return err
        locked = _pcloud_env_locked()
        if locked:
            return locked
        pst.remove()
        log.info("admin pcloud-service remove by=%s", admin_user["email"])
        return jsonify({"ok": True, "pcloud": pcloud_service_payload()})
