#!/usr/bin/env node
/**
 * One-time Cloudflare provisioning for a fresh clone of this repo.
 *
 * The committed wrangler.jsonc files are account-agnostic templates: D1/KV
 * ids differ per Cloudflare account, so the repo ships placeholders and this
 * script wires the real ones in. Idempotent — every step is find-or-create,
 * so re-running it is a no-op once resources exist.
 *
 * Auth: run `npx wrangler login` first, or export CLOUDFLARE_API_TOKEN and
 * CLOUDFLARE_ACCOUNT_ID. The patched ids are account-specific but are not
 * secrets; still, they are yours, so keep the patched files out of commits.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_CONFIG = path.join(ROOT, 'workers/admin-panel/wrangler.jsonc');
const PROXY_CONFIG = path.join(ROOT, 'workers/reverse-proxy/wrangler.jsonc');
// Git-ignored, so account-specific values and secrets live here rather than in
// the tracked wrangler.jsonc templates.
const ADMIN_DEV_VARS = path.join(ROOT, 'workers/admin-panel/.dev.vars');

const D1_NAME = 'jouska-admin';
const KV_TITLE = 'CONFIG_KV';

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

// Wrangler prints banners around its JSON; slice the array out instead of
// trusting output to start clean. (`kv namespace list` has no --json flag.)
function extractJsonArray(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end < start) {
    throw new Error(`no JSON array found in wrangler output:\n${text}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

// Field name drifted across wrangler versions: uuid / database_id / id.
function idOf(entry) {
  const id = entry.uuid ?? entry.database_id ?? entry.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function listD1(name) {
  for (const entry of extractJsonArray(wrangler(['d1', 'list', '--json']))) {
    if (entry.name === name) return idOf(entry);
  }
  return null;
}

function listKV(title) {
  for (const entry of extractJsonArray(wrangler(['kv', 'namespace', 'list']))) {
    if (String(entry.title ?? '').includes(title)) return idOf(entry);
  }
  return null;
}

function ensure(describe, exists, create) {
  const found = exists();
  if (found) {
    console.log(`✓ ${describe} exists (${found})`);
    return found;
  }
  console.log(`… ${describe} not found, creating`);
  create();
  const created = exists();
  if (!created) {
    console.error(`✗ created ${describe} but could not read its id back; aborting`);
    process.exit(1);
  }
  console.log(`✓ created ${describe} (${created})`);
  return created;
}

function patch(file, replacements) {
  let text = readFileSync(file, 'utf8');
  let changed = false;
  for (const [find, replace] of replacements) {
    if (text.includes(find)) {
      text = text.replace(find, replace);
      changed = true;
    }
  }
  if (changed) console.log(`✓ wired ${path.relative(ROOT, file)}`);
  else console.log(`· ${path.relative(ROOT, file)} already wired`);
  if (changed) writeFileSync(file, text);
}

// Fail before touching anything if unauthenticated, not mid-patch.
let whoami;
try {
  whoami = wrangler(['whoami']);
} catch {
  console.error(
    '✗ Not authenticated. Run `npx wrangler login` first, or export CLOUDFLARE_API_TOKEN.',
  );
  process.exit(1);
}

// The account id the panel needs for hostname discovery. Prefer the explicit
// environment variable (CI sets it); otherwise read it out of `whoami`'s table,
// which prints it as a 32-char hex id.
//
// It is written to `.dev.vars`, never to wrangler.jsonc: that file is tracked by
// git, and an account id landing in it is one `git add -A` away from being
// published. Not a credential, but it identifies the account — and the habit of
// writing account-specific values into tracked files is how the token would
// eventually follow. Deployments get the same value from CI's own
// CLOUDFLARE_ACCOUNT_ID instead.
function accountIdFrom(text) {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const ids = [...text.matchAll(/\b[0-9a-f]{32}\b/g)].map((m) => m[0]);
  // More than one account means the choice is not this script's to make.
  return new Set(ids).size === 1 ? ids[0] : null;
}

/**
 * Adds or replaces one key in `.dev.vars`, leaving the operator's other lines
 * alone — including CF_API_TOKEN, which they may have put there by hand and
 * which this script must never overwrite or read back.
 */
function putDevVar(file, key, value) {
  const line = `${key}=${value}`;
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // No file yet: the first run creates it.
  }
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (at !== -1) {
    if (lines[at] === line) {
      console.log(`\u00b7 ${path.relative(ROOT, file)} already has ${key}`);
      return;
    }
    lines[at] = line;
  } else {
    // Keep the file newline-terminated without accumulating blank lines.
    if (text !== '' && lines.at(-1) !== '') lines.push('');
    lines.splice(lines.length - (lines.at(-1) === '' ? 1 : 0), 0, line);
  }
  writeFileSync(file, lines.join('\n'));
  console.log(`\u2713 wrote ${key} to ${path.relative(ROOT, file)} (git-ignored)`);
}

const d1Id = ensure(
  `D1 database "${D1_NAME}"`,
  () => listD1(D1_NAME),
  () => wrangler(['d1', 'create', D1_NAME]),
);
const kvId = ensure(
  `KV namespace "${KV_TITLE}"`,
  () => listKV(KV_TITLE),
  () => wrangler(['kv', 'namespace', 'create', KV_TITLE]),
);

patch(ADMIN_CONFIG, [
  ['REPLACE_WITH_REAL_D1_ID', d1Id],
  ['REPLACE_WITH_REAL_KV_ID', kvId],
]);

const accountId = accountIdFrom(whoami);
if (accountId) {
  putDevVar(ADMIN_DEV_VARS, 'CF_ACCOUNT_ID', accountId);
} else {
  console.log(
    '\u00b7 could not determine a single account id; put CF_ACCOUNT_ID in workers/admin-panel/.dev.vars by hand to enable the 域名 screen locally',
  );
}

// The reverse proxy ships with the KV binding commented out so it deploys
// standalone with its vars fallback. Wire it so it reads what the panel writes.
patch(PROXY_CONFIG, [
  [
    '// "kv_namespaces": [{ "binding": "CONFIG", "id": "<namespace-id>" }],',
    `"kv_namespaces": [{ "binding": "CONFIG", "id": "${kvId}" }],`,
  ],
]);

console.log(
  '\nHostname discovery (the 域名 screen) also needs CF_API_TOKEN. Deploys wire it\n' +
    'from the CI secret automatically; for local dev, add a line to\n' +
    '  workers/admin-panel/.dev.vars   ->   CF_API_TOKEN=<token>\n' +
    'A deploy-scoped token already works (Edit includes Read). Add Zone Read to\n' +
    'also enumerate zones for route patterns. Skip it and every other screen still\n' +
    'works; the 域名 screen says what is missing rather than erroring.',
);

console.log('\nDone. Patched locally — keep these out of commits:');
console.log(`  ${path.relative(ROOT, ADMIN_CONFIG)}`);
console.log(`  ${path.relative(ROOT, PROXY_CONFIG)}`);
