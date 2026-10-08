/**
 * End-to-end SRP M2: real in-app client (srp-auth.js) + Python SrpServerSession.step2.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
const harness = path.join(__dirname, 'srp_m2_roundtrip.py');

function pyRoundtrip(payload) {
  const res = spawnSync('python3', [harness], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(res.stderr || res.stdout || `python exit ${res.status}`);
  }
  return JSON.parse(res.stdout.trim());
}

global.window = global;
global.fetch = async () => ({ ok: false });
vm.runInThisContext(fs.readFileSync(path.join(jsRoot, 'srp-auth.js'), 'utf8'));

const { SrpClient } = global.NotesSrpAuth;

function randomEmail(i) {
  return `srp-m2-${i}-${crypto.randomBytes(4).toString('hex')}@e2e.test`;
}

function randomPassword() {
  return `pw-${crypto.randomBytes(12).toString('hex')}-X9`;
}

async function runClientServerRoundtrip(email, password, aOverride) {
  const setup = pyRoundtrip({ cmd: 'setup', email, password });
  const client = new SrpClient();
  client.step1(email, password);
  const creds = await client.step2(setup.salt, setup.B);
  const aSend = aOverride != null ? aOverride : creds.A;
  const { M2 } = pyRoundtrip({
    cmd: 'step2',
    state: setup.state,
    A: aSend,
    M1: creds.M1,
  });
  await client.step3(M2);
  return { creds, setup };
}

(async () => {
  const iterations = Number(process.env.SRP_M2_ITERATIONS || 200);
  for (let i = 0; i < iterations; i += 1) {
    const email = randomEmail(i);
    const password = randomPassword();
    try {
      await runClientServerRoundtrip(email, password);
    } catch (err) {
      console.error(`iteration ${i} failed email=${email}`, err);
      process.exit(1);
    }
  }

  console.log(`ok ${iterations} round-trips (repair-login / vault-recovery do not call step3)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
