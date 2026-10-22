"""Thinbus-compatible SRP-6a client proof for tests (password stays in-process)."""
from __future__ import annotations

import secrets


def srp_client_proof(email: str, password: str, salt: str, b_hex: str, kdf_version: int):
    from srp_auth import G, K, N, _from_hex, _h, _to_hex, generate_x, normalize_srp_kdf_version

    salt = str(salt).lower()
    b_hex = str(b_hex).lower()
    version = normalize_srp_kdf_version(kdf_version)
    x = generate_x(salt, email, password, kdf_version=version)
    byte_len = (N.bit_length() + 7) // 8
    while True:
        a = int.from_bytes(secrets.token_bytes(byte_len), "big") % N
        if a:
            break
    a_hex = _to_hex(pow(G, a, N))
    u = _from_hex(_h(a_hex + b_hex))
    B = _from_hex(b_hex)
    v = pow(G, x, N)
    S = pow((B - (v * K) % N + N) % N, (u * x + a) % N, N)
    m1 = _h(a_hex + b_hex + _to_hex(S))
    return a_hex, m1
