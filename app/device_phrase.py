"""Deterministic memorable phrases for device_id (Round 74).

Maps a stable device id to two short English words so the signed-in devices
list can tell two "iPhone · Chrome" sessions apart without showing a hex
stub. The phrase is derived with SHA-256; it is not a secret and is safe to
show next to the OS · browser label.
"""
from __future__ import annotations

import hashlib

# Exactly 128 family-safe words each (index with digest byte & 0x7F).
_ADJECTIVES = (
    "amber", "ancient", "arctic", "autumn", "azure", "bold", "brave", "bright",
    "brisk", "calm", "cedar", "clear", "clever", "coastal", "cobalt", "copper",
    "coral", "crisp", "crystal", "curious", "dapper", "dawn", "deep", "delta",
    "dusty", "eager", "early", "ember", "fair", "fern", "fierce", "fleet",
    "flint", "floral", "foggy", "forest", "fresh", "frost", "gentle", "gilded",
    "glad", "golden", "grace", "green", "harbor", "hardy", "harvest", "haven",
    "hazel", "hidden", "hollow", "honey", "humble", "ivory", "jade", "keen",
    "kind", "lively", "lucid", "lunar", "maple", "marble", "meadow", "merry",
    "mild", "mint", "misty", "modern", "mossy", "noble", "northern", "olive",
    "opal", "orange", "orchid", "pacific", "pale", "pearl", "pine", "plaid",
    "polar", "proud", "quiet", "radiant", "rapid", "river", "rocky", "rosy",
    "royal", "ruby", "rustic", "sable", "sage", "sandy", "scarlet", "serene",
    "shadow", "sharp", "silent", "silver", "sleek", "solar", "solid", "southern",
    "spring", "steady", "steel", "still", "storm", "summer", "swift", "teal",
    "tidy", "timber", "tiny", "topaz", "true", "twin", "umber", "velvet",
    "vivid", "warm", "wheat", "wild", "winter", "wooden", "yellow", "young",
)

_NOUNS = (
    "acorn", "anchor", "apple", "arrow", "badger", "beacon", "birch", "blossom",
    "boulder", "breeze", "brook", "canyon", "cedar", "cipher", "cliff", "cloud",
    "comet", "compass", "coral", "cove", "crane", "creek", "crest", "crow",
    "crystal", "current", "cypress", "delta", "dove", "drift", "dune", "eagle",
    "echo", "elm", "ember", "falcon", "fern", "field", "finch", "fir",
    "fjord", "flame", "flare", "flint", "forest", "fox", "garden", "glacier",
    "glen", "grove", "harbor", "hawk", "haze", "heath", "heron", "hill",
    "hollow", "iris", "island", "ivory", "jade", "jasper", "keel", "kite",
    "lagoon", "lake", "lark", "leaf", "ledger", "light", "lily", "lotus",
    "maple", "meadow", "mesa", "mirror", "mist", "moon", "moss", "mountain",
    "nest", "oak", "ocean", "olive", "orchid", "otter", "owl", "oxbow",
    "palm", "peak", "pebble", "pine", "plain", "pond", "prairie", "quartz",
    "quill", "raven", "reef", "ridge", "river", "robin", "rock", "rook",
    "sage", "salmon", "sand", "shore", "sierra", "sky", "sparrow", "spring",
    "square", "star", "stone", "stream", "summit", "sun", "swan", "tide",
    "timber", "trail", "tree", "valley", "violet", "wave", "willow", "wind",
)


def device_phrase(device_id: str) -> str:
    """Return ``adjective noun`` for a non-empty device id, else ``\"\"``."""
    raw = str(device_id or "").strip()
    if not raw:
        return ""
    digest = hashlib.sha256(raw.encode("utf-8")).digest()
    adj = _ADJECTIVES[digest[0] & 0x7F]
    noun = _NOUNS[digest[1] & 0x7F]
    return f"{adj} {noun}"
