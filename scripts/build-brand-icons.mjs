#!/usr/bin/env node
// Builds app/static/icons/brands/{brands.svg,brands.json,SOURCE.txt,LICENSE-simple-icons.txt}
// from the pinned simple-icons@14.0.0 package (docs/2FA_IMPORT_SPEC.md section 6).
// Usage: node scripts/build-brand-icons.mjs <unpacked package dir> <sha256> <integrity>
// Only the allow-list below is kept; icons whose data entry has a non-CC0 licence are excluded.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [pkgDir, sha256 = '', integrity = ''] = process.argv.slice(2);
if (!pkgDir) { console.error('usage: build-brand-icons.mjs <package dir> [sha256] [integrity]'); process.exit(2); }
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'static', 'icons', 'brands');
const VERSION = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
if (VERSION !== '14.0.0') { console.error('expected simple-icons 14.0.0, got ' + VERSION); process.exit(2); }

const ALLOW = [
  '1password', 'adobe', 'airbnb', 'alibabacloud', 'amazon', 'amazonaws', 'americanexpress', 'apple', 'atlassian',
  'backblaze', 'bandcamp', 'binance', 'bitbucket', 'bitwarden', 'bitly', 'bluesky', 'box', 'brave', 'bybit',
  'cashapp', 'cloudflare', 'coinbase', 'confluence', 'cpanel', 'dashlane', 'datadog', 'deezer', 'digitalocean',
  'discord', 'disqus', 'docker', 'dropbox', 'duckduckgo', 'ebay', 'epicgames', 'etsy', 'evernote', 'facebook',
  'figma', 'firefox', 'fastmail', 'flickr', 'gandi', 'gitea', 'github', 'gitlab', 'godaddy', 'google',
  'googlecloud', 'googledrive', 'googlepay', 'gumroad', 'heroku', 'hetzner', 'hubspot', 'huggingface', 'instagram',
  'jira', 'kagi', 'kick', 'kraken', 'lastpass', 'line', 'linkedin', 'mailchimp', 'mailgun', 'mastodon', 'medium',
  'meta', 'microsoft', 'microsoftazure', 'microsoftoffice', 'microsoftoutlook', 'microsoftteams', 'monzo',
  'namecheap', 'netflix', 'netlify', 'nextcloud', 'nintendo', 'notion', 'npm', 'nvidia', 'okta', 'openai', 'opera',
  'oracle', 'patreon', 'paypal', 'pinterest', 'playstation', 'protonmail', 'protonvpn', 'proton', 'pypi', 'quora',
  'rakuten', 'reddit', 'revolut', 'riotgames', 'robinhood', 'salesforce', 'samsung', 'sendgrid', 'sentry',
  'shopify', 'signal', 'skype', 'slack', 'snapchat', 'soundcloud', 'spotify', 'square', 'squarespace',
  'stackoverflow', 'steam', 'stripe', 'supabase', 'synology', 'tailscale', 'telegram', 'threads', 'tiktok',
  'trello', 'tumblr', 'tuta', 'twitch', 'twilio', 'uber', 'ubisoft', 'vercel', 'vimeo', 'visa', 'vivaldi',
  'vultr', 'wechat', 'whatsapp', 'wikipedia', 'wise', 'wordpress', 'x', 'xbox', 'yahoo', 'yandex', 'youtube',
  'zendesk', 'zoho', 'zoom', 'mullvad', 'nordvpn', 'expressvpn', 'surfshark', 'linode', 'akamai', 'ovh',
  'scaleway', 'porkbun', 'ionos', 'hostinger', 'wix', 'webflow', 'codeberg', 'standardnotes', 'joplin',
  'obsidian', 'todoist', 'asana', 'clickup', 'linear', 'airtable', 'miro', 'canva', 'dribbble', 'behance',
  'strava', 'garmin', 'fitbit', 'duolingo', 'coursera', 'udemy', 'kaggle', 'leetcode', 'codepen', 'replit',
  'jetbrains', 'postman', 'grafana', 'newrelic', 'pagerduty', 'mongodb', 'redis', 'elastic', 'snowflake',
  'kucoin', 'okx', 'bitget', 'ledger', 'trezor', 'metamask', 'n26', 'ing', 'hsbc', 'barclays', 'santander',
  'mastercard', 'venmo', 'klarna', 'adyen', 'payoneer', 'skrill', 'westernunion', 'intuit', 'quickbooks', 'xero',
  'docusign', 'wetransfer', 'icloud', 'gmail', 'googlechat', 'googlemeet', 'googlecalendar', 'googlephotos',
  'googleplay', 'googlechrome', 'microsoftedge', 'safari', 'torproject', 'wireguard', 'openvpn', 'auth0',
  'firebase', 'ghost', 'substack', 'viber', 'element', 'matrix', 'mattermost', 'dailymotion', 'vk', 'weibo',
  'alipay', 'paytm', 'phonepe', 'flipkart', 'zalando', 'aliexpress', 'walmart', 'target', 'bestbuy', 'ikea',
  'tesla', 'lyft', 'bolt', 'grab', 'doordash', 'ubereats', 'deliveroo', 'instacart', 'bookingdotcom', 'expedia',
  'tripadvisor', 'ryanair', 'lufthansa', 'delta', 'klm', 'easyjet', 'hilton', 'marriott', 'hyatt', 'accor',
];

