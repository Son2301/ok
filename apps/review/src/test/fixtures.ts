/**
 * A small PR evolving over three pushes:
 *  A: users.ts builds SQL by concatenation (real bug), log.ts swallows errors (real bug),
 *     users.test.ts concatenates SQL in a test (Critic rejects), lockfile changed (filtered).
 *  B: fixes the empty catch, adds an eval() (new bug), touches the users.ts hunk.
 *  C: only the lockfile changes.
 */
import type { FakeGitHub } from './fake-github';

export const USERS_A = `import { db } from './db';

export interface User {
  id: string;
  name: string;
}

export async function findUser(id: string): Promise<User | null> {
  if (!id) {
    return null;
  }
  const q = "SELECT * FROM users WHERE id = '" + id + "'";
  const rows = await db.query(q);
  return rows[0] ?? null;
}

export async function countUsers(): Promise<number> {
  const rows = await db.query('SELECT count(*) AS n FROM users');
  return Number(rows[0].n);
}
`;

export const USERS_B = USERS_A.replace('  return rows[0] ?? null;', '  return (rows[0] as User) ?? null;');

export const LOG_A = `export function safeParse(text: string) {
  try {
    return JSON.parse(text);
  } catch (e) {}
  return null;
}
`;

export const LOG_B = `export function safeParse(text: string) {
  try {
    return JSON.parse(text);
  } catch (e) {
    reportError(e);
  }
  return null;
}

export function evaluate(expr: string) {
  return eval(expr);
}
`;

const USERS_DIFF_A = `diff --git a/src/db/users.ts b/src/db/users.ts
index 1111111..2222222 100644
--- a/src/db/users.ts
+++ b/src/db/users.ts
@@ -9,7 +9,8 @@ export async function findUser(id: string): Promise<User | null> {
   if (!id) {
     return null;
   }
-  const rows = await db.query('SELECT * FROM users WHERE id = $1', [id]);
+  const q = "SELECT * FROM users WHERE id = '" + id + "'";
+  const rows = await db.query(q);
   return rows[0] ?? null;
 }

`;

const USERS_DIFF_B = `diff --git a/src/db/users.ts b/src/db/users.ts
index 1111111..3333333 100644
--- a/src/db/users.ts
+++ b/src/db/users.ts
@@ -9,7 +9,8 @@ export async function findUser(id: string): Promise<User | null> {
   if (!id) {
     return null;
   }
-  const rows = await db.query('SELECT * FROM users WHERE id = $1', [id]);
-  return rows[0] ?? null;
+  const q = "SELECT * FROM users WHERE id = '" + id + "'";
+  const rows = await db.query(q);
+  return (rows[0] as User) ?? null;
 }

`;

const LOG_DIFF_A = `diff --git a/src/util/log.ts b/src/util/log.ts
new file mode 100644
index 0000000..4444444
--- /dev/null
+++ b/src/util/log.ts
@@ -0,0 +1,6 @@
+export function safeParse(text: string) {
+  try {
+    return JSON.parse(text);
+  } catch (e) {}
+  return null;
+}
`;

const LOG_DIFF_B = `diff --git a/src/util/log.ts b/src/util/log.ts
new file mode 100644
index 0000000..5555555
--- /dev/null
+++ b/src/util/log.ts
@@ -0,0 +1,12 @@
+export function safeParse(text: string) {
+  try {
+    return JSON.parse(text);
+  } catch (e) {
+    reportError(e);
+  }
+  return null;
+}
+
+export function evaluate(expr: string) {
+  return eval(expr);
+}
`;

const TEST_DIFF = `diff --git a/src/db/users.test.ts b/src/db/users.test.ts
new file mode 100644
index 0000000..6666666
--- /dev/null
+++ b/src/db/users.test.ts
@@ -0,0 +1,2 @@
+import { findUser } from './users';
+const q = "SELECT * FROM users WHERE name = '" + name + "'";
`;

