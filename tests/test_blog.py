"""Public /blog markdown surface."""
import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1] / "app"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

REPO = Path(__file__).resolve().parents[1]


class BlogPublicTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "130.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "192"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_DEFAULT_PLAN"] = "pro"
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("test-secret", encoding="utf-8")

        blog_dir = root / "blog-content"
        blog_dir.mkdir()
        os.environ["NOTES_BLOG_DIR"] = str(blog_dir)
        (blog_dir / "draft-only.md").write_text(
            """---
title: Draft post
slug: draft-only
date: 2026-01-01
description: Should not be public
draft: true
---

Secret draft body.
""",
            encoding="utf-8",
        )
        (blog_dir / "hello-world.md").write_text(
            """---
title: Hello blog test
slug: hello-world
date: 2026-02-15
description: Published fixture for tests
cover_image: /static/blog/secure-send-cover.svg
cover_alt: Test cover alt text
draft: false
---

## Subhead

Published **fixture** content.
""",
            encoding="utf-8",
        )

        for name in list(sys.modules):
            if name in {
                "app",
                "auth",
                "db",
                "config",
                "admin_api",
                "blog",
            } or name.startswith("app."):
                sys.modules.pop(name, None)
        self.app_mod = importlib.import_module("app")
        self.client = self.app_mod.app.test_client()

    def tearDown(self):
        self.tmp.cleanup()
        for key in (
            "NOTES_ROOT",
            "NOTES_DATA",
            "NOTES_KEYS",
            "NOTES_ALLOWED_CIDRS",
            "NOTES_SKIP_LOGIN",
            "NOTES_BUILD",
            "NOTES_SERVER_INFO_REFRESH",
            "NOTES_STRICT_ZK",
            "NOTES_DEFAULT_PLAN",
            "NOTES_BLOG_DIR",
            "NOTES_BLOG_SHOW_DRAFTS",
        ):
            os.environ.pop(key, None)

    def test_blog_index_is_public(self):
        res = self.client.get("/blog")
        self.assertEqual(res.status_code, 200)
        body = res.get_data(as_text=True)
        self.assertIn("Hello blog test", body)
        self.assertNotIn("Draft post", body)
        self.assertIn('href="/blog/hello-world"', body)
        self.assertIn('rel="canonical"', body)

    def test_blog_trailing_slashes_redirect_to_canonical(self):
        index = self.client.get("/blog/", follow_redirects=False)
        self.assertEqual(index.status_code, 301)
        self.assertEqual(index.headers["Location"], "/blog")
        post = self.client.get("/blog/hello-world/", follow_redirects=False)
        self.assertEqual(post.status_code, 301)
        self.assertEqual(post.headers["Location"], "/blog/hello-world")
        feed = self.client.get("/blog/feed.xml/", follow_redirects=False)
        self.assertEqual(feed.status_code, 301)
        self.assertEqual(feed.headers["Location"], "/blog/feed.xml")
        with_qs = self.client.get("/blog/?utm=1", follow_redirects=False)
        self.assertEqual(with_qs.status_code, 301)
        self.assertEqual(with_qs.headers["Location"], "/blog?utm=1")
        follow = self.client.get("/blog/", follow_redirects=True)
        self.assertEqual(follow.status_code, 200)
        self.assertIn("Hello blog test", follow.get_data(as_text=True))

    def test_draft_post_returns_404(self):
        res = self.client.get("/blog/draft-only")
        self.assertEqual(res.status_code, 404)

    def test_published_post_renders(self):
        res = self.client.get("/blog/hello-world")
        self.assertEqual(res.status_code, 200)
        body = res.get_data(as_text=True)
        self.assertIn("Hello blog test", body)
        self.assertIn("Published <strong>fixture</strong> content.", body)
        self.assertIn('alt="Test cover alt text"', body)
        self.assertIn('href="https://', body)  # canonical absolute URL

    def test_feed_lists_published_only(self):
        res = self.client.get("/blog/feed.xml")
        self.assertEqual(res.status_code, 200)
        body = res.get_data(as_text=True)
        self.assertIn("<rss", body)
        self.assertIn("hello-world", body)
        self.assertNotIn("draft-only", body)

    def test_repo_sample_draft_preview_with_env(self):
        os.environ["NOTES_BLOG_SHOW_DRAFTS"] = "1"
        for name in list(sys.modules):
            if name in {"app", "blog", "admin_api"}:
                sys.modules.pop(name, None)
        os.environ.pop("NOTES_BLOG_DIR", None)
        app_mod = importlib.import_module("app")
        client = app_mod.app.test_client()
        res = client.get("/blog/what-secure-send-encrypts-in-the-browser")
        self.assertEqual(res.status_code, 200)
        body = res.get_data(as_text=True)
        self.assertIn("Secure Send encrypts", body)
        self.assertIn("Draft preview", body)

    def test_repo_sample_draft_not_listed_without_override(self):
        """Shipped sample post stays draft until Marketing publishes it."""
        for name in list(sys.modules):
            if name in {"app", "blog", "admin_api"}:
                sys.modules.pop(name, None)
        os.environ.pop("NOTES_BLOG_DIR", None)
        app_mod = importlib.import_module("app")
        client = app_mod.app.test_client()
        res = client.get("/blog/what-secure-send-encrypts-in-the-browser")
        self.assertEqual(res.status_code, 404)
        index = client.get("/blog")
        self.assertEqual(index.status_code, 200)
        self.assertNotIn(b"What Secure Send encrypts", index.data)


if __name__ == "__main__":
    unittest.main()
