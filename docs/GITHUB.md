# Publishing Deeperguard on GitHub

This guide walks you through creating a GitHub account, choosing a name, and pushing this repository.

## 1. Create a GitHub account

1. Go to [https://github.com/signup](https://github.com/signup)
2. Enter your email, choose a password, and pick a username (this is public — see naming below)
3. Verify your email address
4. Enable **two-factor authentication** (Settings → Password and authentication → Two-factor authentication)

Use a personal email you control. GitHub is free for public repositories.

## 2. Naming recommendations

You need two names: your **GitHub username** (or organization) and the **repository name**.

### Repository name (pick one)

| Name | Pros | Best for |
|------|------|----------|
| **deeperguard** | Clear, descriptive, matches the project | Self-hosters who know what they want |
| **zk-notes** | Short, highlights zero-knowledge | Privacy-focused branding |
| **sealed-notes** | Memorable product feel | If you want a “product” name |
| **lantern-notes** | Distinct, warm metaphor | Stand out from “yet another notes app” |

**Recommendation:** keep **`deeperguard`** as the repo name. It is honest about the audience (people who self-host) and matches the codebase. You can add a display title in the repo description, e.g. “Zero-knowledge encrypted notes for your homelab”.

### GitHub username / organization

- **Personal:** `yourname/deeperguard` — simplest to start
- **Organization:** create `deeperguard` or `zk-notes` org later if you want multiple related repos

Avoid names that imply you are Standard Notes or another product.

### Topics (after publish)

On the repo page → **About** → add topics:

`encrypted-notes` `zero-knowledge` `self-hosted` `flask` `pwa` `e2e-encryption` `homelab`

### Description (example)

> Self-hosted zero-knowledge encrypted notes. SRP login, client-side OCR, offline PWA — stricter privacy than cloud note apps when you run your own server.

## 3. Pre-push checklist

Run these **before** making the repo public:

```bash
cd deeperguard

# No secrets in tree
git grep -iE 'password|secret|api_key|token' -- ':!venv' ':!tests' ':!*.example' ':!SECURITY.md' ':!CONTRIBUTING.md'

# Ignored paths must not be tracked
git ls-files keys data venv .env

# Run tests
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
./venv/bin/python -m unittest discover -s tests -p 'test_*.py' -q
for f in tests/test_*.js; do node "$f"; done
```

Confirm:

- [ ] `keys/`, `data/`, `venv/`, `.env` are **not** committed (see `.gitignore`)
- [ ] `config/deeperguard.env` on your server is **not** in git (only `deploy/deeperguard.env.example`)
- [ ] No personal email, home IP, or internal hostnames in committed files
- [ ] Production server still uses your private `deeperguard.env` with real SMTP

## 4. Create the repository on GitHub

1. Log in → **+** → **New repository**
2. Name: `deeperguard` (or your chosen name)
3. Description: paste from above
4. Visibility: **Public**
5. Do **not** initialize with README (you already have one)
6. Click **Create repository**

## 5. Push this code

### Standalone repository (recommended)

Publish only the `deeperguard/` directory as its own GitHub repo:

```bash
cd deeperguard
git init
git add .
git commit -m "Initial public release"
git branch -M main
git remote add origin git@github.com:YOUR_USERNAME/deeperguard.git
git push -u origin main
```

Your private homelab meta repo can keep using its existing remote; GitHub gets a standalone copy.

### Alternative: subtree from monorepo

If you prefer to push from the parent homelab repo, use `git subtree split` or export a clean tarball — avoid publishing unrelated projects in the same repo.

## 6. After publishing

1. **Settings → General → Features** — enable Issues; disable Wikis if unused
2. Add **LICENSE** (already AGPL-3.0 in repo root)
3. Pin the repo on your profile if you want visibility
4. Add a link to `docs/PRIVACY.md` in the repo About section or README
5. Optional: **Settings → Actions** — allow GitHub Actions (CI runs tests on push)

## 7. Relationship to your private homelab

- GitHub = **public source code**
- Your server = **private data** (`data/`, `keys/`, real `.env`)
- Deploy with `bash deploy/deploy-deeperguard.sh` from your private clone or pull from GitHub on the server

Never commit production secrets. Rotate anything that was ever in git history before publishing.

## 8. License note

This project uses **AGPL-3.0** (same family as Standard Notes). Network users of a modified version must be able to obtain the corresponding source. If you prefer MIT for maximum reuse, change `LICENSE` and file headers before the first public push.

## Questions?

Open a Discussion on GitHub once the repo is live, or keep using your private homelab workflow for production issues.
