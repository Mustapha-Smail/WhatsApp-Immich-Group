import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isValidTimeZone, localToUtc } from '../../src/domain/time.js';

const at = (year, month, day, hour, minute = 0, second = 0) => ({ year, month, day, hour, minute, second });

describe('localToUtc', () => {
  it('converts wall-clock times, with daylight saving time', () => {
    assert.equal(new Date(localToUtc(at(2023, 1, 15, 12), 'Europe/Paris')).toISOString(), '2023-01-15T11:00:00.000Z');
    assert.equal(new Date(localToUtc(at(2023, 7, 15, 12), 'Europe/Paris')).toISOString(), '2023-07-15T10:00:00.000Z');
    assert.equal(new Date(localToUtc(at(2023, 7, 15, 12, 30, 15), 'UTC')).toISOString(), '2023-07-15T12:30:15.000Z');
    assert.equal(new Date(localToUtc(at(2023, 7, 15, 12), 'America/New_York')).toISOString(), '2023-07-15T16:00:00.000Z');
  });

  it('stays consistent around the daylight saving switch', () => {
    // 2023-10-29: Paris clocks go from 03:00 back to 02:00.
    assert.equal(new Date(localToUtc(at(2023, 10, 29, 4), 'Europe/Paris')).toISOString(), '2023-10-29T03:00:00.000Z');
    assert.equal(new Date(localToUtc(at(2023, 10, 28, 23), 'Europe/Paris')).toISOString(), '2023-10-28T21:00:00.000Z');
  });

  it('validates time zone names', () => {
    assert.ok(isValidTimeZone('Europe/Paris'));
    assert.ok(!isValidTimeZone('Mars/Olympus'));
  });
});
