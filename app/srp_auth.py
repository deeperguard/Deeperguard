"""Thinbus-compatible SRP-6a (SHA-256, RFC 5054 2048-bit) for zero-knowledge login."""
from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from typing import Any

# RFC 5054 2048-bit group (matches thinbus-srp defaults).
N = int(
    "217661744586174357731910088918027537819076683742555385111446432246898862353838"
    "409572109090130860564015713997172358072665816496064721484102914133641521973644771"
    "808873956554837381150726774022351017625219015698207402931495296204193332662620734"
    "710545483687360395197024862265062488610602569718029849535611214426801576680007614"
    "299882224570904138739739701719270939921147517651680636147611196154762334220964427"
    "831179712363716473338714143358957734746673089670508070055093204247996784170368679"
    "283167612722742303140675482911335824795830614395775593471019617714061736843785227"
    "03483495337037655006751328447510550299250924469288819"
)
G = 2
K = int("5b9e8ef059c6b32ea59fc1d322d37f04aa30bae5aa9003b8321e21ddb04e300", 16)


def _h(data: str) -> str:
    out = hashlib.sha256(data.encode("utf-8")).hexdigest().lower()
    while out.startswith("0"):
        out = out[1:]
    return out


def _from_hex(value: str) -> int:
    return int(value, 16)


def _to_hex(value: int) -> str:
    return format(value, "x")


def _strip_hex(value: str) -> str:
    out = value.lower()
    while out.startswith("0"):
        out = out[1:]
    return out


def _client_hex_int(value: str) -> int:
    """Parse client-supplied lowercase hex or raise bad client credentials."""
    s = str(value or "").strip().lower()
    if not s or not all(c in "0123456789abcdef" for c in s):
        raise ValueError("bad client credentials")
    return int(s, 16)


def _random_nonzero_mod_n() -> int:
    n_hex_len = len(_to_hex(N))
    while True:
        raw = secrets.token_hex((n_hex_len + 1) // 2)
        value = _from_hex(raw) % N
        if value != 0:
            return value


@dataclass
class SrpServerSession:
    identity: str = ""
    salt_hex: str = ""
    verifier_hex: str = ""
    b: int = 0
    B: int = 0
    S: int = 0
    state: int = 0

    def to_private_state(self) -> dict[str, str]:
        return {
            "I": self.identity,
            "v": _to_hex(_from_hex(self.verifier_hex)),
            "s": _to_hex(_from_hex(self.salt_hex)),
            "b": _to_hex(self.b),
        }

    @classmethod
    def from_private_state(cls, data: dict[str, Any]) -> SrpServerSession:
        sess = cls(
            identity=str(data.get("I") or ""),
            salt_hex=str(data.get("s") or ""),
            verifier_hex=str(data.get("v") or ""),
            b=_from_hex(str(data.get("b") or "0")),
            state=1,
        )
        v = _from_hex(sess.verifier_hex)
        sess.B = (pow(G, sess.b, N) + (K * v) % N) % N
        return sess

    def step1(self, identity: str, salt_hex: str, verifier_hex: str) -> str:
        if not identity or not salt_hex or not verifier_hex:
            raise ValueError("missing srp parameters")
        self.identity = identity
        self.salt_hex = salt_hex.lower()
        self.verifier_hex = verifier_hex.lower()
        v = _from_hex(self.verifier_hex)
        self.b = _random_nonzero_mod_n()
        self.B = (pow(G, self.b, N) + (K * v) % N) % N
        if self.B % N == 0:
            raise ValueError("invalid server public value")
        self.state = 1
        return _to_hex(self.B)

    def step2(self, a_hex: str, m1_client: str) -> str:
        if self.state != 1:
            raise ValueError("srp session not ready")
        a_hex = str(a_hex or "").strip().lower()
        m1_client = str(m1_client or "").strip().lower()
        if not m1_client:
            raise ValueError("bad client credentials")
        try:
            a_val = _client_hex_int(a_hex)
        except ValueError:
            raise ValueError("bad client credentials") from None
        if a_val % N == 0:
            raise ValueError("bad client credentials")
        b_hex = _to_hex(self.B)
        u_hex = _h(a_hex + b_hex)
        if not u_hex:
            raise ValueError("bad client credentials")
        u = _from_hex(u_hex)
        if u == 0:
            raise ValueError("bad client credentials")
        v = _from_hex(self.verifier_hex)
        S = pow((pow(v, u, N) * a_val) % N, self.b, N)
        s_hex = _to_hex(S)
        m1_expected = _strip_hex(_h(a_hex + b_hex + s_hex))
        m1_norm = _strip_hex(m1_client)
        if not hmac.compare_digest(m1_norm, m1_expected):
            raise ValueError("bad client credentials")
        self.S = S
        m2 = _strip_hex(_h(_to_hex(a_val) + m1_expected + s_hex))
        self.state = 2
        return m2


def new_srp_salt_hex() -> str:
    """Client-compatible random salt (thinbus generateRandomSalt without server salt)."""
    seed = secrets.token_hex(16)
    return _h(f"{secrets.randbits(53)}::{seed}")


def generate_verifier_hex(salt_hex: str, identity: str, password: str) -> str:
    """Thinbus-compatible verifier for admin scripts and tests."""
    identity = str(identity or "").strip().lower()
    salt_hex = str(salt_hex or "").strip().lower()
    hash1 = _h(f"{identity}:{password}")
    x_hash = _h(f"{salt_hex}{hash1}".upper())
    x = _from_hex(x_hash) % N
    return _to_hex(pow(G, x, N))
