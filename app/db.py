"""SQLite persistence for accounts and encrypted sync items."""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from config import DATA_DIR

_lock = threading.Lock()
_local = threading.local()


def connection() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = _connect()
        _local.conn = conn
        with _lock:
            init_schema(conn)
    return conn


def reset_connection() -> None:
    """Close the thread-local connection (used by tests and after DATA_DIR moves)."""
    conn = getattr(_local, "conn", None)
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass
    _local.conn = None


def db_path() -> Path:
    return DATA_DIR / "notes.db"


def _connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path()), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA cache_size=-8000")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA auto_vacuum=INCREMENTAL")
    return conn


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    conn = connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def init_schema(conn: sqlite3.Connection | None = None) -> None:
    conn = conn or connection()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            kdf_salt TEXT NOT NULL,
            totp_secret TEXT NOT NULL DEFAULT '',
            totp_enabled INTEGER NOT NULL DEFAULT 0,
            backup_email TEXT NOT NULL DEFAULT '',
            backup_enabled INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            item_uuid TEXT NOT NULL,
            content_version INTEGER NOT NULL DEFAULT 1,
            ciphertext TEXT NOT NULL,
            content_hash TEXT NOT NULL DEFAULT '',
            deleted INTEGER NOT NULL DEFAULT 0,
            updated_at REAL NOT NULL,
            UNIQUE(user_id, item_uuid),
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_items_user_updated
            ON items(user_id, updated_at);

        CREATE INDEX IF NOT EXISTS idx_items_user_deleted_updated
            ON items(user_id, deleted, updated_at);

        CREATE TABLE IF NOT EXISTS backup_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            sent_at REAL NOT NULL,
            recipient TEXT NOT NULL,
            item_count INTEGER NOT NULL,
            bytes_size INTEGER NOT NULL,
            status TEXT NOT NULL,
            detail TEXT NOT NULL DEFAULT '',
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS note_reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            item_uuid TEXT NOT NULL,
            warn_at REAL NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            sent_at REAL NOT NULL DEFAULT 0,
            sending_at REAL NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            UNIQUE(user_id, item_uuid),
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_note_reminders_due
            ON note_reminders(sent_at, sending_at, warn_at);

        CREATE TABLE IF NOT EXISTS reminder_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            item_uuid TEXT NOT NULL,
            recipient TEXT NOT NULL,
            status TEXT NOT NULL,
            detail TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        """
    )
    cols = {row[1] for row in conn.execute("PRAGMA table_info(users)").fetchall()}
    if "kdf_iterations" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN kdf_iterations INTEGER NOT NULL DEFAULT 10000")
    if "password_changed_at" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN password_changed_at REAL NOT NULL DEFAULT 0")
    if "pcloud_enabled" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN pcloud_enabled INTEGER NOT NULL DEFAULT 0")
    if "pcloud_username" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN pcloud_username TEXT NOT NULL DEFAULT ''")
    if "pcloud_remote_path" not in cols:
        conn.execute(
            "ALTER TABLE users ADD COLUMN pcloud_remote_path TEXT NOT NULL DEFAULT 'Deeperguard/backups'"
        )
    if "pcloud_region" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN pcloud_region TEXT NOT NULL DEFAULT 'eu'")
    if "pcloud_last_sync_at" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN pcloud_last_sync_at REAL NOT NULL DEFAULT 0")
    if "pcloud_last_sync_status" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN pcloud_last_sync_status TEXT NOT NULL DEFAULT ''")
    if "pcloud_last_sync_detail" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN pcloud_last_sync_detail TEXT NOT NULL DEFAULT ''")
    if "vault_kdf_version" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN vault_kdf_version INTEGER NOT NULL DEFAULT 1")
    if "auth_method" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'argon2'")
    if "srp_salt" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN srp_salt TEXT NOT NULL DEFAULT ''")
    if "srp_verifier" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN srp_verifier TEXT NOT NULL DEFAULT ''")
    if "srp_kdf_version" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN srp_kdf_version INTEGER NOT NULL DEFAULT 1")
    if "totp_last_step" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0")
    if "storage_quota_bytes" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN storage_quota_bytes INTEGER NOT NULL DEFAULT 0")
    if "is_admin" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")
    if "email_verified" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1")
    if "email_verify_hash" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN email_verify_hash TEXT NOT NULL DEFAULT ''")
    if "email_verify_expires" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN email_verify_expires REAL NOT NULL DEFAULT 0")
    if "email_verify_attempts" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN email_verify_attempts INTEGER NOT NULL DEFAULT 0")
    if "backup_email_verified" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN backup_email_verified INTEGER NOT NULL DEFAULT 1")
    if "backup_verify_hash" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN backup_verify_hash TEXT NOT NULL DEFAULT ''")
    if "backup_verify_expires" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN backup_verify_expires REAL NOT NULL DEFAULT 0")
    if "backup_verify_attempts" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN backup_verify_attempts INTEGER NOT NULL DEFAULT 0")
    if "password_login_disabled" not in cols:
        conn.execute(
            "ALTER TABLE users ADD COLUMN password_login_disabled INTEGER NOT NULL DEFAULT 0"
        )
    if "plan" not in cols:
        from plans import PLAN_PRO, plan_storage_quota_bytes

        conn.execute(f"ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT '{PLAN_PRO}'")
        pro_quota = plan_storage_quota_bytes(PLAN_PRO)
        conn.execute("UPDATE users SET plan = ?", (PLAN_PRO,))
        conn.execute(
            """
            UPDATE users
            SET storage_quota_bytes = ?
            WHERE plan = ? AND (storage_quota_bytes = 0 OR storage_quota_bytes < ?)
            """,
            (pro_quota, PLAN_PRO, pro_quota),
        )
    if os.environ.get("NOTES_APPLY_DEFAULT_QUOTA_TO_EXISTING", "0") == "1":
        from config import default_user_quota_bytes

        default = default_user_quota_bytes()
        conn.execute(
            "UPDATE users SET storage_quota_bytes = ? WHERE storage_quota_bytes = 0",
            (default,),
        )
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS webauthn_credentials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            credential_id TEXT NOT NULL UNIQUE,
            public_key TEXT NOT NULL,
            sign_count INTEGER NOT NULL DEFAULT 0,
            transports TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS user_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            device_id TEXT NOT NULL DEFAULT '',
            device_label TEXT NOT NULL DEFAULT '',
            user_agent TEXT NOT NULL DEFAULT '',
            ip TEXT NOT NULL DEFAULT '',
            ip_location TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL,
            last_seen_at REAL NOT NULL,
            last_login_at REAL NOT NULL,
            revoked_at REAL NOT NULL DEFAULT 0,
            revoke_reason TEXT NOT NULL DEFAULT '',
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_user_sessions_user
            ON user_sessions(user_id, revoked_at, last_login_at);
        """
    )
    session_cols = {row[1] for row in conn.execute("PRAGMA table_info(user_sessions)").fetchall()}
    if session_cols and "device_id" not in session_cols:
        conn.execute("ALTER TABLE user_sessions ADD COLUMN device_id TEXT NOT NULL DEFAULT ''")
    if session_cols and "revoke_reason" not in session_cols:
        conn.execute("ALTER TABLE user_sessions ADD COLUMN revoke_reason TEXT NOT NULL DEFAULT ''")
    session_cols = {row[1] for row in conn.execute("PRAGMA table_info(user_sessions)").fetchall()}
    if session_cols and "trusted_at" not in session_cols:
        conn.execute(
            "ALTER TABLE user_sessions ADD COLUMN trusted_at REAL NOT NULL DEFAULT 0"
        )
        ts_backfill = now()
        conn.execute(
            """
            UPDATE user_sessions
            SET trusted_at = COALESCE(NULLIF(last_login_at, 0), NULLIF(created_at, 0), ?)
            WHERE trusted_at = 0
            """,
            (ts_backfill,),
        )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_user_sessions_device ON user_sessions(user_id, device_id, revoked_at)"
    )
    item_cols = {row[1] for row in conn.execute("PRAGMA table_info(items)").fetchall()}
    if "blob_ciphertext" not in item_cols:
        conn.execute("ALTER TABLE items ADD COLUMN blob_ciphertext TEXT NOT NULL DEFAULT ''")
    if "synced_at" not in item_cols:
        # Server receive time. Clients page/filter on this instead of the
        # client-supplied updated_at, so an item pushed late (offline edit, clock
        # skew, debounce race) can no longer land "behind" another device's cursor.
        conn.execute("ALTER TABLE items ADD COLUMN synced_at REAL NOT NULL DEFAULT 0")
        conn.execute("UPDATE items SET synced_at = updated_at WHERE synced_at = 0")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_items_user_synced ON items(user_id, synced_at, item_uuid)"
    )
    if "rev" not in item_cols:
        # Server-assigned per-item revision, bumped on every accepted write.
        # Clients that send base_rev get a "conflict" instead of silently losing
        # to a client clock; clients that do not send it keep the old
        # updated_at ordering. Existing rows start at revision 1.
        conn.execute("ALTER TABLE items ADD COLUMN rev INTEGER NOT NULL DEFAULT 0")
        conn.execute("UPDATE items SET rev = 1 WHERE rev = 0")
    reminder_cols = {row[1] for row in conn.execute("PRAGMA table_info(note_reminders)").fetchall()}
    if reminder_cols and "sending_at" not in reminder_cols:
        conn.execute("ALTER TABLE note_reminders ADD COLUMN sending_at REAL NOT NULL DEFAULT 0")
    if reminder_cols:
        # Titles were briefly stored in plaintext; zero-knowledge means none may remain.
        conn.execute("UPDATE note_reminders SET title = '' WHERE title != ''")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS srp_challenges (
            id TEXT PRIMARY KEY,
            purpose TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            email TEXT NOT NULL COLLATE NOCASE,
            state_json TEXT NOT NULL,
            srp_salt TEXT NOT NULL DEFAULT '',
            srp_verifier TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL,
            expires_at REAL NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_srp_challenges_expires
            ON srp_challenges(expires_at);

        CREATE TABLE IF NOT EXISTS email_send_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            recipient TEXT NOT NULL COLLATE NOCASE,
            kind TEXT NOT NULL,
            sent_at REAL NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_email_send_log_user_kind_sent
            ON email_send_log(user_id, kind, sent_at);
        CREATE INDEX IF NOT EXISTS idx_email_send_log_recipient_kind_sent
            ON email_send_log(recipient, kind, sent_at);
        CREATE INDEX IF NOT EXISTS idx_email_send_log_user_recipient_kind_sent
            ON email_send_log(user_id, recipient, kind, sent_at);

        -- D2 Secure Send: ciphertext on disk; row is metadata + tombstone after burn.
        CREATE TABLE IF NOT EXISTS secure_sends (
            id TEXT PRIMARY KEY,
            sender_user_id INTEGER NOT NULL,
            has_passphrase INTEGER NOT NULL DEFAULT 0,
            has_file INTEGER NOT NULL DEFAULT 0,
            byte_size INTEGER NOT NULL DEFAULT 0,
            max_views INTEGER NOT NULL DEFAULT 1,
            views_used INTEGER NOT NULL DEFAULT 0,
            expires_at REAL NOT NULL,
            created_at REAL NOT NULL,
            canceled_at REAL,
            last_opened_at REAL,
            open_verifier TEXT NOT NULL DEFAULT '',
            verify_failures INTEGER NOT NULL DEFAULT 0,
            locked_out_at REAL,
            FOREIGN KEY(sender_user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_secure_sends_sender
            ON secure_sends(sender_user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_secure_sends_expires
            ON secure_sends(expires_at);

        CREATE TABLE IF NOT EXISTS signin_alert_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            device_key TEXT NOT NULL,
            sent_at REAL NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_signin_alert_user_device_sent
            ON signin_alert_log(user_id, device_key, sent_at);

        CREATE TABLE IF NOT EXISTS account_recovery_batches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            created_at REAL NOT NULL,
            activates_at REAL NOT NULL,
            cancelled_at REAL NOT NULL DEFAULT 0,
            wait_seconds INTEGER NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_recovery_batches_user_created
            ON account_recovery_batches(user_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS account_recovery_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            batch_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            code_hash TEXT NOT NULL,
            used_at REAL NOT NULL DEFAULT 0,
            FOREIGN KEY(batch_id) REFERENCES account_recovery_batches(id) ON DELETE CASCADE,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_recovery_codes_batch_hash
            ON account_recovery_codes(batch_id, code_hash);
        """
    )
    send_cols = {row[1] for row in conn.execute("PRAGMA table_info(secure_sends)").fetchall()}
    if send_cols and "open_verifier" not in send_cols:
        conn.execute(
            "ALTER TABLE secure_sends ADD COLUMN open_verifier TEXT NOT NULL DEFAULT ''"
        )
    if send_cols and "verify_failures" not in send_cols:
        conn.execute(
            "ALTER TABLE secure_sends ADD COLUMN verify_failures INTEGER NOT NULL DEFAULT 0"
        )
    if send_cols and "locked_out_at" not in send_cols:
        conn.execute("ALTER TABLE secure_sends ADD COLUMN locked_out_at REAL")
    conn.commit()


def now() -> float:
    return time.time()


def create_user(email: str, password_hash: str, kdf_salt: str, kdf_iterations: int = 10000) -> int:
    ts = now()
    with tx() as conn:
        cur = conn.execute(
            """
            INSERT INTO users (
                email, password_hash, kdf_salt, kdf_iterations, vault_kdf_version,
                auth_method, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, 2, 'argon2', ?, ?)
            """,
            (email.strip().lower(), password_hash, kdf_salt, int(kdf_iterations), ts, ts),
        )
        user_id = int(cur.lastrowid)
    _ensure_upload_dir(user_id)
    return user_id


def create_user_srp(
    email: str,
    kdf_salt: str,
    srp_salt: str,
    srp_verifier: str,
    kdf_iterations: int = 10000,
    *,
    srp_kdf_version: int = 2,
    storage_quota_bytes: int | None = None,
    is_admin: bool = False,
    plan: str | None = None,
) -> int:
    from config import unverified_user_quota_bytes
    from plans import default_plan, normalize_plan, plan_storage_quota_bytes

    ts = now()
    user_plan = normalize_plan(plan or default_plan())
    # Unverified accounts get a tiny quota until email confirmation (M4).
    full_quota = int(
        storage_quota_bytes
        if storage_quota_bytes is not None
        else plan_storage_quota_bytes(user_plan)
    )
    quota = int(unverified_user_quota_bytes()) if storage_quota_bytes is None else full_quota
    # Do not stamp is_admin from NOTES_ADMIN_EMAILS at signup — L10 requires a
    # verified email, and config.user_is_admin checks the env list at runtime.
    admin_flag = 1 if is_admin else 0
    kdf_ver = 2 if int(srp_kdf_version or 1) >= 2 else 1
    with tx() as conn:
        cur = conn.execute(
            """
            INSERT INTO users (
                email, password_hash, kdf_salt, kdf_iterations, vault_kdf_version,
                auth_method, srp_salt, srp_verifier, srp_kdf_version, storage_quota_bytes, is_admin, plan,
                email_verified, pcloud_remote_path, created_at, updated_at
            )
            VALUES (?, '', ?, ?, 2, 'srp', ?, ?, ?, ?, ?, ?, 0, '', ?, ?)
            """,
            (
                email.strip().lower(),
                kdf_salt,
                int(kdf_iterations),
                srp_salt.strip().lower(),
                srp_verifier.strip().lower(),
                kdf_ver,
                quota,
                admin_flag,
                user_plan,
                ts,
                ts,
            ),
        )
        user_id = int(cur.lastrowid)
    _ensure_upload_dir(user_id)
    return user_id


def _ensure_upload_dir(user_id: int) -> None:
    try:
        from uploads import ensure_user_upload_dir

        ensure_user_upload_dir(int(user_id))
    except OSError:
        pass


def user_auth_method(user) -> str:
    try:
        method = str(user["auth_method"] or "argon2").strip().lower()
    except (KeyError, TypeError, ValueError):
        return "argon2"
    return "srp" if method == "srp" else "argon2"


def user_has_srp(user) -> bool:
    try:
        return bool(str(user["srp_verifier"] or "").strip())
    except (KeyError, TypeError, ValueError):
        return False


def user_has_legacy_password(user) -> bool:
    try:
        return bool(str(user["password_hash"] or "").strip())
    except (KeyError, TypeError, ValueError):
        return False


def upgrade_user_to_srp(
    user_id: int,
    srp_salt: str,
    srp_verifier: str,
    *,
    srp_kdf_version: int = 2,
) -> None:
    ts = now()
    kdf_ver = 2 if int(srp_kdf_version or 1) >= 2 else 1
    with tx() as conn:
        conn.execute(
            """
            UPDATE users
            SET auth_method = 'srp', srp_salt = ?, srp_verifier = ?, srp_kdf_version = ?,
                updated_at = ?
            WHERE id = ?
            """,
            (srp_salt.strip().lower(), srp_verifier.strip().lower(), kdf_ver, ts, user_id),
        )


def update_user_srp_verifier(
    user_id: int,
    srp_salt: str,
    srp_verifier: str,
    *,
    srp_kdf_version: int | None = None,
    touch_password_changed: bool = True,
) -> float:
    """Update the stored SRP verifier.

    touch_password_changed=False is for silent verifier-format upgrades (e.g. SRP
    KDF v1→v2). Those must not bump password_changed_at — the client treats that
    timestamp as a vault-password rotation and clears the post-login boot password.

    When srp_kdf_version is omitted, persist v2. Leaving the column unchanged while
    installing a v2 verifier permanently locks the account out (H2).
    """
    ts = now()
    # Default to v2 so callers that rotate verifiers cannot leave a stale v1 flag.
    kdf_ver = 2 if int(srp_kdf_version if srp_kdf_version is not None else 2) >= 2 else 1
    with tx() as conn:
        if touch_password_changed:
            conn.execute(
                """
                UPDATE users
                SET auth_method = 'srp', srp_salt = ?, srp_verifier = ?, srp_kdf_version = ?,
                    updated_at = ?, password_changed_at = ?
                WHERE id = ?
                """,
                (
                    srp_salt.strip().lower(),
                    srp_verifier.strip().lower(),
                    kdf_ver,
                    ts,
                    ts,
                    user_id,
                ),
            )
        else:
            conn.execute(
                """
                UPDATE users
                SET auth_method = 'srp', srp_salt = ?, srp_verifier = ?, srp_kdf_version = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    srp_salt.strip().lower(),
                    srp_verifier.strip().lower(),
                    kdf_ver,
                    ts,
                    user_id,
                ),
            )
    return ts


def count_srp_kdf_v1_users() -> int:
    """Count accounts still advertising SRP KDF v1 (candidates / residual)."""
    row = connection().execute(
        """
        SELECT COUNT(*) AS n FROM users
        WHERE COALESCE(srp_kdf_version, 1) < 2
          AND srp_salt IS NOT NULL AND TRIM(srp_salt) != ''
          AND srp_verifier IS NOT NULL AND TRIM(srp_verifier) != ''
        """
    ).fetchone()
    try:
        return int(row["n"] if row else 0)
    except (KeyError, TypeError, ValueError):
        return int(row[0]) if row else 0


def repair_srp_kdf_v1_lockouts(*, apply: bool = False) -> int:
    """One-time repair helper for H2-style lockouts.

    Vault-recovery previously installed v2 verifiers while leaving srp_kdf_version=1.
    Those rows cannot complete SRP login. Safe heuristic: accounts whose
    password_changed_at is set (recovery/password rotation) while still on v1 —
    new clients always rotate with Argon2id v2. Legitimate never-rotated v1
    accounts keep password_changed_at NULL and are left alone.

    Returns the number of matching rows (and updates them when apply=True).
    Reports counts only — never emails or secrets.
    """
    where = """
        COALESCE(srp_kdf_version, 1) < 2
        AND srp_salt IS NOT NULL AND TRIM(srp_salt) != ''
        AND srp_verifier IS NOT NULL AND TRIM(srp_verifier) != ''
        AND password_changed_at IS NOT NULL
        AND CAST(password_changed_at AS REAL) > 0
    """
    row = connection().execute(f"SELECT COUNT(*) AS n FROM users WHERE {where}").fetchone()
    try:
        count = int(row["n"] if row else 0)
    except (KeyError, TypeError, ValueError):
        count = int(row[0]) if row else 0
    if apply and count:
        ts = now()
        with tx() as conn:
            conn.execute(
                f"""
                UPDATE users
                SET srp_kdf_version = 2, updated_at = ?
                WHERE {where}
                """,
                (ts,),
            )
    return count


def user_srp_kdf_version(user) -> int:
    try:
        value = int(user["srp_kdf_version"])
    except (KeyError, TypeError, ValueError):
        return 1
    return 2 if value >= 2 else 1


def revoke_other_user_sessions(user_id: int, keep_token: str = "", *, reason: str = "security") -> int:
    """Revoke all sessions for user except the current cookie token (if given)."""
    reason = str(reason or "security")[:32]
    keep_hash = _session_token_hash(keep_token) if keep_token else ""
    with tx() as conn:
        if keep_hash:
            cur = conn.execute(
                """
                UPDATE user_sessions
                SET revoked_at = ?, revoke_reason = ?
                WHERE user_id = ? AND revoked_at = 0 AND token_hash != ?
                """,
                (now(), reason, int(user_id), keep_hash),
            )
        else:
            cur = conn.execute(
                """
                UPDATE user_sessions
                SET revoked_at = ?, revoke_reason = ?
                WHERE user_id = ? AND revoked_at = 0
                """,
                (now(), reason, int(user_id)),
            )
        return int(cur.rowcount or 0)


def user_totp_last_step(user) -> int:
    try:
        return int(user["totp_last_step"] or 0)
    except (KeyError, TypeError, ValueError):
        return 0


def set_user_totp_last_step(user_id: int, step: int) -> None:
    with tx() as conn:
        conn.execute(
            "UPDATE users SET totp_last_step = ?, updated_at = ? WHERE id = ?",
            (int(step), now(), int(user_id)),
        )


def clear_user_legacy_password(user_id: int) -> None:
    """Remove server-side Argon2 hash so SRP-only accounts cannot use legacy/resync paths."""
    with tx() as conn:
        conn.execute(
            "UPDATE users SET password_hash = '', updated_at = ? WHERE id = ?",
            (now(), user_id),
        )


def list_webauthn_credentials(user_id: int) -> list[sqlite3.Row]:
    return list(
        connection().execute(
            """
            SELECT * FROM webauthn_credentials
            WHERE user_id = ?
            ORDER BY created_at ASC
            """,
            (user_id,),
        ).fetchall()
    )


def get_webauthn_credential(credential_id: str) -> sqlite3.Row | None:
    return connection().execute(
        "SELECT * FROM webauthn_credentials WHERE credential_id = ?",
        (credential_id,),
    ).fetchone()


def add_webauthn_credential(
    user_id: int,
    credential_id: str,
    public_key: str,
    sign_count: int = 0,
    transports: str = "",
) -> int:
    ts = now()
    with tx() as conn:
        cur = conn.execute(
            """
            INSERT INTO webauthn_credentials (
                user_id, credential_id, public_key, sign_count, transports, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (user_id, credential_id, public_key, int(sign_count), transports, ts),
        )
        return int(cur.lastrowid)


def update_webauthn_sign_count(credential_id: str, sign_count: int) -> None:
    with tx() as conn:
        conn.execute(
            "UPDATE webauthn_credentials SET sign_count = ? WHERE credential_id = ?",
            (int(sign_count), credential_id),
        )


def delete_webauthn_credential(user_id: int, credential_id: str) -> bool:
    with tx() as conn:
        cur = conn.execute(
            """
            DELETE FROM webauthn_credentials
            WHERE user_id = ? AND credential_id = ?
            """,
            (user_id, credential_id),
        )
        return int(cur.rowcount or 0) > 0


def user_password_login_disabled_by_id(user_id: int) -> bool:
    row = connection().execute(
        "SELECT password_login_disabled FROM users WHERE id = ?",
        (int(user_id),),
    ).fetchone()
    if not row:
        return False
    return int(row["password_login_disabled"] or 0) == 1


def set_password_login_disabled(user_id: int, disabled: bool) -> None:
    with tx() as conn:
        conn.execute(
            "UPDATE users SET password_login_disabled = ?, updated_at = ? WHERE id = ?",
            (1 if disabled else 0, now(), int(user_id)),
        )


def get_latest_recovery_batch(user_id: int) -> sqlite3.Row | None:
    return connection().execute(
        """
        SELECT * FROM account_recovery_batches
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (int(user_id),),
    ).fetchone()


def cancel_all_recovery_batches(user_id: int, *, cancelled_at: float) -> None:
    with tx() as conn:
        conn.execute(
            """
            UPDATE account_recovery_batches
            SET cancelled_at = ?
            WHERE user_id = ? AND cancelled_at = 0
            """,
            (float(cancelled_at), int(user_id)),
        )


def create_recovery_batch(
    user_id: int,
    created_at: float,
    activates_at: float,
    wait_seconds: int,
) -> int:
    with tx() as conn:
        cur = conn.execute(
            """
            INSERT INTO account_recovery_batches (
                user_id, created_at, activates_at, cancelled_at, wait_seconds
            )
            VALUES (?, ?, ?, 0, ?)
            """,
            (int(user_id), float(created_at), float(activates_at), int(wait_seconds)),
        )
        return int(cur.lastrowid)


def cancel_recovery_batch(batch_id: int, cancelled_at: float) -> None:
    with tx() as conn:
        conn.execute(
            """
            UPDATE account_recovery_batches
            SET cancelled_at = ?
            WHERE id = ? AND cancelled_at = 0
            """,
            (float(cancelled_at), int(batch_id)),
        )


def insert_recovery_code_hashes(user_id: int, batch_id: int, hashes: list[str]) -> None:
    with tx() as conn:
        for digest in hashes:
            conn.execute(
                """
                INSERT INTO account_recovery_codes (batch_id, user_id, code_hash, used_at)
                VALUES (?, ?, ?, 0)
                """,
                (int(batch_id), int(user_id), str(digest)),
            )


def consume_recovery_code(batch_id: int, user_id: int, code_hash: str, *, used_at: float) -> bool:
    with tx() as conn:
        cur = conn.execute(
            """
            UPDATE account_recovery_codes
            SET used_at = ?
            WHERE batch_id = ? AND user_id = ? AND code_hash = ? AND used_at = 0
            """,
            (float(used_at), int(batch_id), int(user_id), str(code_hash)),
        )
        return int(cur.rowcount or 0) > 0


def user_vault_kdf_version(user) -> int:
    try:
        value = int(user["vault_kdf_version"])
    except (KeyError, TypeError, ValueError):
        return 1
    return 2 if value >= 2 else 1


def update_user_vault_kdf_version(user_id: int, version: int) -> None:
    if version not in (1, 2):
        raise ValueError("invalid vault_kdf_version")
    ts = now()
    with tx() as conn:
        conn.execute(
            "UPDATE users SET vault_kdf_version = ?, updated_at = ? WHERE id = ?",
            (int(version), ts, user_id),
        )


def user_kdf_iterations(user) -> int:
    try:
        value = int(user["kdf_iterations"])
    except (KeyError, TypeError, ValueError):
        return 10000
    return value if value >= 1000 else 10000


def get_user_by_email(email: str) -> sqlite3.Row | None:
    row = connection().execute(
        "SELECT * FROM users WHERE email = ? COLLATE NOCASE",
        (email.strip().lower(),),
    ).fetchone()
    return row


def get_user_by_id(user_id: int) -> sqlite3.Row | None:
    return connection().execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def _session_token_hash(token: str) -> str:
    return hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()


_DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9._-]{8,80}$")


def normalize_device_id(raw: str) -> str:
    value = str(raw or "").strip()
    return value if _DEVICE_ID_RE.match(value) else ""


def find_reusable_session(
    user_id: int,
    *,
    device_id: str = "",
    ip: str = "",
    device_label: str = "",
) -> sqlite3.Row | None:
    uid = int(user_id)
    device_id = normalize_device_id(device_id)
    ip = str(ip or "")[:80]
    device_label = str(device_label or "")[:80]
    if device_id:
        row = connection().execute(
            """
            SELECT * FROM user_sessions
            WHERE user_id = ? AND revoked_at = 0 AND device_id = ?
            ORDER BY last_seen_at DESC, id DESC
            LIMIT 1
            """,
            (uid, device_id),
        ).fetchone()
        if row:
            return row
    if ip and device_label:
        return connection().execute(
            """
            SELECT * FROM user_sessions
            WHERE user_id = ? AND revoked_at = 0 AND ip = ? AND device_label = ?
              AND (device_id = '' OR device_id = ?)
            ORDER BY last_seen_at DESC, id DESC
            LIMIT 1
            """,
            (uid, ip, device_label, device_id),
        ).fetchone()
    return None


def revoke_duplicate_sessions(
    user_id: int,
    keep_id: int,
    *,
    device_id: str = "",
    ip: str = "",
    device_label: str = "",
) -> None:
    """Revoke true duplicates only.

    - Same non-empty device_id → revoke the other live rows.
    - Keep row has empty device_id → revoke other empty-device_id rows with the
      same (ip, device_label).
    Never revoke a row because it shares (ip, label) with a different/real
    device_id (shared Cloudflare/NAT IPs used to kill fresh Incognito logins).
    """
    uid = int(user_id)
    keep_id = int(keep_id)
    device_id = normalize_device_id(device_id)
    ts = now()
    with tx() as conn:
        if device_id:
            conn.execute(
                """
                UPDATE user_sessions
                SET revoked_at = ?, revoke_reason = 'duplicate'
                WHERE user_id = ? AND id != ? AND revoked_at = 0 AND device_id = ?
                """,
                (ts, uid, keep_id, device_id),
            )
            return
        if ip and device_label:
            conn.execute(
                """
                UPDATE user_sessions
                SET revoked_at = ?, revoke_reason = 'duplicate'
                WHERE user_id = ? AND id != ? AND revoked_at = 0
                  AND ip = ? AND device_label = ? AND device_id = ''
                """,
                (ts, uid, keep_id, str(ip)[:80], str(device_label)[:80]),
            )


def create_user_session(
    user_id: int,
    *,
    device_label: str = "",
    user_agent: str = "",
    ip: str = "",
    ip_location: str = "",
    device_id: str = "",
    token: str | None = None,
    login: bool = True,
) -> str:
    raw = token or secrets.token_urlsafe(32)
    ts = now()
    uid = int(user_id)
    device_id = normalize_device_id(device_id)
    device_label = str(device_label or "")[:80]
    user_agent = str(user_agent or "")[:300]
    ip = str(ip or "")[:80]
    ip_location = str(ip_location or "")[:120]
    existing = find_reusable_session(
        uid, device_id=device_id, ip=ip, device_label=device_label
    )
    with tx() as conn:
        if existing:
            login_at = ts if login else float(existing["last_login_at"] or ts)
            conn.execute(
                """
                UPDATE user_sessions
                SET token_hash = ?, device_id = CASE WHEN ? = '' THEN device_id ELSE ? END,
                    device_label = ?, user_agent = ?, ip = ?, ip_location = ?,
                    last_seen_at = ?, last_login_at = ?
                WHERE id = ?
                """,
                (
                    _session_token_hash(raw),
                    device_id,
                    device_id,
                    device_label or str(existing["device_label"] or ""),
                    user_agent or str(existing["user_agent"] or ""),
                    ip or str(existing["ip"] or ""),
                    ip_location or str(existing["ip_location"] or ""),
                    ts,
                    login_at,
                    int(existing["id"]),
                ),
            )
            keep_id = int(existing["id"])
        else:
            has_other = conn.execute(
                """
                SELECT 1 FROM user_sessions
                WHERE user_id = ? AND revoked_at = 0
                LIMIT 1
                """,
                (uid,),
            ).fetchone()
            # First device on the account is trusted immediately; later sign-ins
            # stay pending until the user approves them in Settings (no login gate).
            trusted_at = ts if not has_other else 0.0
            conn.execute(
                """
                INSERT INTO user_sessions (
                    user_id, token_hash, device_id, device_label, user_agent, ip, ip_location,
                    created_at, last_seen_at, last_login_at, revoked_at, trusted_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
                """,
                (
                    uid,
                    _session_token_hash(raw),
                    device_id,
                    device_label,
                    user_agent,
                    ip,
                    ip_location,
                    ts,
                    ts,
                    ts,
                    trusted_at,
                ),
            )
            keep_id = int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])
    revoke_duplicate_sessions(
        uid, keep_id, device_id=device_id, ip=ip, device_label=device_label
    )
    return raw


