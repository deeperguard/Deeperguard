"""Paths and settings. Secrets stay in keys/, not git."""
from __future__ import annotations

import ipaddress
import os
import re
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent


def _load_env_file(path: Path) -> None:
    """Load KEY=VALUE lines into os.environ when unset (cron/CLI have no systemd EnvironmentFile)."""
    if not path.is_file():
        return
    try:
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if not key or key in os.environ:
                continue
            os.environ[key] = value.strip().strip('"').strip("'")
    except OSError:
        pass


def _bootstrap_notes_env() -> None:
    """Load config/*.env for cron/CLI when systemd EnvironmentFile is not present."""
    if os.environ.get("NOTES_ROOT"):
        root = Path(os.environ["NOTES_ROOT"])
        for name in ("deeperguard.env", "homelab-notes.env"):
            _load_env_file(root / "config" / name)
        return
    for candidate in (Path("/opt/homelab-notes"), Path("/opt/deeperguard")):
        for name in ("homelab-notes.env", "deeperguard.env"):
            _load_env_file(candidate / "config" / name)
        if os.environ.get("NOTES_ROOT"):
            return


_bootstrap_notes_env()
ROOT = Path(os.environ.get("NOTES_ROOT", "/opt/deeperguard"))
for _env_name in ("deeperguard.env", "homelab-notes.env"):
    _load_env_file(ROOT / "config" / _env_name)
DATA_DIR = Path(os.environ.get("NOTES_DATA", str(ROOT / "data")))
KEYS_DIR = Path(os.environ.get("NOTES_KEYS", str(ROOT / "keys")))

ALLOWED_CIDRS = [
    part.strip()
    for part in os.environ.get(
        "NOTES_ALLOWED_CIDRS",
        "192.168.1.0/24,10.0.0.0/24",
    ).split(",")
    if part.strip()
]

SMTP_HOST = os.environ.get("NOTES_SMTP_HOST", "localhost").strip()
SMTP_PORT = int(os.environ.get("NOTES_SMTP_PORT", "25"))
SMTP_FROM = os.environ.get("NOTES_SMTP_FROM", "notes@deeperguard.com").strip()
SMTP_USER = os.environ.get("NOTES_SMTP_USER", "").strip()
SMTP_PASS = os.environ.get("NOTES_SMTP_PASS", "").strip()
SMTP_TLS = os.environ.get("NOTES_SMTP_TLS", "0") == "1"
CONTACT_EMAIL = os.environ.get("NOTES_CONTACT_EMAIL", "notes@deeperguard.com").strip() or "notes@deeperguard.com"

SESSION_SECONDS = int(os.environ.get("NOTES_SESSION_SECONDS", str(30 * 24 * 60 * 60)))
BACKUP_CRON_HOUR = int(os.environ.get("NOTES_BACKUP_CRON_HOUR", "3"))
NOTES_PUBLIC_HOST = os.environ.get("NOTES_PUBLIC_HOST", "www.deeperguard.com").strip() or "www.deeperguard.com"
NOTES_PUBLIC_URL = (
    os.environ.get("NOTES_PUBLIC_URL", "").strip()
    or f"https://{NOTES_PUBLIC_HOST}"
)
INDEXNOW_KEY = os.environ.get("NOTES_INDEXNOW_KEY", "deeperguard-notes-indexnow-8f3a").strip()


def app_entry_path() -> str:
    """URL path for the encrypted notes PWA (marketing site lives at /)."""
    raw = os.environ.get("NOTES_APP_PATH", "/app").strip() or "/app"
    return raw if raw.startswith("/") else f"/{raw}"


def skip_login() -> bool:
    """Account login is on unless NOTES_SKIP_LOGIN=1 is set explicitly."""
    return os.environ.get("NOTES_SKIP_LOGIN", "0") == "1"


def ocr_ephemeral() -> bool:
    """OCR plaintext is not persisted on disk unless NOTES_OCR_EPHEMERAL=0."""
    return os.environ.get("NOTES_OCR_EPHEMERAL", "1") == "1"


def server_ocr_enabled() -> bool:
    """Legacy server-side OCR (plaintext on server). Disabled by default — use client OCR."""
    return os.environ.get("NOTES_SERVER_OCR", "0") == "1"


_server_ocr_startup_warned = False


