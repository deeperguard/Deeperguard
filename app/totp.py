"""TOTP two-factor authentication helpers."""
from __future__ import annotations

import base64
import io
import time

import pyotp
import qrcode

ISSUER = "Deeperguard"


def new_secret() -> str:
    return pyotp.random_base32()


def provisioning_uri(secret: str, email: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name=ISSUER)


def current_step(at: float | None = None) -> int:
    return int((time.time() if at is None else float(at)) // 30)


def verify_and_step(secret: str, code: str, *, last_step: int = 0) -> tuple[bool, int]:
    """Verify a TOTP code. Returns (ok, step_used). Rejects reuse of last_step."""
    if not secret or not code:
        return False, 0
    clean = "".join(ch for ch in str(code) if ch.isdigit())
    if len(clean) != 6:
        return False, 0
    totp = pyotp.TOTP(secret)
    now = time.time()
    for offset in (-1, 0, 1):
        step = current_step(now) + offset
        if step <= 0:
            continue
        if int(last_step or 0) and step == int(last_step):
            continue
        expected = totp.at(step * 30)
        if expected == clean:
            return True, step
    return False, 0


def verify(secret: str, code: str, *, last_step: int = 0) -> bool:
    ok, _step = verify_and_step(secret, code, last_step=last_step)
    return ok


def qr_png_data_uri(secret: str, email: str) -> str:
    uri = provisioning_uri(secret, email)
    img = qrcode.make(uri)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    encoded = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"