def get_session_by_token(token: str) -> sqlite3.Row | None:
    if not token:
        return None
    return connection().execute(
        "SELECT * FROM user_sessions WHERE token_hash = ?",
        (_session_token_hash(token),),
    ).fetchone()


def get_latest_session_for_device(device_id: str, user_id: int | None = None) -> sqlite3.Row | None:
    """Newest session row for a device id; scoped to one account when known
    (device ids are client-supplied and shared by every account on a browser)."""
    device_id = normalize_device_id(device_id)
    if not device_id:
        return None
    if user_id is not None:
        return connection().execute(
            """
            SELECT * FROM user_sessions
            WHERE device_id = ? AND user_id = ?
            ORDER BY id DESC
            LIMIT 1
            """,
            (device_id, int(user_id)),
        ).fetchone()
    return connection().execute(
        """
        SELECT * FROM user_sessions
        WHERE device_id = ?
        ORDER BY id DESC
        LIMIT 1
        """,
        (device_id,),
    ).fetchone()


def get_user_session(session_id: int, user_id: int) -> sqlite3.Row | None:
    return connection().execute(
        "SELECT * FROM user_sessions WHERE id = ? AND user_id = ?",
        (int(session_id), int(user_id)),
    ).fetchone()


def list_user_sessions(user_id: int, *, active_since: float = 0.0) -> list[sqlite3.Row]:
    return connection().execute(
        """
        SELECT * FROM user_sessions
        WHERE user_id = ? AND revoked_at = 0 AND last_seen_at >= ?
        ORDER BY last_login_at DESC, id DESC
        """,
        (int(user_id), float(active_since)),
    ).fetchall()


