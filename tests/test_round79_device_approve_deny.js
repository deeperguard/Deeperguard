/**
 * Round 79: Settings > Devices Approve/Deny UI (no email approve links).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const signinAlert = fs.readFileSync(path.join(root, 'app/signin_alert.py'), 'utf8');

const devices = appJs.split('function renderSignedInDevices')[1].split('function stopSignedInDevicesRefresh')[0];

assert.ok(devices.includes("approveBtn.textContent = 'Approve'"));
assert.ok(devices.includes("denyBtn.textContent = 'Deny'"));
assert.ok(devices.includes('approvePendingDevice'));
assert.ok(devices.includes('denyPendingDevice'));
assert.ok(appJs.includes('/api/sessions/${item.id}/approve'));
assert.ok(!devices.includes('IP ${item.ip}'));
assert.ok(!devices.includes('`IP '));

assert.ok(appHtml.includes('Signed-in devices'));
assert.ok(appHtml.includes('Approve'));

assert.ok(!signinAlert.toLowerCase().includes('approve'));
assert.ok(!signinAlert.includes('http://'));
assert.ok(!signinAlert.includes('https://'));

console.log('round 79 device approve/deny ui ok');
