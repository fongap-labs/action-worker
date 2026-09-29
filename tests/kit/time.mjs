// TRUE UTC+8 midnight for the business date `iso` (= 16:00Z on the previous day).
// Deliberately NOT `${iso}T00:00:00Z`: that instant is 08:00 UTC+8 on the same
// business day, so boundary tests would pass without exercising the conversion.
/** @param {string} iso */
export function dateAtIso(iso) {
  return Date.parse(`${iso}T00:00:00+08:00`);
}
