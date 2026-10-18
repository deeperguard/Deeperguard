const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'static', 'js', 'auth-pages.js'), 'utf8');
const start = src.indexOf('const COMMON_PASSWORD_FRAGMENTS');
const end = src.indexOf('function paintPasswordStrength');
assert.ok(start >= 0 && end > start, 'passwordStrength source not found');
const passwordStrength = new Function(`${src.slice(start, end)}; return passwordStrength;`)();

function label(password) {
  return passwordStrength(password).label;
}

assert.strictEqual(label(''), 'Password strength');
assert.strictEqual(label('short'), 'Too short — use at least 12 characters');
assert.strictEqual(label('aaaaaaaaaaaa'), 'Weak');
assert.strictEqual(label('abcdefgh1234'), 'Weak');
assert.strictEqual(label('Abcdefgh1234!'), 'Fair');
assert.notStrictEqual(label('Abcdefgh1234!'), 'Strong');
assert.strictEqual(label('correcthorsebatterystaple'), 'Strong');
assert.strictEqual(label('purple-canoe-91'), 'Strong');
assert.strictEqual(label('Password1234!'), 'Weak');

const weak = passwordStrength('aaaaaaaaaaaa');
const fair = passwordStrength('Abcdefgh1234!');
const strong = passwordStrength('purple-canoe-91');
assert.ok(weak.label && fair.label && strong.label);
assert.notStrictEqual(weak.color, fair.color);
assert.notStrictEqual(fair.color, strong.color);
console.log('password strength ok');
