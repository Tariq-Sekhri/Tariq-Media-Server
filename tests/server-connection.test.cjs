const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load-ts.cjs');
const { createServerConnectionCheck } = load('app/lib/server-connection.ts');

test('brief failures preserve browsing; sustained failure goes offline and recovery is immediate', async () => {
  let online = false;
  const states = [];
  const connection = createServerConnectionCheck(async () => online, state => states.push(state));
  await connection.check();
  await connection.check();
  assert.deepEqual(states, []);
  online = true;
  await connection.check();
  online = false;
  await connection.check();
  await connection.check();
  assert.deepEqual(states, [true]);
  await connection.check();
  assert.deepEqual(states, [true, false]);
  online = true;
  await connection.check();
  assert.deepEqual(states, [true, false, true]);
});

test('simultaneous network hints share a probe and cleanup ignores an outstanding result', async () => {
  let finish;
  let calls = 0;
  const states = [];
  const connection = createServerConnectionCheck(() => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  }, state => states.push(state));
  const first = connection.check();
  assert.equal(connection.check(), first);
  assert.equal(calls, 1);
  connection.stop();
  finish(true);
  await first;
  await connection.check();
  assert.equal(calls, 1);
  assert.deepEqual(states, []);
});

test('probe exceptions count toward the same outage threshold', async () => {
  const states = [];
  const connection = createServerConnectionCheck(async () => { throw Error('connection reset'); }, state => states.push(state));
  for (let i = 0; i < 3; i++) await connection.check();
  assert.deepEqual(states, [false]);
});
