"""Outreach copy and directory metadata for Deeperguard notes promotion."""
from __future__ import annotations

from typing import Any, Dict


def promo_payload(
    *,
    product_name: str,
    public_host: str,
    public_url: str,
    app_path: str,
    contact_email: str,
    billing_note: str,
) -> Dict[str, Any]:
    site = public_url.rstrip("/") + "/"
    app_url = f"{public_url.rstrip('/')}{app_path}"
    register_url = f"{public_url.rstrip('/')}/register"
    promo_url = f"{public_url.rstrip('/')}/api/promo"
    tagline = "Zero-knowledge encrypted notes in your browser — no app store."

    reddit = (
        f"**{product_name}** — encrypted notes that sync, with real zero-knowledge design\n\n"
        f"**Public beta:** new accounts get **Pro free** (5 GB encrypted storage). {billing_note}.\n\n"
        "- Notes and attachments encrypted **in the browser** before upload (AES-GCM)\n"
        "- **SRP sign-in** — we never see your vault password\n"
        "- **Client-side OCR** for scans; plaintext stays on your device\n"
        "- Web app + PWA (add to home screen) — no native app required\n\n"
        f"Homepage: {site}\n"
        f"Open app: {app_url}\n"
        f"Create account: {register_url}\n\n"
        "Looking for feedback from people who care about privacy more than shiny AI features. "
        "Happy to answer technical questions about the crypto model."
    )

    hn_title = f"{product_name} – zero-knowledge encrypted notes (browser PWA, public beta)"
    hn_text = (
        f"We built {product_name} for people who want Standard Notes–style privacy without another app install.\n\n"
        "Notes are encrypted client-side before sync. The server stores ciphertext only. "
        "Authentication uses SRP; optional WebAuthn/passkeys and TOTP.\n\n"
        f"Public beta: Pro tier is free right now ({billing_note.lower()}). "
        f"Site: {site} — app at {app_url}\n\n"
        "Would appreciate feedback on onboarding and whether the compare section matches your expectations."
    )

    discord = (
        f"**{product_name}** — ZK encrypted notes in the browser\n"
        f"Beta: Pro free · client-side encryption · PWA\n"
        f"{site} · app `{app_path}`"
    )

    twitter = (
        f"{product_name}: zero-knowledge encrypted notes in your browser. "
        f"Client-side encryption, SRP login, OCR on-device. Public beta — Pro free. {site}"
    )

    alternativeto_email = (
        f"Subject: Suggest {product_name} as encrypted notes alternative\n\n"
        f"Hi AlternativeTo team,\n\n"
        f"I'd like to suggest {product_name} ({site}) as an alternative in the encrypted notes / "
        f"privacy notes category.\n\n"
        f"- Product: {product_name}\n"
        f"- URL: {site}\n"
        f"- Category: Encrypted notes, zero-knowledge, web/PWA\n"
        f"- Differentiator: true client-side encryption + SRP; no app store required\n"
        f"- Contact: {contact_email}\n"
        f"- Outreach kit (copy for listings): {promo_url}\n\n"
        "Thank you,\n"
        "Deeperguard"
    )

    directories = [
        {
            "name": "Google Search Console",
            "url": "https://search.google.com/search-console",
            "action": f"Add property {public_host}, submit sitemap {site}sitemap.xml",
            "autonomous": False,
        },
        {
            "name": "Bing Webmaster Tools",
            "url": "https://www.bing.com/webmasters",
            "action": f"Add site, submit sitemap, optional IndexNow key at /{public_host} key file",
            "autonomous": False,
        },
        {
            "name": "AlternativeTo",
            "url": "https://alternativeto.net/",
            "action": "Submit product as alternative to Standard Notes / Evernote — use alternativeto_email copy",
            "autonomous": False,
        },
        {
            "name": "Product Hunt",
            "url": "https://www.producthunt.com/posts/new",
            "action": "Launch post when ready — use reddit copy as starting draft",
            "autonomous": False,
        },
        {
            "name": "r/privacy",
            "url": "https://www.reddit.com/r/privacy/submit",
            "action": "Post reddit copy (follow sub rules; disclose beta)",
            "autonomous": False,
        },
        {
            "name": "r/selfhosted",
            "url": "https://www.reddit.com/r/selfhosted/submit",
            "action": "Mention self-host guide at /self-host on the same domain",
            "autonomous": False,
        },
        {
            "name": "Hacker News",
            "url": "https://news.ycombinator.com/submit",
            "action": "Submit with hn_title and hn_text from /api/promo copy",
            "autonomous": False,
        },
        {
            "name": "DeeperGuard Pool cross-link",
            "url": "https://pool.deeperguard.com/",
            "action": "Pool homepage links to notes site (deploy pool static update)",
            "autonomous": True,
        },
    ]

    structured_data = {
        "@context": "https://schema.org",
        "@type": "WebApplication",
        "name": product_name,
        "url": site,
        "applicationCategory": "ProductivityApplication",
        "operatingSystem": "Web",
        "browserRequirements": "Requires a modern browser with Web Crypto",
        "description": (
            "Zero-knowledge encrypted notes that sync across devices. "
            "Notes are encrypted in the browser before upload."
        ),
        "offers": {
            "@type": "Offer",
            "price": "0",
            "priceCurrency": "USD",
            "description": billing_note,
        },
        "featureList": [
            "Client-side AES-GCM encryption",
            "SRP zero-knowledge authentication",
            "Passkeys and TOTP",
            "Client-side OCR",
            "PWA / add to home screen",
        ],
    }

    return {
        "ok": True,
        "product": product_name,
        "website": site,
        "app_url": app_url,
        "register_url": register_url,
        "contact_email": contact_email,
        "tagline": tagline,
        "share": {
            "oneliner": f"{product_name}: {tagline} {site}",
        },
        "copy": {
            "reddit": reddit,
            "discord": discord,
            "twitter": twitter,
            "hacker_news_title": hn_title,
            "hacker_news_text": hn_text,
            "alternativeto_email": alternativeto_email,
        },
        "directories": directories,
        "structured_data": structured_data,
    }