const LOCK_DIFF = (v: string) => `diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index 7777777..8888888 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1,3 +1,3 @@
 lockfileVersion: '9.0'
-  version: 1.0.0
+  version: ${v}
 settings: {}
`;

export const PR_DIFF_A = USERS_DIFF_A + LOG_DIFF_A + TEST_DIFF + LOCK_DIFF('1.0.1');
export const PR_DIFF_B = USERS_DIFF_B + LOG_DIFF_B + TEST_DIFF + LOCK_DIFF('1.0.1');
export const PR_DIFF_C = USERS_DIFF_B + LOG_DIFF_B + TEST_DIFF + LOCK_DIFF('1.0.2');

/** Delta A...B as the compare API would return it. */
export const DELTA_A_B = `diff --git a/src/db/users.ts b/src/db/users.ts
--- a/src/db/users.ts
+++ b/src/db/users.ts
@@ -12,4 +12,4 @@ export async function findUser(id: string): Promise<User | null> {
   const q = "SELECT * FROM users WHERE id = '" + id + "'";
   const rows = await db.query(q);
-  return rows[0] ?? null;
+  return (rows[0] as User) ?? null;
 }
diff --git a/src/util/log.ts b/src/util/log.ts
--- a/src/util/log.ts
+++ b/src/util/log.ts
@@ -1,6 +1,12 @@
 export function safeParse(text: string) {
   try {
     return JSON.parse(text);
-  } catch (e) {}
+  } catch (e) {
+    reportError(e);
+  }
   return null;
 }
+
+export function evaluate(expr: string) {
+  return eval(expr);
+}
`;

export const DELTA_B_C = LOCK_DIFF('1.0.2')
  .replace('-  version: 1.0.0\n', '-  version: 1.0.1\n')
  .replace('@@ -1,3 +1,3 @@', '@@ -1,3 +1,3 @@');

export const REPO_NAME = 'acme/api';

/** Install head A of PR #1 into the fake GitHub. */
export function setupHeadA(gh: FakeGitHub, number = 1, over: Record<string, unknown> = {}) {
  gh.setPr(REPO_NAME, { number, headSha: 'shaA', title: 'Add user lookup', ...over }, PR_DIFF_A);
  gh.setFile(REPO_NAME, 'shaA', 'src/db/users.ts', USERS_A);
  gh.setFile(REPO_NAME, 'shaA', 'src/util/log.ts', LOG_A);
  gh.setFile(
    REPO_NAME,
    'shaA',
    'src/db/users.test.ts',
    `import { findUser } from './users';\nconst q = "SELECT * FROM users WHERE name = '" + name + "'";\n`,
  );
  gh.trees.set(`${REPO_NAME}@shaA`, [
    'src/db/users.ts',
    'src/db/db.ts',
    'src/util/log.ts',
    'src/db/users.test.ts',
    'package.json',
  ]);
}

export function setupHeadB(gh: FakeGitHub, number = 1) {
  gh.setPr(REPO_NAME, { number, headSha: 'shaB', title: 'Add user lookup' }, PR_DIFF_B);
  gh.setFile(REPO_NAME, 'shaB', 'src/db/users.ts', USERS_B);
  gh.setFile(REPO_NAME, 'shaB', 'src/util/log.ts', LOG_B);
  gh.compares.set(`${REPO_NAME}:shaA...shaB`, { status: 'ahead', diff: DELTA_A_B, truncated: false });
}

export function setupHeadC(gh: FakeGitHub, number = 1) {
  gh.setPr(REPO_NAME, { number, headSha: 'shaC', title: 'Add user lookup' }, PR_DIFF_C);
  gh.setFile(REPO_NAME, 'shaC', 'src/db/users.ts', USERS_B);
  gh.setFile(REPO_NAME, 'shaC', 'src/util/log.ts', LOG_B);
  gh.compares.set(`${REPO_NAME}:shaB...shaC`, { status: 'ahead', diff: DELTA_B_C, truncated: false });
}
