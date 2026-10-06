const { z } = require("zod");
const HttpError = require("../utils/httpError");
const { isValidDateString } = require("../utils/dates");

const dateString = z
  .string()
  .refine(isValidDateString, "Use a real date in YYYY-MM-DD format");

const objectIdString = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

// Zod reports problems as a list of issues, each with a path like
// ["widgets", "notes", "body"]. The frontend wants { "widgets.notes.body": [...] }.
// Problems with the body as a whole (no specific field) go under "_".
function issuesToFields(issues) {
  const fields = {};
  for (const issue of issues) {
    const key = issue.path.length ? issue.path.join(".") : "_";
    (fields[key] ??= []).push(issue.message);
  }
  return fields;
}

// Validate `data` against a schema. Returns the cleaned data, or throws a
// 400 HttpError listing every field that failed.
// `data ?? {}` because Express 5 leaves req.body undefined when nothing was sent.
function parseOrThrow(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  throw new HttpError(
    400,
    "Validation failed",
    issuesToFields(result.error.issues),
  );
}

// Rejects {} so a PATCH that changes nothing is reported instead of ignored.
function atLeastOneField(schema) {
  return schema.refine(
    (data) => Object.keys(data).length > 0,
    "Send at least one field to update",
  );
}

module.exports = {
  dateString,
  objectIdString,
  isHttpUrl,
  issuesToFields,
  parseOrThrow,
  atLeastOneField,
};