def get_active_session_for_device(user_id: int, device_id: str) -> sqlite3.Row | None:
    device_id = normalize_device_id(device_id)
    if not device_id:
        return None
    return connection().execute(
        """
        SELECT * FROM user_sessions
        WHERE user_id = ? AND device_id = ? AND revoked_at = 0
        ORDER BY last_seen_at DESC, id DESC
        LIMIT 1
        """,
        (int(user_id), device_id),
    ).fetchone()


def rotate_session_token(session_id: int, user_id: int) -> str:
    """Issue a new secret for an existing row. The previous cookie stops matching."""
    raw = secrets.token_urlsafe(32)
    with tx() as conn:
        cur = conn.execute(
            """
            UPDATE user_sessions
            SET token_hash = ?, last_seen_at = ?
            WHERE id = ? AND user_id = ? AND revoked_at = 0
            """,
            (_session_token_hash(raw), now(), int(session_id), int(user_id)),
        )
        if int(cur.rowcount or 0) < 1:
            return ""
    return raw


def touch_user_session(
    session_id: int,
    *,
    ip: str = "",
    ip_location: str = "",
    user_agent: str = "",
    device_label: str = "",
) -> None:
    sets = ["last_seen_at = ?"]
    params: list[Any] = [now()]
    if ip:
        sets.append("ip = ?")
        params.append(str(ip)[:80])
        sets.append("ip_location = ?")
        params.append(str(ip_location or "")[:120])
    if user_agent:
        sets.append("user_agent = ?")
        params.append(str(user_agent)[:300])
    if device_label:
        sets.append("device_label = ?")
        params.append(str(device_label)[:80])
    params.append(int(session_id))
    with tx() as conn:
        conn.execute(
            f"UPDATE user_sessions SET {', '.join(sets)} WHERE id = ? AND revoked_at = 0",
            params,
        )


