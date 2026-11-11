#!/usr/bin/env node
// Qualification-only inventory guard. Keep in sync with as-sync-verification.yml.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const inventory = (...args) => JSON.parse(execFileSync(process.execPath,
  ['scripts/run-vitest-stable.mjs', ...args, '--dry-run'], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PAPERCLIP_CI_TEST_SELECTION: '', PAPERCLIP_CI_SELECTION_HASH: '' },
  }));
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
const all = [...walk('server/src').filter(f => f.endsWith('.test.ts')),
  ...walk('server/scripts').filter(f => f.endsWith('.test.mjs'))].sort();
const groups = [];
for (let i = 0; i < 8; i++) groups.push(inventory('--mode', 'general', '--group',
  'general-server-without-chat-or-native-runner', '--shard-index', String(i), '--shard-count', '8').selectedGeneralServerSuites);
for (let i = 0; i < 2; i++) groups.push(inventory('--mode', 'serialized',
  '--shard-index', String(i), '--shard-count', '2').selectedSerializedSuites);
const native = inventory('--mode', 'general', '--group', 'general-server-native-runner').selectedGeneralServerSuites;
groups.push(native.filter((_, i) => i % 2 === 0), native.filter((_, i) => i % 2 === 1));
groups.push(['server/src/__tests__/chat-channels.integration.test.ts']);
const assigned = groups.flat();
assert.equal(new Set(assigned).size, assigned.length, 'Duplicate server suite ownership');
assert.deepEqual([...assigned].sort(), all, 'Missing or unexpected server suites');
// Explicit files are Vitest substring filters. Assert they cannot select a second suite.
for (const file of assigned) assert.deepEqual(all.filter(candidate => candidate.includes(file)), [file]);
const chat = [0, 1].flatMap(i => inventory('--mode', 'general', '--group', 'general-chat',
  '--shard-index', String(i), '--shard-count', '2').chatVitestShards);
assert.deepEqual(chat.map(x => x.index).sort((a,b) => a-b), Array.from({length: chat[0].count}, (_,i) => i));
assert.ok(chat.every(x => x.count === chat.length));
const workspaceProjects = ['a', 'b', 'c'].flatMap(group => inventory('--mode', 'general',
  '--group', `general-workspaces-${group}`).workspaceProjects);
const config = readFileSync('vitest.config.ts', 'utf8');
const projectPaths = [...config.slice(config.indexOf('projects:')).matchAll(/"([^"]+)"/g)].map(m => m[1]);
const expectedProjects = projectPaths.filter(p => p !== 'server').map(p => JSON.parse(readFileSync(`${p}/package.json`, 'utf8')).name).sort();
assert.equal(new Set(workspaceProjects).size, workspaceProjects.length, 'Duplicate workspace project ownership');
assert.deepEqual([...workspaceProjects].sort(), expectedProjects);
console.log(JSON.stringify({ serverSuites: all.length, generalShardCounts: groups.slice(0,8).map(g=>g.length),
  serializedShardCounts: groups.slice(8,10).map(g=>g.length), nativeSuites: native,
  nativeShardCounts: groups.slice(10,12).map(g=>g.length), chatShards: chat,
  workspaceProjects, missing: [], duplicates: [] }, null, 2));
