import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRunnerCapacity,
  parseRunnerHeartbeat,
  parseRunnerRegistration,
  resolveRunnerAvailability,
  RunnerProtocolError,
} from '#target/src/control/runner-protocol.ts';

const registration = () => parseRunnerRegistration({
  protocolVersion: 'v1',
  displayName: 'Codex local',
  capabilities: ['coding.patch', 'coding.test'],
  maxConcurrency: 2,
});

test('registration normalizes capabilities without accepting a claimed runnerId', () => {
  assert.deepEqual(registration().capabilities, ['coding.patch', 'coding.test']);
  assert.throws(() => parseRunnerRegistration({
    protocolVersion: 'v1', displayName: 'Runner', capabilities: ['coding.patch'], maxConcurrency: 1, runnerId: 'trusted-id',
  }), error => error instanceof RunnerProtocolError && error.code === 'invalid_payload_shape');
});

test('registration rejects unsupported versions and malformed capabilities or capacity', () => {
  assert.throws(() => parseRunnerRegistration({
    protocolVersion: 'v2', displayName: 'Runner', capabilities: ['coding.patch'], maxConcurrency: 1,
  }), error => error.code === 'unsupported_protocol_version');
  assert.throws(() => parseRunnerRegistration({
    protocolVersion: 'v1', displayName: 'Runner', capabilities: ['Coding.Patch'], maxConcurrency: 1,
  }), error => error.code === 'invalid_capability');
  assert.throws(() => parseRunnerRegistration({
    protocolVersion: 'v1', displayName: 'Runner', capabilities: ['coding.patch'], maxConcurrency: 129,
  }), error => error.code === 'invalid_capacity');
});

test('heartbeat requires a strictly increasing sequence and bounded concurrency', () => {
  assert.deepEqual(parseRunnerHeartbeat({protocolVersion: 'v1', sequence: 5, activeConcurrency: 2}, 2, 4), {
    protocolVersion: 'v1', sequence: 5, activeConcurrency: 2,
  });
  assert.throws(() => parseRunnerHeartbeat({protocolVersion: 'v1', sequence: 4, activeConcurrency: 1}, 2, 4),
    error => error.code === 'stale_heartbeat');
  assert.throws(() => parseRunnerHeartbeat({protocolVersion: 'v1', sequence: 5, activeConcurrency: 3}, 2, 4),
    error => error.code === 'invalid_capacity');
});

test('availability distinguishes saturated, expired, uninitialized and disabled runners', () => {
  const common = {observedAt: 10_000, expiresAt: 70_000, now: 20_000, maxConcurrency: 2};
  assert.equal(resolveRunnerAvailability({...common, enabled: true, activeConcurrency: 1}), 'available');
  assert.equal(resolveRunnerAvailability({...common, enabled: true, activeConcurrency: 2}), 'busy');
  assert.equal(resolveRunnerAvailability({...common, enabled: true, activeConcurrency: 0, now: 70_000}), 'unknown');
  assert.equal(resolveRunnerAvailability({...common, enabled: true, activeConcurrency: null}), 'unknown');
  assert.equal(resolveRunnerAvailability({...common, enabled: false, activeConcurrency: 0}), 'unavailable');
});

test('capacity snapshots use Hub receive time and do not claim runtime task state', () => {
  const receivedAt = new Date('2026-11-05T00:00:00.000Z');
  const capacity = createRunnerCapacity({
    runnerId: 'runner_abc123', registration: registration(),
    heartbeat: parseRunnerHeartbeat({protocolVersion: 'v1', sequence: 1, activeConcurrency: 1}, 2, null),
    receivedAt,
  });
  assert.equal(capacity.runnerId, 'runner_abc123');
  assert.equal(capacity.availability, 'available');
  assert.equal(capacity.observedAt, '2026-11-05T00:00:00.000Z');
  assert.equal(capacity.expiresAt, '2026-11-05T00:01:00.000Z');
});
