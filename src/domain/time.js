export function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Offset of `timeZone` from UTC at instant `ms`, in milliseconds. */
function offsetAt(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = type => Number(parts.find(part => part.type === type).value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - ms;
}

/** Converts a wall-clock time in `timeZone` to a UTC epoch in milliseconds (DST aware). */
export function localToUtc({ year, month, day, hour, minute, second }, timeZone) {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = asUtc - offsetAt(asUtc, timeZone);
  // Re-check at the resulting instant, in case it falls on the other side of a DST change.
  return asUtc - offsetAt(first, timeZone);
}
