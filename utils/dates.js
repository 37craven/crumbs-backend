// Calendar dates in Crumbs are plain "YYYY-MM-DD" strings, not Date objects.
// A Date carries a time and a timezone, which causes "off by one day" bugs
// (a date picked in Manila can land on the previous day in UTC). A string like
// "2026-10-12" always means the same calendar day, and strings in this format
// sort and compare correctly as plain text, so MongoDB can filter on them.

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function toUtcMs(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

// True only for real calendar dates: "2026-02-30" and "2026-13-01" are rejected.
function isValidDateString(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;

  const [year, month, day] = value.split("-").map(Number);
  if (year < 1900 || year > 2100) return false; // almost certainly a typo

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

// "Today" depends on where the user is. APP_TIMEZONE (an IANA name such as
// "Asia/Manila") decides which calendar day it is right now. Defaults to UTC.
function todayInTimezone(
  timeZone = process.env.APP_TIMEZONE ?? "UTC",
  now = new Date(),
) {
  try {
    // The en-CA locale formats dates as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    // Unknown timezone name: fall back to UTC instead of crashing.
    return now.toISOString().slice(0, 10);
  }
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

// "2026-12-25" -> "2026-12-25 december 2026". Added to a collection's searchable
// text so a search for "december", "dec" or "2026" finds collections with a date then.
function dateSearchText(dateString) {
  const [year, month] = dateString.split("-");
  return `${dateString} ${MONTHS[Number(month) - 1]} ${year}`;
}

// Whole days from `from` to `to`. Negative when `to` is earlier.
function daysBetween(from, to) {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);
}

function addDays(dateString, days) {
  return new Date(toUtcMs(dateString) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

module.exports = {
  isValidDateString,
  todayInTimezone,
  daysBetween,
  addDays,
  dateSearchText,
};