def log_server_ocr_startup_warning() -> None:
    """Log once per process when legacy server-side OCR is enabled (security review)."""
    global _server_ocr_startup_warned
    if _server_ocr_startup_warned or not server_ocr_enabled():
        return
    _server_ocr_startup_warned = True
    import logging

    log = logging.getLogger("deeperguard")
    wan_exposed = not cidr_gate_enabled()
    if wan_exposed:
        log.warning(
            "NOTES_SERVER_OCR is enabled while the app is WAN-exposed "
            "(NOTES_DISABLE_CIDR_GATE=1): server-side OCR processes decrypted document "
            "plaintext on the server. Zero-knowledge guarantees do not apply to OCR'd documents."
        )
    else:
        log.warning(
            "NOTES_SERVER_OCR is enabled: server-side OCR processes decrypted document "
            "plaintext on the server. Zero-knowledge guarantees do not apply to OCR'd documents."
        )
    if not ocr_ephemeral():
        log.warning(
            "NOTES_OCR_EPHEMERAL is off: OCR plaintext and search indexes are persisted on disk "
            "under NOTES_DATA."
        )


_wan_secure_cookies_startup_warned = False


def secure_cookies_enabled() -> bool:
    return os.environ.get("NOTES_SECURE_COOKIES", "0") == "1"


def log_wan_secure_cookies_startup_warning() -> None:
    """Log once per process when WAN is open without Secure cookies / HSTS (security review M-2)."""
    global _wan_secure_cookies_startup_warned
    if _wan_secure_cookies_startup_warned:
        return
    if cidr_gate_enabled() or secure_cookies_enabled():
        return
    _wan_secure_cookies_startup_warned = True
    import logging

    log = logging.getLogger("deeperguard")
    log.warning(
        "NOTES_DISABLE_CIDR_GATE=1 but NOTES_SECURE_COOKIES is not 1: session cookies may be sent "
        "without the Secure flag and Strict-Transport-Security is not enabled (HSTS off). "
        "For WAN or Cloudflare-tunnel deployments over HTTPS, set NOTES_SECURE_COOKIES=1."
    )


def strict_zk() -> bool:
    """When true, vault passwords are never sent to the server for verification."""
    return os.environ.get("NOTES_STRICT_ZK", "1") == "1"


def repair_login_password_enabled() -> bool:
    """When true, repair-login may accept plaintext passwords (legacy migration only)."""
    return os.environ.get("NOTES_REPAIR_LOGIN_PASSWORD", "0") == "1"


def allow_register() -> bool:
    return os.environ.get("NOTES_ALLOW_REGISTER", "1") == "1"


def min_password_length() -> int:
    try:
        return max(12, int(os.environ.get("NOTES_MIN_PASSWORD_LENGTH", "12")))
    except (TypeError, ValueError):
        return 12


def default_user_quota_bytes() -> int:
    """Default storage cap for newly registered accounts (100 MB)."""
    try:
        mb = int(os.environ.get("NOTES_DEFAULT_USER_QUOTA_MB", "100"))
        return max(1, mb) * 1024 * 1024
    except (TypeError, ValueError):
        return 100 * 1024 * 1024


def admin_emails() -> set[str]:
    raw = os.environ.get("NOTES_ADMIN_EMAILS", "").strip()
    if not raw:
        return set()
    return {part.strip().lower() for part in raw.split(",") if part.strip()}


def user_is_admin(user) -> bool:
    flags = user_admin_flags(user)
    return bool(flags["is_admin"])


def user_is_admin_email(email: str) -> bool:
    return email.strip().lower() in admin_emails()


def user_admin_flags(user) -> dict[str, bool]:
    db_flag = False
    try:
        db_flag = bool(int(user["is_admin"] or 0))
    except (KeyError, TypeError, ValueError):
        pass
    try:
        email = str(user["email"] or "").strip().lower()
    except (KeyError, TypeError):
        email = ""
    env_flag = email in admin_emails() if email else False
    return {
        "is_admin_db": db_flag,
        "is_admin_env": env_flag,
        "is_admin": db_flag or env_flag,
        "admin_env_locked": env_flag,
    }


def max_storage_quota_bytes() -> int:
    """Upper bound admins may assign (default 1 TB)."""
    try:
        mb = int(os.environ.get("NOTES_MAX_USER_QUOTA_MB", "1048576"))
        return max(1, mb) * 1024 * 1024
    except (TypeError, ValueError):
        return 1024 * 1024 * 1024 * 1024


def quota_bytes_from_mb(mb: int) -> int:
    if mb <= 0:
        return 0
    return min(int(mb) * 1024 * 1024, max_storage_quota_bytes())


def cidr_gate_enabled() -> bool:
    return os.environ.get("NOTES_DISABLE_CIDR_GATE", "0") != "1"


