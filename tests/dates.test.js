const test = require("node:test");
const assert = require("node:assert/strict");
const { isValidDateString, todayInTimezone, daysBetween, addDays, dateSearchText } = require("../utils/dates");

test("isValidDateString accepts real dates only", () => {
  assert.equal(isValidDateString("2026-10-12"), true);
  assert.equal(isValidDateString("2028-02-29"), true); // leap year
  assert.equal(isValidDateString("2026-02-29"), false); // not a leap year
  assert.equal(isValidDateString("2026-02-30"), false);
  assert.equal(isValidDateString("2026-13-01"), false);
  assert.equal(isValidDateString("2026-1-5"), false); // wrong format
  assert.equal(isValidDateString("1850-01-01"), false); // out of range
  assert.equal(isValidDateString(20261012), false);
});

test("todayInTimezone depends on the timezone", () => {
  const now = new Date("2026-10-02T17:30:00Z"); // already Oct 3 in Manila
  assert.equal(todayInTimezone("UTC", now), "2026-10-02");
  assert.equal(todayInTimezone("Asia/Manila", now), "2026-10-03");
});

test("todayInTimezone falls back to UTC for an unknown timezone", () => {
  const now = new Date("2026-10-02T17:30:00Z");
  assert.equal(todayInTimezone("Not/AZone", now), "2026-10-02");
});

test("daysBetween and addDays", () => {
  assert.equal(daysBetween("2026-10-02", "2026-10-05"), 3);
  assert.equal(daysBetween("2026-10-05", "2026-10-02"), -3);
  assert.equal(daysBetween("2026-10-02", "2026-10-02"), 0);
  assert.equal(daysBetween("2026-02-27", "2026-03-02"), 3); // crosses a month end
  assert.equal(addDays("2026-12-30", 3), "2027-01-02"); // crosses a year end
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("dateSearchText adds the month name and year", () => {
  assert.equal(dateSearchText("2026-12-25"), "2026-12-25 december 2026");
  assert.equal(dateSearchText("2027-01-02"), "2027-01-02 january 2027");
});
