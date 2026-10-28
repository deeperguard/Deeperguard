"""Public marketing blog — markdown under content/blog with YAML frontmatter."""
from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import format_datetime
from pathlib import Path
from xml.sax.saxutils import escape

from admin_api import render_simple_markdown


@dataclass(frozen=True)
class BlogPost:
    title: str
    slug: str
    date: datetime
    description: str
    body_md: str
    draft: bool = False
    cover_image: str = ""
    cover_alt: str = ""

    @property
    def body_html(self) -> str:
        return render_simple_markdown(self.body_md)

    @property
    def iso_date(self) -> str:
        return self.date.date().isoformat()

    @property
    def rfc822_date(self) -> str:
        dt = self.date if self.date.tzinfo else self.date.replace(tzinfo=timezone.utc)
        return format_datetime(dt, usegmt=True)


def blog_content_dir() -> Path:
    override = (os.environ.get("NOTES_BLOG_DIR") or "").strip()
    if override:
        return Path(override)
    return Path(__file__).resolve().parent.parent / "content" / "blog"


def _parse_frontmatter(raw: str) -> tuple[dict[str, str], str]:
    text = str(raw or "")
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    block = text[3:end].strip("\n")
    body = text[end + 4 :].lstrip("\n")
    meta: dict[str, str] = {}
    for line in block.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, sep, val = line.partition(":")
        if not sep:
            continue
        meta[key.strip()] = val.strip().strip('"').strip("'")
    return meta, body


def _parse_bool(value: str | None) -> bool:
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _parse_date(value: str, fallback_path: Path) -> datetime:
    raw = (value or "").strip()
    if raw:
        try:
            if "T" in raw:
                dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            else:
                dt = datetime.fromisoformat(raw)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            pass
    mtime = fallback_path.stat().st_mtime
    return datetime.fromtimestamp(mtime, tz=timezone.utc)


def _slug_from_filename(path: Path) -> str:
    return path.stem


def load_all_posts() -> list[BlogPost]:
    root = blog_content_dir()
    if not root.is_dir():
        return []
    posts: list[BlogPost] = []
    for path in sorted(root.glob("*.md")):
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError:
            continue
        meta, body = _parse_frontmatter(raw)
        slug = (meta.get("slug") or _slug_from_filename(path)).strip()
        title = (meta.get("title") or slug.replace("-", " ").title()).strip()
        if not slug or not title:
            continue
        posts.append(
            BlogPost(
                title=title,
                slug=slug,
                date=_parse_date(meta.get("date", ""), path),
                description=(meta.get("description") or "").strip(),
                body_md=body,
                draft=_parse_bool(meta.get("draft")),
                cover_image=(meta.get("cover_image") or meta.get("cover") or "").strip(),
                cover_alt=(meta.get("cover_alt") or meta.get("cover_image_alt") or "").strip(),
            )
        )
    posts.sort(key=lambda p: p.date, reverse=True)
    return posts


def show_drafts() -> bool:
    return str(os.environ.get("NOTES_BLOG_SHOW_DRAFTS", "")).strip().lower() in {"1", "true", "yes", "on"}


def listed_posts() -> list[BlogPost]:
    """Posts that are published (draft false/absent), newest first."""
    return [p for p in load_all_posts() if not p.draft]


def published_posts() -> list[BlogPost]:
    """Posts shown on /blog — published only unless NOTES_BLOG_SHOW_DRAFTS=1."""
    if show_drafts():
        return load_all_posts()
    return listed_posts()


def get_post(slug: str) -> BlogPost | None:
    needle = (slug or "").strip().lower()
    if not needle:
        return None
    for post in load_all_posts():
        if post.slug.lower() == needle:
            return post
    return None


def get_published_post(slug: str) -> BlogPost | None:
    post = get_post(slug)
    if not post:
        return None
    if post.draft and not show_drafts():
        return None
    return post


def rss_xml(site_base: str, posts: list[BlogPost]) -> str:
    base = site_base.rstrip("/")
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
        "  <channel>",
        "    <title>Deeperguard Blog</title>",
        f"    <link>{escape(base)}/blog</link>",
        "    <description>How-tos and privacy notes for Deeperguard encrypted notes.</description>",
        f'    <atom:link href="{escape(base)}/blog/feed.xml" rel="self" type="application/rss+xml"/>',
    ]
    for post in posts:
        link = f"{base}/blog/{post.slug}"
        lines.extend(
            [
                "    <item>",
                f"      <title>{escape(post.title)}</title>",
                f"      <link>{escape(link)}</link>",
                f"      <guid isPermaLink=\"true\">{escape(link)}</guid>",
                f"      <pubDate>{escape(post.rfc822_date)}</pubDate>",
            ]
        )
        if post.description:
            lines.append(f"      <description>{escape(post.description)}</description>")
        lines.append("    </item>")
    lines.extend(["  </channel>", "</rss>"])
    return "\n".join(lines) + "\n"
