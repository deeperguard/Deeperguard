"""TOTP two-factor authentication helpers."""
from __future__ import annotations

import base64
import io

import pyotp
import qrcode

ISSUER = "Deeperguard"


def new_secret() -> str:
    return pyotp.random_base32()


def provisioning_uri(secret: str, email: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name=ISSUER)


def verify(secret: str, code: str) -> bool:
    if not secret or not code:
        return False
    clean = "".join(ch for ch in str(code) if ch.isdigit())
    if len(clean) != 6:
        return False
    totp = pyotp.TOTP(secret)
    return bool(totp.verify(clean, valid_window=1))


def qr_png_data_uri(secret: str, email: str) -> str:
    uri = provisioning_uri(secret, email)
    img = qrcode.make(uri)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    encoded = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"
