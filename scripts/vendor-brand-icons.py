#!/usr/bin/env python3
"""Vendor the 2FA brand icon set (docs/2FA_IMPORT_SPEC.md, section 6).

Writes, from an allow-list of common 2FA issuers:
  app/static/icons/brands/brands.svg   one sprite, <symbol id="si-<slug>"> (24x24, fill=currentColor)
  app/static/icons/brands/brands.json  slug -> {title, hex, aliases}
  app/static/js/totp-brands.js         the same metadata as a classic script (no fetch at runtime)
  app/static/icons/brands/SOURCE.txt   provenance, hash and trademark note

Two modes:
  --tarball simple-icons-14.0.0.tgz --sha256 <hex>
      Real vendoring from the pinned npm tarball (download it yourself, verify, then run).
      Icons whose data entry carries a non-CC0 `license` are excluded.
  --seed
      No tarball available: write our own CC0 monogram badges (brand colour + initials)
      for the same allow-list, so matching, picker and fallback work end to end.
      Re-run with --tarball to replace them with the Simple Icons drawings.

Nothing is fetched by this script. Run scripts/build-client-manifest.py afterwards.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tarfile
from pathlib import Path
from xml.sax.saxutils import escape

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "app" / "static" / "icons" / "brands"
JS_OUT = REPO / "app" / "static" / "js" / "totp-brands.js"
PINNED_VERSION = "14.0.0"

# slug, title, brand hex (Simple Icons), extra aliases (normalised issuer strings / domains).
ALLOW = [
    ("adobe", "Adobe", "FF0000", []),
    ("airbnb", "Airbnb", "FF5A5F", []),
    ("amazon", "Amazon", "FF9900", ["amazon.de", "amazon.nl", "amazon.co.uk"]),
    ("amazonwebservices", "Amazon Web Services", "232F3E", ["aws", "awsconsole"]),
    ("apple", "Apple", "000000", ["appleid", "icloud"]),
    ("atlassian", "Atlassian", "0052CC", ["jira", "confluence"]),
    ("binance", "Binance", "F0B90B", []),
    ("bitbucket", "Bitbucket", "0052CC", []),
    ("bitwarden", "Bitwarden", "175DDC", []),
    ("cloudflare", "Cloudflare", "F38020", []),
    ("coinbase", "Coinbase", "0052FF", []),
    ("digitalocean", "DigitalOcean", "0080FF", []),
    ("discord", "Discord", "5865F2", []),
    ("docker", "Docker", "2496ED", ["dockerhub"]),
    ("dropbox", "Dropbox", "0061FF", []),
    ("ebay", "eBay", "E53238", []),
    ("epicgames", "Epic Games", "313131", ["epic"]),
    ("facebook", "Facebook", "0866FF", ["meta"]),
    ("figma", "Figma", "F24E1E", []),
    ("github", "GitHub", "181717", []),
    ("gitlab", "GitLab", "FC6D26", []),
    ("gmail", "Gmail", "EA4335", []),
    ("google", "Google", "4285F4", ["googleworkspace", "gsuite", "googleaccount"]),
    ("heroku", "Heroku", "430098", []),
    ("hetzner", "Hetzner", "D50C2D", []),
    ("instagram", "Instagram", "E4405F", []),
    ("kraken", "Kraken", "5741D9", []),
    ("linkedin", "LinkedIn", "0A66C2", []),
    ("mailchimp", "Mailchimp", "FFE01B", []),
    ("mastodon", "Mastodon", "6364FF", []),
    ("microsoft", "Microsoft", "5E5E5E", ["microsoftaccount", "outlook", "live", "hotmail", "office365", "microsoft365", "azure"]),
    ("namecheap", "Namecheap", "DE3723", []),
    ("netlify", "Netlify", "00C7B7", []),
    ("nextcloud", "Nextcloud", "0082C9", []),
    ("notion", "Notion", "000000", []),
    ("npm", "npm", "CB3837", ["npmjs"]),
    ("nintendo", "Nintendo", "E60012", ["nintendoaccount"]),
    ("openai", "OpenAI", "412991", ["chatgpt"]),
    ("ovh", "OVH", "123F6D", ["ovhcloud"]),
    ("paypal", "PayPal", "002991", []),
    ("playstation", "PlayStation", "0070D1", ["psn", "sony", "playstationnetwork"]),
    ("protonmail", "Proton Mail", "6D4AFF", ["proton", "protonme"]),
    ("pypi", "PyPI", "3775A9", []),
    ("reddit", "Reddit", "FF4500", []),
    ("salesforce", "Salesforce", "00A1E0", []),
    ("shopify", "Shopify", "7AB55C", []),
    ("slack", "Slack", "4A154B", []),
    ("snapchat", "Snapchat", "FFFC00", []),
    ("steam", "Steam", "000000", ["steampowered"]),
    ("stripe", "Stripe", "635BFF", []),
    ("tiktok", "TikTok", "000000", []),
    ("tumblr", "Tumblr", "36465D", []),
    ("twilio", "Twilio", "F22F46", ["authy"]),
    ("twitch", "Twitch", "9146FF", []),
    ("ubisoft", "Ubisoft", "000000", ["uplay"]),
    ("vercel", "Vercel", "000000", []),
    ("wordpress", "WordPress", "21759B", []),
    ("x", "X", "000000", ["twitter"]),
    ("zoho", "Zoho", "E42527", []),
    ("zoom", "Zoom", "0B5CFF", []),
]

TRADEMARK_NOTE = (
    "Trademarks: the logos are trademarks of their respective owners. They are shown only to\n"
    "identify the account the user added (nominative use), never to suggest endorsement or\n"
    "partnership, and never in our own marketing. On a removal request from a trademark owner\n"
    "the slug is dropped from the allow-list in scripts/vendor-brand-icons.py and the account\n"
    "falls back to the letter avatar.\n"
)


def monogram(title: str) -> str:
    words = [w for w in title.replace("-", " ").split() if w]
    if len(words) >= 2:
        return (words[0][0] + words[1][0]).upper()
    return title[:2].capitalize() if len(title) > 2 else title.upper()


def seed_symbol(slug: str, title: str) -> str:
    text = escape(monogram(title))
    size = 11 if len(text) > 1 else 14
    return (
        f'<symbol id="si-{slug}" viewBox="0 0 24 24"><title>{escape(title)}</title>'
        f'<text x="12" y="12" text-anchor="middle" dominant-baseline="central" '
        f'font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-weight="700" '
        f'font-size="{size}" fill="currentColor">{text}</text></symbol>'
    )


def from_tarball(path: Path, sha256: str):
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != sha256.lower():
        sys.exit(f"sha256 mismatch: {digest}")
    with tarfile.open(path, "r:gz") as tar:
        def read(name):
            member = tar.getmember(name)
            if not member.isfile():
                sys.exit(f"not a file: {name}")
            return tar.extractfile(member).read().decode("utf-8")
        data = json.loads(read("package/_data/simple-icons.json"))
        entries = data["icons"] if isinstance(data, dict) else data
        by_slug = {}
        for e in entries:
            slug = e.get("slug") or e["title"].lower()
            by_slug[slug] = e
        symbols, meta = [], {}
        for slug, title, hexv, aliases in ALLOW:
            e = by_slug.get(slug)
            if not e:
                print(f"skip {slug}: not in set", file=sys.stderr)
                continue
            lic = e.get("license")
            if lic and lic.get("type") != "CC0-1.0":
                print(f"skip {slug}: licence {lic.get('type')}", file=sys.stderr)
                continue
            svg = read(f"package/icons/{slug}.svg")
            start, end = svg.index(' d="') + 4, None
            end = svg.index('"', start)
            d = svg[start:end]
            if any(c in d for c in "<>&\"'"):
                sys.exit(f"unexpected path data in {slug}")
            symbols.append(
                f'<symbol id="si-{slug}" viewBox="0 0 24 24"><title>{escape(e["title"])}</title>'
                f'<path fill="currentColor" d="{d}"/></symbol>'
            )
            meta[slug] = {"title": e["title"], "hex": e.get("hex", hexv).upper(), "aliases": aliases}
    return symbols, meta, f"simple-icons@{PINNED_VERSION} (npm), tarball sha256 {digest}"


def seed():
    symbols, meta = [], {}
    for slug, title, hexv, aliases in ALLOW:
        symbols.append(seed_symbol(slug, title))
        meta[slug] = {"title": title, "hex": hexv, "aliases": aliases}
    return symbols, meta, (
        "SEED SET: monogram badges drawn by this project (CC0-1.0), not the Simple Icons drawings.\n"
        f"Replace by running scripts/vendor-brand-icons.py --tarball simple-icons-{PINNED_VERSION}.tgz --sha256 <hex>"
    )


def write(symbols, meta, provenance):
    OUT.mkdir(parents=True, exist_ok=True)
    sprite = (
        '<svg xmlns="http://www.w3.org/2000/svg" style="display:none">\n'
        + "\n".join(symbols)
        + "\n</svg>\n"
    )
    (OUT / "brands.svg").write_text(sprite, encoding="utf-8")
    body = json.dumps(meta, indent=1, sort_keys=True, ensure_ascii=False)
    (OUT / "brands.json").write_text(body + "\n", encoding="utf-8")
    JS_OUT.write_text(
        "// Generated by scripts/vendor-brand-icons.py. Do not edit by hand.\n"
        "// Brand metadata for 2FA icons (docs/2FA_IMPORT_SPEC.md, section 6).\n"
        f"const NotesTotpBrands = Object.freeze({body});\n\n"
        "if (typeof window !== 'undefined') window.NotesTotpBrands = NotesTotpBrands;\n"
        "if (typeof module !== 'undefined' && module.exports) module.exports = NotesTotpBrands;\n",
        encoding="utf-8",
    )
    (OUT / "SOURCE.txt").write_text(
        "Brand icons for 2FA accounts\n\n"
        f"Source: {provenance}\n"
        "Upstream set: Simple Icons, https://simpleicons.org (CC0-1.0), see LICENSE.txt.\n"
        f"Allow-list: {len(meta)} slugs, see scripts/vendor-brand-icons.py.\n\n"
        + TRADEMARK_NOTE,
        encoding="utf-8",
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--tarball", type=Path)
    g.add_argument("--seed", action="store_true")
    ap.add_argument("--sha256")
    args = ap.parse_args()
    if args.tarball:
        if not args.sha256:
            ap.error("--sha256 is required with --tarball")
        write(*from_tarball(args.tarball, args.sha256))
    else:
        write(*seed())
    print(f"wrote {OUT.relative_to(REPO)} and {JS_OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
