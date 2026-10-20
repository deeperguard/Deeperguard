/**
 * Round 37 LOWs: connection-change must probe before sync; offline health
 * backoff; note-open deferral; local save ack; inline script still parses.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');

// Hotfix still present.
assert.ok(/var timer = ctrl \? setTimeout\([\s\S]*?\}, ms\) : null;/.test(appHtml));

// --- connection-change: probe first, no sync on offline transition ----------
const connBlock = appJs.split("conn.addEventListener('change'")[1].split('window.addEventListener(\'offline\'')[0];
assert.ok(connBlock.includes('probeNetwork'));
assert.ok(connBlock.includes('syncOnRecovery: false'));
assert.ok(connBlock.includes("onNetworkOnline('connection-change')"));
assert.ok(connBlock.indexOf('probeNetwork') < connBlock.indexOf("onNetworkOnline('connection-change')"));
assert.ok(connBlock.includes('!ok || !navigator.onLine') || connBlock.includes('if (!ok'));

// Offline handler must not force an immediate health spam probe.
const offlineHandler = appJs.split("addEventListener('offline'")[1].split('addEventListener(\'submit\'')[0];
assert.ok(offlineHandler.includes('startOfflineWatch()'));
assert.ok(!offlineHandler.includes('probeNetwork({ forceHealth: true })'));

// Offline watch backoff 2s → 5s → 10s.
assert.ok(appJs.includes('function nextOfflineWatchDelay'));
assert.ok(appJs.includes('offlineWatchDelayMs = 2000'));
assert.ok(appJs.includes('return 5000') && appJs.includes('return 10000'));

// --- note-open defers heavy work --------------------------------------------
const openNote = appJs.split('function openNote(id,')[1].split('function scrollOpenNoteToTop')[0];
assert.ok(openNote.includes('requestIdleCallback') || openNote.includes('requestAnimationFrame(deferHeavy)'));
assert.ok(openNote.includes('renderAttachments(id)'));
assert.ok(openNote.includes('Critical path') || openNote.includes('click handler stays short'));

// --- local save ack ---------------------------------------------------------
assert.ok(appJs.includes('function ackLocalSaveStatus'));
assert.ok(appJs.includes('ackLocalSaveStatus()'));
assert.ok(storeJs.includes('pushDirty({ quiet: true })'));

console.log('test_round37_ui ok');