def trust_proxy_hops() -> int:
    try:
        return max(0, int(os.environ.get("NOTES_TRUST_PROXY_HOPS", "0")))
    except (TypeError, ValueError):
        return 0


def flask_secret_path() -> Path:
    return KEYS_DIR / "flask-secret"


def smtp_password_path() -> Path:
    return KEYS_DIR / "smtp-password"


def read_secret(path: Path) -> str:
    if not path.is_file():
        return ""
    return path.read_text(encoding="utf-8").strip()


def flask_secret() -> str:
    return os.environ.get("NOTES_FLASK_SECRET", "").strip() or read_secret(flask_secret_path())


def ensure_flask_secret() -> str:
    """Stable signing key for session cookies (persisted under NOTES_KEYS)."""
    env = os.environ.get("NOTES_FLASK_SECRET", "").strip()
    if env:
        return env
    existing = read_secret(flask_secret_path())
    if existing:
        return existing
    import secrets

    path = flask_secret_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    secret = secrets.token_hex(32)
    path.write_text(secret, encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    import logging

    logging.getLogger("deeperguard").warning("Generated new flask signing key at %s", path)
    return secret


def smtp_password() -> str:
    return SMTP_PASS or read_secret(smtp_password_path())


def pcloud_password_path(user_id: int) -> Path:
    return KEYS_DIR / f"pcloud-password-{int(user_id)}"


def pcloud_rclone_config_path(user_id: int) -> Path:
    return KEYS_DIR / f"pcloud-rclone-{int(user_id)}.conf"


def write_pcloud_password(user_id: int, password: str) -> None:
    path = pcloud_password_path(user_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(password.strip(), encoding="utf-8")
    path.chmod(0o600)


def pcloud_password(user_id: int) -> str:
    return read_secret(pcloud_password_path(user_id))


def pcloud_password_set(user_id: int) -> bool:
    return bool(pcloud_password(user_id))


def pcloud_token_path(user_id: int) -> Path:
    return KEYS_DIR / f"pcloud-token-{int(user_id)}"


def write_pcloud_token(user_id: int, token_json: str) -> None:
    path = pcloud_token_path(user_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(token_json.strip(), encoding="utf-8")
    path.chmod(0o600)


def pcloud_token(user_id: int) -> str:
    return read_secret(pcloud_token_path(user_id))


def pcloud_token_set(user_id: int) -> bool:
    return bool(pcloud_token(user_id))


_HOSTNAME_RE = re.compile(
    r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$"
)


def normalize_host(host: str) -> str:
    return (host or "").split(":", 1)[0].strip().lower().strip("[]")


def is_ip_host(host: str) -> bool:
    value = normalize_host(host)
    if not value:
        return False
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


def webauthn_default_rp_id() -> str:
    candidate = normalize_host(os.environ.get("NOTES_WEBAUTHN_RP_ID", "deeperguard.com"))
    if candidate and not is_ip_host(candidate) and _HOSTNAME_RE.fullmatch(candidate):
        return candidate
    return "deeperguard.com"


def webauthn_preferred_host() -> str:
    """Hostname users should open in the browser (must not be an IP)."""
    for key in ("NOTES_PUBLIC_HOST", "NOTES_WEBAUTHN_RP_ID"):
        candidate = normalize_host(os.environ.get(key, ""))
        if candidate and not is_ip_host(candidate) and _HOSTNAME_RE.fullmatch(candidate):
            return candidate
    return "www.deeperguard.com"


def passkey_host_ok(host: str) -> bool:
    value = normalize_host(host)
    if not value or is_ip_host(value) or not _HOSTNAME_RE.fullmatch(value):
        return False
    rp_id = webauthn_default_rp_id()
    return value == rp_id or value.endswith("." + rp_id)


def webauthn_rp_id(request_host: str) -> str:
    host = normalize_host(request_host)
    if passkey_host_ok(host):
        return webauthn_default_rp_id()
    return webauthn_default_rp_id()


def session_cookie_domain() -> str | None:
    """Return the cookie domain for sharing sessions across subdomains (.deeperguard.com).
    Returns None for localhost / IP hosts.
    """
    raw = os.environ.get("NOTES_COOKIE_DOMAIN", "").strip()
    if raw:
        return raw if raw.startswith(".") else f".{raw}"
    rp_id = webauthn_default_rp_id()
    if rp_id and not is_ip_host(rp_id) and "." in rp_id:
        return f".{rp_id}"
    return None