const sdk = await import(pathToFileURL(path.join(pkgDir, 'sdk.mjs')).href);
const data = JSON.parse(fs.readFileSync(path.join(pkgDir, '_data', 'simple-icons.json'), 'utf8'));
const bySlug = new Map(data.map((d) => [sdk.titleToSlug(d.title), d]));
const map = {};
const symbols = [];
const skipped = [];
for (const slug of [...new Set(ALLOW)].sort()) {
  const d = bySlug.get(slug);
  const file = path.join(pkgDir, 'icons', slug + '.svg');
  if (!d || !fs.existsSync(file)) { skipped.push(slug + ':missing'); continue; }
  if (d.license && d.license.type !== 'CC0-1.0') { skipped.push(slug + ':licence'); continue; }
  const m = /<path d="([^"]+)"\s*\/>\s*<\/svg>\s*$/.exec(fs.readFileSync(file, 'utf8'));
  if (!m || /[<>"&]/.test(m[1])) { skipped.push(slug + ':shape'); continue; }
  const aliases = [];
  const al = d.aliases || {};
  for (const k of ['aka', 'old']) for (const a of al[k] || []) aliases.push(a);
  for (const a of Object.values(al.loc || {})) aliases.push(a);
  map[slug] = { title: d.title, hex: d.hex.toLowerCase(), aliases };
  symbols.push('<symbol id="si-' + slug + '" viewBox="0 0 24 24"><path d="' + m[1] + '"/></symbol>');
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'brands.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" style="display:none">\n' + symbols.join('\n') + '\n</svg>\n');
fs.writeFileSync(path.join(OUT, 'brands.json'), JSON.stringify(map) + '\n');
fs.copyFileSync(path.join(pkgDir, 'LICENSE.md'), path.join(OUT, 'LICENSE-simple-icons.txt'));
fs.writeFileSync(path.join(OUT, 'SOURCE.txt'), [
  'Simple Icons ' + VERSION + ' (simple-icons on npm, https://simpleicons.org), CC0-1.0, subset of ' + symbols.length + ' common 2FA brands.',
  'tarball sha256: ' + sha256,
  'registry integrity: ' + integrity,
  'Generated by scripts/build-brand-icons.mjs. Icons whose data entry carries a non-CC0 licence are excluded.',
  '',
  'TRADEMARKS: CC0 covers the copyright in the SVG drawings only. The logos are',
  'trademarks of their owners. Deeperguard shows them only to identify an account the',
  'user added (nominative use), never to suggest endorsement or partnership, and never in',
  'marketing material. If an owner asks for removal, remove the slug from the allow-list in',
  'scripts/build-brand-icons.mjs and rebuild; that account then falls back to a letter avatar.',
  '',
].join('\n'));
console.log('kept ' + symbols.length + ', skipped: ' + skipped.join(' '));
