const { z } = require("zod");
const { COLLECTION_STATUSES } = require("../models/Collection");
const { WIDGET_TYPES } = require("../models/Widget");
const { dateString } = require("./common");

// "planned,done" -> ["planned", "done"], then check every item.
// A missing parameter becomes an empty list.
function commaList(itemSchema) {
  return z
    .string()
    .optional()
    .transform((value) =>
      value ? value.split(",").map((s) => s.trim()).filter(Boolean) : [],
    )
    .pipe(z.array(itemSchema));
}

const SORT_OPTIONS = ["recent", "newest", "oldest", "title", "date_asc", "date_desc"];

// Query-string values arrive as text, so numbers use z.coerce.
const page = z.coerce.number().int().min(1).default(1);

const searchQuerySchema = z
  .object({
    q: z.string().trim().max(100, "Search text is too long").default(""),
    scope: z.enum(["all", "mine", "shared"]).default("all"),
    status: commaList(z.enum(COLLECTION_STATUSES)),
    tags: commaList(z.string().toLowerCase().max(24)),
    has: commaList(z.enum(WIDGET_TYPES)),
    dateFrom: dateString.optional(),
    dateTo: dateString.optional(),
    sort: z.enum(SORT_OPTIONS).default("recent"),
    page,
    limit: z.coerce.number().int().min(1).max(50).default(12),
  })
  .refine(
    (query) => !query.dateFrom || !query.dateTo || query.dateFrom <= query.dateTo,
    { message: "dateFrom must be on or before dateTo", path: ["dateTo"] },
  );

// GET /api/collections (the Collections grid) only needs paging.
const listQuerySchema = z.object({
  page,
  limit: z.coerce.number().int().min(1).max(100).default(24),
});

const upcomingQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

module.exports = {
  searchQuerySchema,
  listQuerySchema,
  upcomingQuerySchema,
  SORT_OPTIONS,
};