def session_is_trusted(row) -> bool:
    try:
        return float(row["trusted_at"] or 0) > 0
    except (KeyError, TypeError, ValueError):
        return True


def approve_user_session(session_id: int, user_id: int) -> bool:
    """Mark a live session as trusted (in-app new-device approval)."""
    ts = now()
    with tx() as conn:
        cur = conn.execute(
            """
            UPDATE user_sessions
            SET trusted_at = ?
            WHERE id = ? AND user_id = ? AND revoked_at = 0 AND trusted_at = 0
            """,
            (ts, int(session_id), int(user_id)),
        )
        return int(cur.rowcount or 0) > 0


def revoke_user_session(session_id: int, user_id: int, *, reason: str = "user") -> bool:
    reason = str(reason or "user")[:32]
    with tx() as conn:
        cur = conn.execute(
            """
            UPDATE user_sessions
            SET revoked_at = ?, revoke_reason = ?
            WHERE id = ? AND user_id = ? AND revoked_at = 0
            """,
            (now(), reason, int(session_id), int(user_id)),
        )
        return int(cur.rowcount or 0) > 0


def revoke_session_by_token(token: str, *, reason: str = "logout") -> bool:
    if not token:
        return False
    reason = str(reason or "logout")[:32]
    with tx() as conn:
        cur = conn.execute(
            """
            UPDATE user_sessions
            SET revoked_at = ?, revoke_reason = ?
            WHERE token_hash = ? AND revoked_at = 0
            """,
            (now(), reason, _session_token_hash(token)),
        )
        return int(cur.rowcount or 0) > 0


def collapse_duplicate_sessions(user_id: int) -> None:
    """Collapse same device_id rows, or empty↔empty (ip, label) pairs only.

    A real device_id must never mark an empty-device_id row as duplicate just
    because they share a Cloudflare/NAT IP and UA label.
    """
    rows = connection().execute(
        """
        SELECT id, device_id, ip, device_label
        FROM user_sessions
        WHERE user_id = ? AND revoked_at = 0
        ORDER BY last_seen_at DESC, id DESC
        """,
        (int(user_id),),
    ).fetchall()
    with_id = [row for row in rows if str(row["device_id"] or "")]
    without_id = [row for row in rows if not str(row["device_id"] or "")]
    seen_device: set[str] = set()
    seen_empty_fp: set[tuple[str, str]] = set()
    for row in with_id:
        device_id = str(row["device_id"] or "")
        if device_id in seen_device:
            revoke_user_session(int(row["id"]), int(user_id), reason="duplicate")
            continue
        seen_device.add(device_id)
    for row in without_id:
        fp = (str(row["ip"] or ""), str(row["device_label"] or ""))
        if fp[0] and fp[1] and fp in seen_empty_fp:
            revoke_user_session(int(row["id"]), int(user_id), reason="duplicate")
            continue
        if fp[0] and fp[1]:
            seen_empty_fp.add(fp)


def prune_user_sessions(user_id: int, *, older_than: float) -> None:
    with tx() as conn:
        conn.execute(
            """
            UPDATE user_sessions
            SET revoked_at = ?, revoke_reason = 'prune'
            WHERE user_id = ? AND revoked_at = 0 AND last_seen_at < ?
            """,
            (now(), int(user_id), float(older_than)),
        )


def get_first_user() -> sqlite3.Row | None:
    return connection().execute("SELECT * FROM users ORDER BY id ASC LIMIT 1").fetchone()


def get_recovery_sample_item(user_id: int) -> sqlite3.Row | None:
    rows = get_recovery_sample_items(user_id, limit=1)
    return rows[0] if rows else None


def get_recovery_sample_items(user_id: int, limit: int = 8) -> list[sqlite3.Row]:
    return connection().execute(
        """
        SELECT item_uuid, ciphertext
        FROM items
        WHERE user_id = ? AND deleted = 0 AND ciphertext != ''
        ORDER BY LENGTH(ciphertext) ASC
        LIMIT ?
        """,
        (int(user_id), int(limit)),
    ).fetchall()


def user_password_changed_at(user) -> float:
    try:
        value = float(user["password_changed_at"])
    except (KeyError, TypeError, ValueError):
        return 0.0
    return value if value > 0 else 0.0


def update_user_password(user_id: int, password_hash: str) -> float:
    ts = now()
    with tx() as conn:
        conn.execute(
            """
            UPDATE users
            SET password_hash = ?, updated_at = ?, password_changed_at = ?
            WHERE id = ?
            """,
            (password_hash, ts, ts, user_id),
        )
    return ts


def update_user_totp(user_id: int, secret: str, enabled: bool) -> None:
    with tx() as conn:
        conn.execute(
            """
            UPDATE users
            SET totp_secret = ?, totp_enabled = ?, updated_at = ?
            WHERE id = ?
            """,
            (secret, 1 if enabled else 0, now(), user_id),
        )


