// End-to-end test in real browsers (Phase 13), against the running Docker stack:
//
//   npm run stack:up && npm run stack:e2e
//
// Two headless Chrome users go through the real UI — sign up with the form,
// create a document from the dashboard, share it from the editor's Share dialog —
// then type into Monaco at the same time. Checks: both see each other's text
// and presence, the production build runs under the strict CSP with no
// violations, a reload restores the session from the refresh cookie and the
// document from PostgreSQL, and the two users were served by different backend
// instances (read from the backend logs).
//
// Uses playwright-core with an installed Chrome (CHROME_PATH, or the usual
// install locations; GitHub's Ubuntu runners have one).

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const BASE = (process.argv[2] ?? process.env.STACK_URL ?? 'http://localhost:8080').replace(
  /\/$/,
  '',
);
const PASSWORD = 'correct-horse-battery';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
}

const executablePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!executablePath) {
  console.error('No Chrome found. Install Chrome or set CHROME_PATH.');
  process.exit(1);
}
const browser = await chromium.launch({ executablePath, headless: true });

/** One user in their own browser context (own cookies), with problem recorders. */
async function newUser(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on('response', (response) => {
    if (response.status() >= 400) {
      failedRequests.push(`${response.status()} ${new URL(response.url()).pathname}`);
    }
  });
  await page.addInitScript(() => {
    window.cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) =>
      window.cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`),
    );
  });
  const email = `${name.toLowerCase()}-${Date.now()}@example.test`;
  return { name, email, page, consoleErrors, failedRequests };
}

async function signUp(user) {
  const { page } = user;
  await page.goto(`${BASE}/register`);
  await page.fill('#register-name', user.name);
  await page.fill('#register-email', user.email);
  await page.fill('#register-password', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard', { timeout: 15_000 });
}

const editorLines = '.monaco-editor .view-lines';
const editorText = (user) =>
  user.page.$eval(editorLines, (element) => element.innerText.replace(/\u00a0/g, ' '));

async function waitForText(user, needle, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await editorText(user)).includes(needle)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function typeAtEnd(user, text) {
  await user.page.click(editorLines);
  await user.page.keyboard.press('Control+End');
  await user.page.keyboard.type(text, { delay: 10 });
}

try {
  const alice = await newUser('Alice');
  const bob = await newUser('Bob');
  await signUp(alice);
  await signUp(bob);
  check('both users sign up through the form and land on the dashboard', true);

  // ── Alice creates a document from the dashboard ────────────────────────────
  const docName = `e2e-${Date.now()}.js`;
  await alice.page.fill('input[placeholder="New document name"]', docName);
  await alice.page.click('form button[type="submit"]');
  await alice.page.waitForURL('**/editor/*', { timeout: 15_000 });
  const editorUrl = alice.page.url();
  await alice.page.waitForSelector(editorLines, { timeout: 20_000 });
  check('creating a document opens it in Monaco', true, new URL(editorUrl).pathname);

  // ── ...and shares it from the editor ───────────────────────────────────────
  await alice.page.getByRole('button', { name: 'Share' }).click();
  await alice.page.fill('#share-email', bob.email);
  await alice.page.selectOption('#share-role', 'EDITOR');
  await alice.page.getByRole('button', { name: 'Invite' }).click();
  const listed = await alice.page
    .getByText(bob.email)
    .waitFor({ timeout: 10_000 })
    .then(
      () => true,
      () => false,
    );
  check('the Share dialog invites Bob as an editor', listed);
  await alice.page.getByRole('button', { name: 'Close' }).click();

  // ── Bob finds it on his dashboard ──────────────────────────────────────────
  await bob.page.reload();
  const link = bob.page.getByRole('link', { name: docName }).first();
  const onDashboard = await link.waitFor({ timeout: 10_000 }).then(
    () => true,
    () => false,
  );
  check("the shared document appears on Bob's dashboard", onDashboard);
  await link.click();
  await bob.page.waitForSelector(editorLines, { timeout: 20_000 });

  // ── Typing in both browsers ────────────────────────────────────────────────
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await typeAtEnd(alice, 'const fromAlice = 1;');
  check('Bob sees what Alice types', await waitForText(bob, 'const fromAlice = 1;'));
  await typeAtEnd(bob, '\nconst fromBob = 2;');
  check('Alice sees what Bob types', await waitForText(alice, 'const fromBob = 2;'));

  const presence = await alice.page
    .locator('[title="Bob"]')
    .first()
    .waitFor({ timeout: 5_000 })
    .then(
      () => true,
      () => false,
    );
  check("Alice's presence bar shows Bob", presence);

  // ── Reload: session from the refresh cookie, text from PostgreSQL ─────────
  await new Promise((resolve) => setTimeout(resolve, 2_500)); // past the save debounce
  await alice.page.reload();
  await alice.page.waitForSelector(editorLines, { timeout: 20_000 });
  check(
    'after a reload Alice is still signed in and the document is intact',
    (await waitForText(alice, 'const fromAlice = 1;')) &&
      (await waitForText(alice, 'const fromBob = 2;')),
  );

  // ── Browser health ─────────────────────────────────────────────────────────
  for (const user of [alice, bob]) {
    const violations = await user.page.evaluate(() => window.cspViolations);
    check(
      `no CSP violations for ${user.name}`,
      violations.length === 0,
      `${violations.length} total: ${[...new Set(violations)].join('; ')}`,
    );
    // The one expected failure: the silent refresh before the first sign-in.
    const unexpected = user.failedRequests.filter((r) => r !== '401 /api/auth/refresh');
    check(`no failed requests for ${user.name}`, unexpected.length === 0, unexpected.join(', '));
    const errors = user.consoleErrors.filter((text) => !text.includes('401'));
    check(
      `no console errors for ${user.name}`,
      errors.length === 0,
      [...new Set(errors.map((text) => text.slice(0, 120)))].slice(0, 3).join(' | '),
    );
  }

  // ── Which instance served whom ─────────────────────────────────────────────
  if (process.env.SKIP_INSTANCE_CHECK !== '1') {
    const logs = execSync('docker compose --profile app logs backend-1 backend-2 --since 10m', {
      encoding: 'utf8',
    });
    // Lines look like `backend-2-1  | {..."userId":"…",...,"msg":"ws connection authenticated"}`.
    const served = (userId) =>
      new Set(
        logs
          .split('\n')
          .filter((line) => line.includes('ws connection authenticated') && line.includes(userId))
          .map((line) => line.split('|')[0].trim()),
      );
    const aliceOn = served(await userIdOf(alice));
    const bobOn = served(await userIdOf(bob));
    check(
      'the two users were served by different backend instances',
      aliceOn.size >= 1 && bobOn.size >= 1 && [...aliceOn].some((i) => !bobOn.has(i)),
      `alice: ${[...aliceOn]} / bob: ${[...bobOn]}`,
    );
  }
} finally {
  await browser.close();
}

/** The user's id, read from /api/auth/me inside their own session. */
async function userIdOf(user) {
  return user.page.evaluate(async () => {
    const refreshed = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
    const { accessToken } = await refreshed.json();
    const me = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${accessToken}` } });
    return (await me.json()).user.id;
  });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
