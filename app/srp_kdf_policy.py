"""SRP login KDF policy knobs (H1). v1 is not hard-refused yet."""

# TODO(security): after this UTC instant, consider refusing srp_kdf_version 1 challenges.
SRP_KDF_V1_SUNSET_UTC = "2026-12-01T00:00:00Z"