def update_backup_settings(
    user_id: int,
    email: str,
    enabled: bool,
    *,
    backup_email_verified: int | None = None,
) -> None:
    with tx() as conn:
        if backup_email_verified is None:
            conn.execute(
                """
                UPDATE users
                SET backup_email = ?, backup_enabled = ?, updated_at = ?
                WHERE id = ?
                """,
                (email.strip().lower(), 1 if enabled else 0, now(), user_id),
            )
            return
        conn.execute(
            """
            UPDATE users
            SET backup_email = ?, backup_enabled = ?, backup_email_verified = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                email.strip().lower(),
                1 if enabled else 0,
                1 if backup_email_verified else 0,
                now(),
                user_id,
            ),
        )


def set_email_verification(user_id: int, code_hash: str, expires_at: float) -> None:
    with tx() as conn:
        conn.execute(
            """
            UPDATE users
            SET email_verify_hash = ?, email_verify_expires = ?, email_verify_attempts = 0, updated_at = ?
            WHERE id = ?
            """,
            (code_hash, float(expires_at), now(), user_id),
        )


def bump_email_verify_attempts(user_id: int) -> None:
    with tx() as conn:
        conn.execute(
            """
            UPDATE users
            SET email_verify_attempts = email_verify_attempts + 1, updated_at = ?
            WHERE id = ?
            """,
            (now(), user_id),
        )


def mark_email_verified(user_id: int) -> None:
    from plans import plan_storage_quota_bytes

    user = get_user_by_id(user_id)
    plan = str(user["plan"] or "") if user else ""
    full_quota = plan_storage_quota_bytes(plan) if plan else 0
    with tx() as conn:
        if full_quota > 0:
            conn.execute(
                """
                UPDATE users
                SET email_verified = 1, email_verify_hash = '', email_verify_expires = 0,
                    email_verify_attempts = 0, storage_quota_bytes = ?, updated_at = ?
                WHERE id = ?
                """,
                (int(full_quota), now(), user_id),
            )
        else:
            conn.execute(
                """
                UPDATE users
                SET email_verified = 1, email_verify_hash = '', email_verify_expires = 0,
                    email_verify_attempts = 0, updated_at = ?
                WHERE id = ?
                """,
                (now(), user_id),
            )


def set_backup_verification(user_id: int, code_hash: str, expires_at: float) -> None:
    with tx() as conn:
        conn.execute(
            """
            UPDATE users
            SET backup_verify_hash = ?, backup_verify_expires = ?, backup_verify_attempts = 0, updated_at = ?
            WHERE id = ?
            """,
            (code_hash, float(expires_at), now(), user_id),
        )


def bump_backup_verify_attempts(user_id: int) -> None:
    with tx() as conn:
        conn.execute(
            """
            UPDATE users
            SET backup_verify_attempts = backup_verify_attempts + 1, updated_at = ?
            WHERE id = ?
            """,
            (now(), user_id),
        )


def mark_backup_email_verified(user_id: int) -> None:
    with tx() as conn:
        conn.execute(
            """
            UPDATE users
            SET backup_email_verified = 1, backup_verify_hash = '', backup_verify_expires = 0,
                backup_verify_attempts = 0, updated_at = ?
            WHERE id = ?
            """,
            (now(), user_id),
        )


def log_email_send(user_id: int, recipient: str, kind: str) -> None:
    with tx() as conn:
        conn.execute(
            """
            INSERT INTO email_send_log (user_id, recipient, kind, sent_at)
            VALUES (?, ?, ?, ?)
            """,
            (int(user_id), recipient.strip().lower(), kind, now()),
        )


def last_email_send(user_id: int, recipient: str, kind: str) -> float:
    row = connection().execute(
        """
        SELECT sent_at FROM email_send_log
        WHERE user_id = ? AND recipient = ? COLLATE NOCASE AND kind = ?
        ORDER BY sent_at DESC
        LIMIT 1
        """,
        (int(user_id), recipient.strip().lower(), kind),
    ).fetchone()
    if not row:
        return 0.0
    try:
        return float(row[0] or 0)
    except (TypeError, ValueError):
        return 0.0


def count_email_sends_for_user(user_id: int, kind: str, since: float) -> int:
    row = connection().execute(
        """
        SELECT COUNT(*) FROM email_send_log
        WHERE user_id = ? AND kind = ? AND sent_at >= ?
        """,
        (int(user_id), kind, float(since)),
    ).fetchone()
    return int(row[0] if row else 0)


def last_signin_alert(user_id: int, device_key: str) -> float:
    key = str(device_key or "").strip()[:200]
    if not key:
        return 0.0
    row = connection().execute(
        """
        SELECT sent_at FROM signin_alert_log
        WHERE user_id = ? AND device_key = ?
        ORDER BY sent_at DESC
        LIMIT 1
        """,
        (int(user_id), key),
    ).fetchone()
    if not row:
        return 0.0
    try:
        return float(row[0] or 0)
    except (TypeError, ValueError):
        return 0.0


def claim_signin_alert(user_id: int, device_key: str, *, window_seconds: float = 86400.0) -> bool:
    """Record a sign-in alert slot. Return True if this call may send.

    At most one alert per (user, device_key) inside ``window_seconds``.
    """
    key = str(device_key or "").strip()[:200]
    if not key:
        return False
    uid = int(user_id)
    now_ts = now()
    since = now_ts - float(window_seconds)
    with tx() as conn:
        row = conn.execute(
            """
            SELECT sent_at FROM signin_alert_log
            WHERE user_id = ? AND device_key = ? AND sent_at >= ?
            ORDER BY sent_at DESC
            LIMIT 1
            """,
            (uid, key, since),
        ).fetchone()
        if row:
            return False
        conn.execute(
            """
            INSERT INTO signin_alert_log (user_id, device_key, sent_at)
            VALUES (?, ?, ?)
            """,
            (uid, key, now_ts),
        )
    return True


def count_email_sends_global(kind: str, since: float) -> int:
    row = connection().execute(
        """
        SELECT COUNT(*) AS n FROM email_send_log
        WHERE kind = ? AND sent_at >= ?
        """,
        (str(kind), float(since)),
    ).fetchone()
    try:
        return int(row["n"] or 0)
    except (TypeError, ValueError, KeyError):
        return 0


def count_email_sends_for_recipient(recipient: str, kind: str, since: float) -> int:
    row = connection().execute(
        """
        SELECT COUNT(*) FROM email_send_log
        WHERE recipient = ? COLLATE NOCASE AND kind = ? AND sent_at >= ?
        """,
        (recipient.strip().lower(), kind, float(since)),
    ).fetchone()
    return int(row[0] if row else 0)


def update_pcloud_settings(
    user_id: int,
    username: str,
    remote_path: str,
    region: str,
    enabled: bool,
) -> None:
    with tx() as conn:
        conn.execute(
            """
            UPDATE users
            SET pcloud_username = ?, pcloud_remote_path = ?, pcloud_region = ?,
                pcloud_enabled = ?, updated_at = ?
            WHERE id = ?
            """,
            (username.strip(), remote_path.strip(), region.strip().lower(), 1 if enabled else 0, now(), user_id),
        )


def update_pcloud_sync_status(user_id: int, status: str, detail: str = "") -> None:
    with tx() as conn:
        conn.execute(
            """
            UPDATE users
            SET pcloud_last_sync_at = ?, pcloud_last_sync_status = ?,
                pcloud_last_sync_detail = ?, updated_at = ?
            WHERE id = ?
            """,
            (now(), status, detail[:500], now(), user_id),
        )


def upsert_item(
    user_id: int,
    item_uuid: str,
    ciphertext: str,
    content_version: int,
    content_hash: str,
    deleted: bool,
    updated_at: float,
    blob_ciphertext: str = "",
    *,
    conn: sqlite3.Connection | None = None,
    synced_at: float | None = None,
    force: bool = False,
) -> None:
    """Write one sync row. ``force`` skips the client-clock guard; the batch
    planner sets it when the client proved it saw the current revision
    (base_rev matched), so the write must not be lost to a slow clock."""
    guard = "" if force else "WHERE excluded.updated_at >= items.updated_at"
    sql = f"""
        INSERT INTO items (
            user_id, item_uuid, content_version, ciphertext, content_hash,
            blob_ciphertext, deleted, updated_at, synced_at, rev
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(user_id, item_uuid) DO UPDATE SET
            content_version = excluded.content_version,
            ciphertext = excluded.ciphertext,
            content_hash = excluded.content_hash,
            blob_ciphertext = CASE
                WHEN excluded.blob_ciphertext = '' AND excluded.deleted = 0 THEN items.blob_ciphertext
                ELSE excluded.blob_ciphertext
            END,
            deleted = excluded.deleted,
            updated_at = excluded.updated_at,
            synced_at = excluded.synced_at,
            rev = items.rev + 1
        {guard}
    """
    params = (
        user_id,
        item_uuid,
        content_version,
        ciphertext,
        content_hash,
        blob_ciphertext or "",
        1 if deleted else 0,
        updated_at,
        float(synced_at if synced_at is not None else time.time()),
    )
    if conn is not None:
        conn.execute(sql, params)
        return
    with tx() as inner:
        inner.execute(sql, params)


def next_synced_at(user_id: int, conn: sqlite3.Connection) -> float:
    """Strictly increasing server cursor for this user's items.

    Must be called while holding the write lock (BEGIN IMMEDIATE) so the cursor
    order matches commit order — otherwise a pull could observe a later cursor
    before an earlier one commits and skip it forever.
    """
    row = conn.execute(
        "SELECT MAX(synced_at) AS m FROM items WHERE user_id = ?",
        (user_id,),
    ).fetchone()
    last = float(row["m"] or 0) if row else 0.0
    return max(time.time(), last + 0.000001)


# A client clock this far ahead of the server is treated as "now" for ordering,
# so one device with a wrong clock cannot win every conflict for months.
SYNC_MAX_CLOCK_SKEW_SEC = float(os.environ.get("NOTES_SYNC_MAX_CLOCK_SKEW_SEC", "300"))
# Largest single item (ciphertext + blob) a push may carry. Anything bigger is
# refused per item ("too_large") instead of failing the whole request body.
SYNC_MAX_ITEM_BYTES = int(os.environ.get("NOTES_SYNC_MAX_ITEM_BYTES", str(75 * 1024 * 1024)))


def _existing_rev(existing) -> int:
    if not existing:
        return 0
    try:
        return int(existing["rev"] or 0)
    except (KeyError, IndexError, TypeError, ValueError):
        return 0


def _parse_base_rev(raw) -> int | None:
    """Client's last-seen revision, or None for clients that do not send one."""
    if raw is None or raw == "":
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return max(0, value)


def _plan_sync_item(
    item: dict[str, Any],
    *,
    existing,
    quota: int | None,
    current_used: int,
    now: float | None = None,
) -> tuple[dict[str, Any], int, dict[str, Any] | None]:
    """Return (result row, updated current_used, upsert payload or None).

    Statuses: ``ok`` (written), ``unchanged`` (same hash already stored),
    ``stale`` (legacy clients only: an older client clock lost last-writer-wins),
    ``conflict`` (client sent ``base_rev`` and the server row moved on),
    ``quota_exceeded``, ``too_large``, ``rejected`` (malformed). Every result
    carries the server revision the client should remember.
    """
    now = time.time() if now is None else now
    item_uuid = str(item.get("item_uuid") or "").strip()
    ciphertext = str(item.get("ciphertext") or "")
    blob_ciphertext = str(item.get("blob_ciphertext") or "")
    if not item_uuid or not ciphertext:
        return {"item_uuid": item_uuid or "", "status": "rejected", "reason": "empty"}, current_used, None
    try:
        updated_at = float(item.get("updated_at") or now)
    except (TypeError, ValueError):
        return {"item_uuid": item_uuid, "status": "rejected", "reason": "bad_updated_at"}, current_used, None
    if updated_at != updated_at or updated_at in (float("inf"), float("-inf")):
        return {"item_uuid": item_uuid, "status": "rejected", "reason": "bad_updated_at"}, current_used, None
    updated_at = min(updated_at, now + SYNC_MAX_CLOCK_SKEW_SEC)
    existing_rev = _existing_rev(existing)
    existing_updated = float(existing["updated_at"] or 0) if existing else 0.0
    incoming_hash = str(item.get("content_hash") or "")
    base_rev = _parse_base_rev(item.get("base_rev"))
    same_hash = bool(existing and incoming_hash and str(existing["content_hash"] or "") == incoming_hash)
    if same_hash and updated_at <= existing_updated:
        return {"item_uuid": item_uuid, "status": "unchanged", "rev": existing_rev}, current_used, None
    force = False
    if existing and base_rev is not None:
        if base_rev != existing_rev:
            if same_hash:
                # Our earlier push landed but its response was lost.
                return {"item_uuid": item_uuid, "status": "unchanged", "rev": existing_rev}, current_used, None
            # Another device wrote since this client last saw the item. Do not
            # pick a winner by clock; let the client keep both versions.
            return {"item_uuid": item_uuid, "status": "conflict", "rev": existing_rev}, current_used, None
        # The client saw the current revision: its write is the newest by
        # causality, whatever its clock says.
        force = True
        updated_at = max(updated_at, existing_updated)
    elif existing and updated_at < existing_updated:
        # Legacy client (no base_rev): another device already stored a newer
        # version (last-writer-wins). Tell the client explicitly instead of a
        # silent no-op "ok" so it can drop the pending push and take the server
        # copy on its next pull.
        return {"item_uuid": item_uuid, "status": "stale", "rev": existing_rev}, current_used, None
    deleted = bool(item.get("deleted"))
    new_size = _item_storage_size(ciphertext, blob_ciphertext)
    if new_size > SYNC_MAX_ITEM_BYTES:
        return {
            "item_uuid": item_uuid,
            "status": "too_large",
            "rev": existing_rev,
            "max_item_bytes": SYNC_MAX_ITEM_BYTES,
        }, current_used, None
    used = current_used
    if quota is not None and not deleted:
        old_size = 0
        if existing and not int(existing["deleted"] or 0):
            old_size = int(existing["ct_len"] or 0) + int(existing["blob_len"] or 0)
        if not blob_ciphertext and existing:
            # Clients that never downloaded the file (light vault) push metadata only;
            # the stored blob is kept, so count it toward the new size.
            new_size += int(existing["blob_len"] or 0)
        projected = used - old_size + new_size
        if projected > quota and projected > used:
            return {"item_uuid": item_uuid, "status": "quota_exceeded", "rev": existing_rev}, used, None
        used = projected
    elif quota is not None and deleted and existing and not int(existing["deleted"] or 0):
        used -= int(existing["ct_len"] or 0) + int(existing["blob_len"] or 0)
        used = max(0, used)
    payload = {
        "item_uuid": item_uuid,
        "ciphertext": ciphertext,
        "content_version": int(item.get("content_version") or 1),
        "content_hash": incoming_hash,
        "deleted": deleted,
        "updated_at": updated_at,
        "blob_ciphertext": blob_ciphertext,
        "force": force,
    }
    result = {
        "item_uuid": item_uuid,
        "status": "ok",
        "rev": existing_rev + 1 if existing else 1,
        "updated_at": updated_at,
    }
    return result, used, payload


def upsert_items_batch(user_id: int, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Upsert many sync items in a single transaction. Returns per-item status.

    Items the plan refuses (quota, size, conflict, stale, malformed) do not
    block the others: every acceptable item in the batch is written.
    """
    if not items:
        return []
    user = get_user_by_id(user_id)
    quota = user_storage_quota_effective(user) if user else None
    conn = connection()
    if conn.in_transaction:
        return _upsert_items_batch_locked(conn, user_id, items, quota)
    try:
        # Take the write lock up front so synced_at is assigned in commit order.
        conn.execute("BEGIN IMMEDIATE")
        results = _upsert_items_batch_locked(conn, user_id, items, quota)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return results


def _conflict_server_item(conn: sqlite3.Connection, user_id: int, item_uuid: str) -> dict[str, Any] | None:
    """The server's copy for a conflicting item (ciphertext only; the blob, if
    any, is fetched through /api/sync/blobs like on a pull)."""
    row = conn.execute(
        """
        SELECT item_uuid, content_version, ciphertext, content_hash, deleted,
               updated_at, synced_at, rev, LENGTH(blob_ciphertext) AS blob_len
        FROM items WHERE user_id = ? AND item_uuid = ?
        """,
        (user_id, item_uuid),
    ).fetchone()
    if not row:
        return None
    return {
        "item_uuid": row["item_uuid"],
        "content_version": int(row["content_version"] or 1),
        "ciphertext": row["ciphertext"],
        "blob_ciphertext": "",
        "needs_blob": bool(row["blob_len"]),
        "content_hash": row["content_hash"],
        "deleted": bool(row["deleted"]),
        "updated_at": float(row["updated_at"] or 0),
        "synced_at": float(row["synced_at"] or 0),
        "rev": int(row["rev"] or 0),
    }


def _upsert_items_batch_locked(
    conn: sqlite3.Connection,
    user_id: int,
    items: list[dict[str, Any]],
    quota: int | None,
) -> list[dict[str, Any]]:
    synced_at = next_synced_at(user_id, conn)
    now = time.time()
    current_used = 0
    if quota is not None:
        row = conn.execute(
            """
            SELECT COALESCE(SUM(LENGTH(ciphertext) + LENGTH(blob_ciphertext)), 0) AS n
            FROM items WHERE user_id = ? AND deleted = 0
            """,
            (user_id,),
        ).fetchone()
        current_used = int(row["n"] if row else 0)
    results: list[dict[str, Any]] = []
    for item in items:
        item_uuid = str(item.get("item_uuid") or "").strip()
        existing = None
        if item_uuid:
            existing = conn.execute(
                """
                SELECT updated_at, content_hash, deleted, rev, LENGTH(ciphertext) AS ct_len,
                       LENGTH(blob_ciphertext) AS blob_len
                FROM items
                WHERE user_id = ? AND item_uuid = ?
                """,
                (user_id, item_uuid),
            ).fetchone()
        result, current_used, payload = _plan_sync_item(
            item,
            existing=existing,
            quota=quota,
            current_used=current_used,
            now=now,
        )
        if result.get("status") == "conflict":
            server_item = _conflict_server_item(conn, user_id, item_uuid)
            if server_item is not None:
                result["server_item"] = server_item
        if payload is not None:
            upsert_item(
                user_id,
                payload["item_uuid"],
                payload["ciphertext"],
                payload["content_version"],
                payload["content_hash"],
                payload["deleted"],
                payload["updated_at"],
                payload["blob_ciphertext"],
                conn=conn,
                synced_at=synced_at,
                force=bool(payload.get("force")),
            )
        results.append(result)
    return results


def wal_checkpoint(mode: str = "PASSIVE") -> None:
    conn = connection()
    conn.execute(f"PRAGMA wal_checkpoint({mode})")
    conn.execute("PRAGMA incremental_vacuum")


def get_sync_watermark(user_id: int) -> dict[str, Any]:
    row = connection().execute(
        """
        SELECT MAX(updated_at) AS watermark, MAX(synced_at) AS synced_watermark,
               COUNT(*) AS item_count
        FROM items WHERE user_id = ?
        """,
        (user_id,),
    ).fetchone()
    return {
        "watermark": float(row["watermark"] or 0) if row else 0.0,
        "synced_watermark": float(row["synced_watermark"] or 0) if row else 0.0,
        "item_count": int(row["item_count"] or 0) if row else 0,
    }


def list_items_by_uuid(user_id: int, uuids: list[str], *, include_blobs: bool = True) -> list[dict[str, Any]]:
    ids = [str(u).strip() for u in uuids if str(u).strip()]
    if not ids:
        return []
    placeholders = ",".join("?" for _ in ids)
    rows = connection().execute(
        f"""
        SELECT item_uuid, content_version, ciphertext, blob_ciphertext,
               content_hash, deleted, updated_at, synced_at, rev
        FROM items
        WHERE user_id = ? AND item_uuid IN ({placeholders})
        ORDER BY updated_at ASC, item_uuid ASC
        """,
        [user_id, *ids],
    ).fetchall()
    out: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        if not include_blobs:
            had_blob = bool(str(item.get("blob_ciphertext") or ""))
            item["blob_ciphertext"] = ""
            if had_blob:
                item["needs_blob"] = True
        out.append(item)
    return out


def list_item_blobs(user_id: int, uuids: list[str]) -> list[dict[str, Any]]:
    ids = [str(u).strip() for u in uuids if str(u).strip()]
    if not ids:
        return []
    placeholders = ",".join("?" for _ in ids)
    rows = connection().execute(
        f"""
        SELECT item_uuid, blob_ciphertext, updated_at, content_hash
        FROM items
        WHERE user_id = ? AND item_uuid IN ({placeholders})
          AND blob_ciphertext != ''
        """,
        [user_id, *ids],
    ).fetchall()
    return [dict(row) for row in rows]


def count_undeleted_items(user_id: int) -> int:
    row = connection().execute(
        "SELECT COUNT(*) AS n FROM items WHERE user_id = ? AND deleted = 0",
        (user_id,),
    ).fetchone()
    return int(row["n"] if row else 0)


def user_vault_stats(user_id: int) -> dict[str, int]:
    row = connection().execute(
        """
        SELECT
          COUNT(*) AS item_count,
          COALESCE(SUM(CASE WHEN deleted = 0 THEN 1 ELSE 0 END), 0) AS active_items,
          COALESCE(SUM(CASE WHEN deleted = 0 THEN LENGTH(ciphertext) ELSE 0 END), 0) AS vault_bytes,
          COALESCE(SUM(CASE WHEN deleted = 0 THEN LENGTH(ciphertext) + LENGTH(blob_ciphertext) ELSE 0 END), 0) AS storage_bytes,
          COALESCE(SUM(CASE WHEN deleted = 1 THEN 1 ELSE 0 END), 0) AS deleted_items
        FROM items
        WHERE user_id = ?
        """,
        (user_id,),
    ).fetchone()
    return {
        "item_count": int(row["item_count"] if row else 0),
        "active_items": int(row["active_items"] if row else 0),
        "vault_bytes": int(row["vault_bytes"] if row else 0),
        "storage_bytes": int(row["storage_bytes"] if row else 0),
        "deleted_items": int(row["deleted_items"] if row else 0),
    }


def user_storage_quota_bytes(user) -> int:
    try:
        quota = int(user["storage_quota_bytes"] or 0)
    except (KeyError, TypeError, ValueError):
        quota = 0
    return quota


def user_storage_quota_effective(user) -> int | None:
    """Return quota in bytes, or None when unlimited."""
    quota = user_storage_quota_bytes(user)
    return None if quota <= 0 else quota


def user_plan(user) -> str:
    from plans import default_plan, normalize_plan

    try:
        return normalize_plan(user["plan"])
    except (KeyError, TypeError, ValueError):
        return default_plan()


def list_users() -> list[dict[str, Any]]:
    rows = connection().execute(
        """
        SELECT id, email, auth_method, totp_enabled, storage_quota_bytes, is_admin, plan,
               created_at, updated_at, password_changed_at
        FROM users
        ORDER BY id ASC
        """
    ).fetchall()
    return [dict(row) for row in rows]


def update_user_plan(user_id: int, plan: str) -> None:
    from plans import normalize_plan, plan_storage_quota_bytes

    normalized = normalize_plan(plan)
    quota = plan_storage_quota_bytes(normalized)
    with tx() as conn:
        conn.execute(
            "UPDATE users SET plan = ?, storage_quota_bytes = ?, updated_at = ? WHERE id = ?",
            (normalized, quota, now(), int(user_id)),
        )


def update_user_storage_quota(user_id: int, quota_bytes: int) -> None:
    with tx() as conn:
        conn.execute(
            "UPDATE users SET storage_quota_bytes = ?, updated_at = ? WHERE id = ?",
            (max(0, int(quota_bytes)), now(), int(user_id)),
        )


def update_user_admin_flag(user_id: int, is_admin: bool) -> None:
    with tx() as conn:
        conn.execute(
            "UPDATE users SET is_admin = ?, updated_at = ? WHERE id = ?",
            (1 if is_admin else 0, now(), int(user_id)),
        )


def delete_user(user_id: int) -> bool:
    with tx() as conn:
        cur = conn.execute("DELETE FROM users WHERE id = ?", (int(user_id),))
        return int(cur.rowcount or 0) > 0


def purge_user_data(user_id: int) -> bool:
    """Delete account rows and remove per-user files from disk."""
    import shutil

    uid = int(user_id)
    user = get_user_by_id(uid)
    if not user:
        return False
    email = str(user["email"] or "")
    if not delete_user(uid):
        return False
    ocr_dir = DATA_DIR / "ocr" / str(uid)
    if ocr_dir.is_dir():
        shutil.rmtree(ocr_dir, ignore_errors=True)
    try:
        from uploads import remove_user_upload_dir

        remove_user_upload_dir(uid)
    except OSError:
        pass
    cache_file = DATA_DIR / "server-info-cache" / f"user-{uid}.json"
    try:
        cache_file.unlink(missing_ok=True)
    except OSError:
        pass
    return True


def _item_storage_size(ciphertext: str, blob_ciphertext: str) -> int:
    return len(ciphertext or "") + len(blob_ciphertext or "")


def dir_size(path: Path) -> int:
    if not path.is_dir():
        return 0
    total = 0
    for entry in path.rglob("*"):
        if entry.is_file():
            try:
                total += entry.stat().st_size
            except OSError:
                continue
    return total


def list_items_since(
    user_id: int,
    since: float = 0.0,
    *,
    after_uuid: str = "",
    limit: int | None = None,
    include_blobs: bool = True,
    known_hashes: dict[str, str] | None = None,
    cursor: str = "updated_at",
) -> list[dict[str, Any]]:
    """Return items newer than (since, after_uuid), oldest first.

    Pagination uses (cursor column, item_uuid) so large vaults can sync in
    pages without skipping ties on the same timestamp. ``cursor`` is
    ``"synced_at"`` (server receive time — what current clients use) or the
    legacy ``"updated_at"`` (client edit time) for older app builds.
    """
    if cursor == "synced_at":
        # Rows stored with synced_at = 0 (writes from before the cursor
        # existed, stale workers, bulk restores) would otherwise stay
        # invisible to incremental pulls forever once a client's cursor moves
        # past them. Fall back to updated_at for those rows — the same rule
        # the web client's rowCursor() uses. A repair backfill
        # (UPDATE items SET synced_at = updated_at WHERE synced_at = 0)
        # removes such rows over time; this keeps sync correct until then.
        column = "COALESCE(NULLIF(synced_at, 0), updated_at)"
    else:
        column = "updated_at"
    after_uuid = str(after_uuid or "").strip()
    params: list[Any] = [user_id, since, since, after_uuid]
    sql = f"""
        SELECT item_uuid, content_version, ciphertext, blob_ciphertext,
               content_hash, deleted, updated_at, synced_at, rev
        FROM items
        WHERE user_id = ?
          AND (
            {column} > ?
            OR ({column} = ? AND item_uuid > ?)
          )
        ORDER BY {column} ASC, item_uuid ASC
    """
    if limit is not None:
        sql += " LIMIT ?"
        params.append(int(limit))
    rows = connection().execute(sql, params).fetchall()
    known = known_hashes or {}
    out: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        item_uuid = str(item.get("item_uuid") or "")
        content_hash = str(item.get("content_hash") or "")
        if known and item_uuid and content_hash and known.get(item_uuid) == content_hash:
            out.append({
                "item_uuid": item_uuid,
                "content_version": int(item.get("content_version") or 1),
                "ciphertext": "",
                "blob_ciphertext": "",
                "content_hash": content_hash,
                "deleted": bool(item.get("deleted")),
                "updated_at": float(item.get("updated_at") or 0),
                "synced_at": float(item.get("synced_at") or 0),
                "rev": int(item.get("rev") or 0),
                "unchanged": True,
            })
            continue
        if not include_blobs:
            had_blob = bool(str(item.get("blob_ciphertext") or ""))
            item["blob_ciphertext"] = ""
            if had_blob:
                item["needs_blob"] = True
        out.append(item)
    return out


def all_items(user_id: int) -> list[dict[str, Any]]:
    return list(iter_backup_items(user_id))


def iter_backup_items(user_id: int):
    """Yield encrypted items one at a time to keep backup memory use low."""
    cur = connection().execute(
        """
        SELECT item_uuid, content_version, ciphertext, blob_ciphertext,
               content_hash, deleted, updated_at
        FROM items
        WHERE user_id = ? AND deleted = 0
        ORDER BY updated_at ASC
        """,
        (user_id,),
    )
    for row in cur:
        yield dict(row)


def users_with_backup_enabled() -> list[sqlite3.Row]:
    return list(
        connection().execute(
            """
            SELECT * FROM users
            WHERE backup_enabled = 1
            """
        ).fetchall()
    )


def users_with_pcloud_enabled() -> list[sqlite3.Row]:
    return list(
        connection().execute(
            """
            SELECT * FROM users
            WHERE pcloud_enabled = 1 AND pcloud_username != ''
            """
        ).fetchall()
    )


def log_backup(
    user_id: int,
    recipient: str,
    item_count: int,
    bytes_size: int,
    status: str,
    detail: str = "",
) -> None:
    with tx() as conn:
        conn.execute(
            """
            INSERT INTO backup_log (user_id, sent_at, recipient, item_count, bytes_size, status, detail)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (user_id, now(), recipient, item_count, bytes_size, status, detail),
        )



def reminder_row(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if not row:
        return None
    return {
        "id": int(row["id"]),
        "user_id": int(row["user_id"]),
        "item_uuid": str(row["item_uuid"]),
        "warn_at": float(row["warn_at"] or 0),
        "title": str(row["title"] or ""),
        "sent_at": float(row["sent_at"] or 0),
        "sending_at": float(row["sending_at"] or 0) if "sending_at" in row.keys() else 0.0,
        "created_at": float(row["created_at"] or 0),
        "updated_at": float(row["updated_at"] or 0),
    }


WARN_AT_RESEND_SEC = 60.0
CLAIM_STALE_SEC = 600.0


def upsert_reminder(user_id: int, item_uuid: str, warn_at: float, title: str = "") -> dict[str, Any]:
    """Store only (note id, time). `title` is accepted for backwards compatibility but never persisted."""
    ts = now()
    warn_at = float(warn_at)
    with tx() as conn:
        conn.execute(
            """
            INSERT INTO note_reminders (
                user_id, item_uuid, warn_at, title, sent_at, sending_at, created_at, updated_at
            ) VALUES (?, ?, ?, '', 0, 0, ?, ?)
            ON CONFLICT(user_id, item_uuid) DO UPDATE SET
                warn_at = excluded.warn_at,
                title = '',
                sent_at = CASE
                    WHEN ABS(note_reminders.warn_at - excluded.warn_at) < ?
                    THEN note_reminders.sent_at
                    ELSE 0
                END,
                sending_at = CASE
                    WHEN ABS(note_reminders.warn_at - excluded.warn_at) < ?
                    THEN note_reminders.sending_at
                    ELSE 0
                END,
                updated_at = excluded.updated_at
            """,
            (user_id, item_uuid, warn_at, ts, ts, WARN_AT_RESEND_SEC, WARN_AT_RESEND_SEC),
        )
    return get_reminder(user_id, item_uuid) or {
        "user_id": user_id,
        "item_uuid": item_uuid,
        "warn_at": warn_at,
        "title": "",
        "sent_at": 0.0,
        "sending_at": 0.0,
    }


def get_reminder(user_id: int, item_uuid: str) -> dict[str, Any] | None:
    row = connection().execute(
        """
        SELECT * FROM note_reminders
        WHERE user_id = ? AND item_uuid = ?
        """,
        (user_id, item_uuid),
    ).fetchone()
    return reminder_row(row)


def list_reminders(user_id: int) -> list[dict[str, Any]]:
    rows = connection().execute(
        """
        SELECT * FROM note_reminders
        WHERE user_id = ?
        ORDER BY warn_at ASC
        """,
        (user_id,),
    ).fetchall()
    return [row for row in (reminder_row(item) for item in rows) if row]


def delete_reminder(user_id: int, item_uuid: str) -> bool:
    with tx() as conn:
        cur = conn.execute(
            "DELETE FROM note_reminders WHERE user_id = ? AND item_uuid = ?",
            (user_id, item_uuid),
        )
        return cur.rowcount > 0


def _due_where(when: float) -> tuple[str, list[Any]]:
    stale_before = when - CLAIM_STALE_SEC
    return (
        "sent_at = 0 AND warn_at <= ? AND (sending_at = 0 OR sending_at < ?)",
        [when, stale_before],
    )


def due_reminders(now_ts: float | None = None) -> list[dict[str, Any]]:
    when = float(now_ts if now_ts is not None else now())
    where, params = _due_where(when)
    rows = connection().execute(
        f"""
        SELECT * FROM note_reminders
        WHERE {where}
        ORDER BY warn_at ASC
        """,
        params,
    ).fetchall()
    return [row for row in (reminder_row(item) for item in rows) if row]


def claim_due_reminders(now_ts: float | None = None) -> list[dict[str, Any]]:
    """Mark due rows as in-flight, then return them. Safe for overlapping cron."""
    when = float(now_ts if now_ts is not None else now())
    where, params = _due_where(when)
    claimed: list[dict[str, Any]] = []
    conn = connection()
    with _lock:
        try:
            conn.execute("BEGIN IMMEDIATE")
            rows = conn.execute(
                f"""
                SELECT * FROM note_reminders
                WHERE {where}
                ORDER BY warn_at ASC
                """,
                params,
            ).fetchall()
            for row in rows:
                cur = conn.execute(
                    f"""
                    UPDATE note_reminders
                    SET sending_at = ?, updated_at = ?
                    WHERE id = ? AND {where}
                    """,
                    (when, when, int(row["id"]), *params),
                )
                if cur.rowcount == 1:
                    item = reminder_row(row)
                    if item:
                        item["sending_at"] = when
                        item["updated_at"] = when
                        claimed.append(item)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return claimed


def mark_reminder_sent(
    reminder_id: int,
    sent_at: float | None = None,
    warn_at: float | None = None,
) -> None:
    stamp = float(sent_at if sent_at is not None else now())
    with tx() as conn:
        if warn_at is None:
            conn.execute(
                """
                UPDATE note_reminders
                SET sent_at = ?, sending_at = 0, updated_at = ?
                WHERE id = ? AND sent_at = 0
                """,
                (stamp, now(), int(reminder_id)),
            )
            return
        conn.execute(
            """
            UPDATE note_reminders
            SET sent_at = ?, sending_at = 0, updated_at = ?
            WHERE id = ? AND sent_at = 0 AND ABS(warn_at - ?) < ?
            """,
            (stamp, now(), int(reminder_id), float(warn_at), WARN_AT_RESEND_SEC),
        )


def release_reminder_claim(reminder_id: int) -> None:
    with tx() as conn:
        conn.execute(
            """
            UPDATE note_reminders
            SET sending_at = 0, updated_at = ?
            WHERE id = ? AND sent_at = 0
            """,
            (now(), int(reminder_id)),
        )


REMINDER_LOG_KEEP_PER_USER = 200
REMINDER_LOG_MAX_AGE_SEC = 30 * 24 * 60 * 60


def log_reminder(user_id: int, item_uuid: str, recipient: str, status: str, detail: str = "") -> None:
    detail = detail[:500]
    with tx() as conn:
        if status == "error":
            # A stuck SMTP relay retries every cron tick; collapse identical
            # consecutive failures into one row instead of 288 rows a day.
            last = conn.execute(
                """
                SELECT id, status, detail FROM reminder_log
                WHERE user_id = ? AND item_uuid = ?
                ORDER BY id DESC LIMIT 1
                """,
                (user_id, item_uuid),
            ).fetchone()
            if last and last["status"] == "error" and last["detail"] == detail:
                conn.execute(
                    "UPDATE reminder_log SET created_at = ? WHERE id = ?",
                    (now(), int(last["id"])),
                )
                return
        conn.execute(
            """
            INSERT INTO reminder_log (user_id, item_uuid, recipient, status, detail, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (user_id, item_uuid, recipient, status, detail, now()),
        )


def prune_reminder_log(
    *,
    keep_per_user: int = REMINDER_LOG_KEEP_PER_USER,
    max_age_sec: float = REMINDER_LOG_MAX_AGE_SEC,
) -> int:
    """Drop old delivery-log rows so the table cannot grow without bound."""
    cutoff = now() - float(max_age_sec)
    removed = 0
    with tx() as conn:
        removed += int(conn.execute("DELETE FROM reminder_log WHERE created_at < ?", (cutoff,)).rowcount or 0)
        removed += int(
            conn.execute(
                """
                DELETE FROM reminder_log
                WHERE id IN (
                    SELECT id FROM (
                        SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY id DESC) AS rn
                        FROM reminder_log
                    ) WHERE rn > ?
                )
                """,
                (int(keep_per_user),),
            ).rowcount
            or 0
        )
    return removed


def list_reminder_log(user_id: int, limit: int = 20) -> list[dict[str, Any]]:
    rows = connection().execute(
        """
        SELECT item_uuid, recipient, status, detail, created_at
        FROM reminder_log
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT ?
        """,
        (user_id, int(limit)),
    ).fetchall()
    return [dict(row) for row in rows]


def item_is_deleted(user_id: int, item_uuid: str) -> bool:
    row = connection().execute(
        "SELECT deleted FROM items WHERE user_id = ? AND item_uuid = ?",
        (user_id, item_uuid),
    ).fetchone()
    if not row:
        return False
    return bool(row["deleted"])


SRP_CHALLENGE_TTL_SECONDS = 300


def prune_srp_challenges(now_ts: float | None = None) -> int:
    ts = float(now_ts if now_ts is not None else time.time())
    with tx() as conn:
        removed = conn.execute("DELETE FROM srp_challenges WHERE expires_at <= ?", (ts,)).rowcount
    return int(removed or 0)


def create_srp_challenge(
    *,
    purpose: str,
    user_id: int,
    email: str,
    state: dict[str, str],
    srp_salt: str = "",
    srp_verifier: str = "",
    ttl_seconds: int = SRP_CHALLENGE_TTL_SECONDS,
) -> str:
    challenge_id = secrets.token_urlsafe(32)
    ts = now()
    expires = ts + float(ttl_seconds)
    prune_srp_challenges(ts)
    with tx() as conn:
        conn.execute(
            """
            INSERT INTO srp_challenges (
                id, purpose, user_id, email, state_json, srp_salt, srp_verifier,
                created_at, expires_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                challenge_id,
                str(purpose),
                int(user_id),
                email.strip().lower(),
                json.dumps(state, separators=(",", ":")),
                str(srp_salt or "").strip().lower(),
                str(srp_verifier or "").strip().lower(),
                ts,
                expires,
            ),
        )
    return challenge_id


def consume_srp_challenge(
    challenge_id: str,
    *,
    purpose: str,
    email: str,
    user_id: int,
    srp_salt: str = "",
    srp_verifier: str = "",
) -> dict[str, str] | None:
    """Load and delete a challenge (single use). Returns private state or None."""
    cid = str(challenge_id or "").strip()
    if not cid:
        return None
    key = email.strip().lower()
    salt_key = str(srp_salt or "").strip().lower()
    verifier_key = str(srp_verifier or "").strip().lower()
    ts = now()
    with tx() as conn:
        row = conn.execute(
            """
            DELETE FROM srp_challenges
            WHERE id = ? AND expires_at > ?
            RETURNING purpose, user_id, email, state_json, srp_salt, srp_verifier
            """,
            (cid, ts),
        ).fetchone()
    if not row:
        return None
    if str(row["purpose"]) != str(purpose):
        return None
    if int(row["user_id"]) != int(user_id):
        return None
    if str(row["email"]).strip().lower() != key:
        return None
    if salt_key and str(row["srp_salt"]).strip().lower() != salt_key:
        return None
    if verifier_key and str(row["srp_verifier"]).strip().lower() != verifier_key:
        return None
    try:
        state = json.loads(str(row["state_json"]))
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(state, dict):
        return None
    return {str(k): str(v) for k, v in state.items()}



# --- D2 Secure Send -----------------------------------------------------------------

def create_secure_send(
    send_id: str,
    sender_user_id: int,
    *,
    ciphertext_len: int,
    max_views: int,
    expires_at: float,
    open_verifier: str = "",
) -> None:
    """Store metadata only — no filename/MIME (those stay in ciphertext/fragment).

    ``open_verifier`` is an HMAC of the client contentKey for passphrase links;
    the server cannot derive it from the fragment alone.
    """
    ts = now()
    verifier = str(open_verifier or "").strip()[:128]
    with tx() as conn:
        conn.execute(
            """
            INSERT INTO secure_sends (
                id, sender_user_id, has_passphrase, has_file, byte_size,
                max_views, views_used, expires_at, created_at, canceled_at, last_opened_at,
                open_verifier, verify_failures
            ) VALUES (?, ?, 0, 0, ?, ?, 0, ?, ?, NULL, NULL, ?, 0)
            """,
            (
                send_id,
                int(sender_user_id),
                int(ciphertext_len),
                int(max_views),
                float(expires_at),
                ts,
                verifier,
            ),
        )


def get_secure_send(send_id: str):
    row = connection().execute(
        "SELECT * FROM secure_sends WHERE id = ?",
        (send_id,),
    ).fetchone()
    return row


def list_secure_sends_for_user(user_id: int, *, limit: int = 100) -> list[dict[str, Any]]:
    from secure_send import blob_path, status_display, status_label

    ts = now()
    rows = connection().execute(
        """
        SELECT * FROM secure_sends
        WHERE sender_user_id = ?
        ORDER BY created_at DESC
        LIMIT ?
        """,
        (int(user_id), max(1, min(500, int(limit)))),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for row in rows:
        sid = str(row["id"])
        has_blob = blob_path(sid).is_file()
        locked_out = None
        try:
            locked_out = float(row["locked_out_at"]) if row["locked_out_at"] else None
        except (KeyError, IndexError, TypeError, ValueError):
            locked_out = None
        status = status_label(
            canceled_at=float(row["canceled_at"]) if row["canceled_at"] else None,
            expires_at=float(row["expires_at"]),
            views_used=int(row["views_used"]),
            max_views=int(row["max_views"]),
            has_blob=has_blob,
            now_ts=ts,
            locked_out_at=locked_out,
        )
        out.append(
            {
                "id": sid,
                "max_views": int(row["max_views"]),
                "views_used": int(row["views_used"]),
                "expires_at": float(row["expires_at"]),
                "created_at": float(row["created_at"]),
                "canceled_at": float(row["canceled_at"]) if row["canceled_at"] else None,
                "locked_out_at": locked_out,
                "last_opened_at": float(row["last_opened_at"]) if row["last_opened_at"] else None,
                "status": status,
                "status_label": status_display(status),
                "requires_passphrase": bool(str(row["open_verifier"] or "").strip()),
            }
        )
    return out


def open_secure_send(
    send_id: str,
    *,
    open_verifier: str = "",
) -> dict[str, Any] | None:
    """Atomically consume one view and return ciphertext. None → treat as 404.

    A view counts only here (explicit Open), never on GET/HEAD of /receive/<id>.
    Passphrase links store an HMAC verifier: wrong guesses do not burn a view;
    after MAX_VERIFY_FAILURES the link is locked_out (not revoked/canceled).
    """
    import hmac as hmac_mod

    from secure_send import MAX_VERIFY_FAILURES, purge_ciphertext, read_ciphertext

    ts = now()
    provided = str(open_verifier or "").strip()
    with tx() as conn:
        row = conn.execute(
            "SELECT * FROM secure_sends WHERE id = ?",
            (send_id,),
        ).fetchone()
        if not row:
            return None
        try:
            if row["locked_out_at"]:
                return None
        except (KeyError, IndexError):
            pass
        if row["canceled_at"]:
            return None
        if float(row["expires_at"]) <= ts:
            purge_ciphertext(send_id)
            return None
        if int(row["views_used"]) >= int(row["max_views"]):
            purge_ciphertext(send_id)
            return None
        stored_verifier = str(row["open_verifier"] or "").strip()
        if stored_verifier:
            failures = int(row["verify_failures"] or 0)
            if failures >= MAX_VERIFY_FAILURES:
                purge_ciphertext(send_id)
                conn.execute(
                    """
                    UPDATE secure_sends
                    SET locked_out_at = COALESCE(locked_out_at, ?)
                    WHERE id = ?
                    """,
                    (ts, send_id),
                )
                return {"error": "stopped", "attempts_left": 0}
            matched = (
                bool(provided)
                and len(provided) == len(stored_verifier)
                and hmac_mod.compare_digest(stored_verifier, provided)
            )
            if not matched:
                failures += 1
                if failures >= MAX_VERIFY_FAILURES:
                    purge_ciphertext(send_id)
                    conn.execute(
                        """
                        UPDATE secure_sends
                        SET verify_failures = ?, locked_out_at = COALESCE(locked_out_at, ?)
                        WHERE id = ?
                        """,
                        (failures, ts, send_id),
                    )
                    return {"error": "stopped", "attempts_left": 0}
                conn.execute(
                    "UPDATE secure_sends SET verify_failures = ? WHERE id = ?",
                    (failures, send_id),
                )
                return {
                    "error": "wrong_passphrase",
                    "attempts_left": max(0, MAX_VERIFY_FAILURES - failures),
                }
        payload = read_ciphertext(send_id)
        if not payload:
            return None
        new_used = int(row["views_used"]) + 1
        conn.execute(
            """
            UPDATE secure_sends
            SET views_used = ?, last_opened_at = ?, verify_failures = 0
            WHERE id = ?
            """,
            (new_used, ts, send_id),
        )
        if new_used >= int(row["max_views"]):
            purge_ciphertext(send_id)
        return {
            "ciphertext": payload,
            "views_remaining": max(0, int(row["max_views"]) - new_used),
        }


def cancel_secure_send(send_id: str, sender_user_id: int) -> bool:
    from secure_send import purge_ciphertext

    ts = now()
    with tx() as conn:
        cur = conn.execute(
            """
            UPDATE secure_sends
            SET canceled_at = COALESCE(canceled_at, ?)
            WHERE id = ? AND sender_user_id = ?
            """,
            (ts, send_id, int(sender_user_id)),
        )
        if cur.rowcount < 1:
            return False
    purge_ciphertext(send_id)
    return True


def prune_secure_sends(now_ts: float | None = None) -> int:
    """Purge ciphertext for expired / canceled / locked-out rows; drop ancient tombstones."""
    from secure_send import purge_ciphertext

    ts = float(now_ts if now_ts is not None else now())
    rows = connection().execute(
        """
        SELECT id FROM secure_sends
        WHERE expires_at <= ? OR canceled_at IS NOT NULL OR locked_out_at IS NOT NULL
           OR views_used >= max_views
        """,
        (ts,),
    ).fetchall()
    for row in rows:
        purge_ciphertext(str(row["id"]))
    # Hard-delete tombstones older than 7 days past expiry.
    cutoff = ts - (7 * 24 * 3600)
    with tx() as conn:
        cur = conn.execute(
            """
            DELETE FROM secure_sends
            WHERE expires_at < ? AND (
                canceled_at IS NOT NULL OR locked_out_at IS NOT NULL
                OR views_used >= max_views OR expires_at <= ?
            )
            """,
            (cutoff, ts),
        )
        return int(cur.rowcount or 0)
