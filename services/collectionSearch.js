const Collection = require("../models/Collection");
const { accessFilter } = require("./access");

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Each "has" filter says which summary fields prove a widget has content.
const HAS_FILTERS = {
  notes: { "summary.noteExcerpts.0": { $exists: true } },
  image: { "summary.imageCount": { $gt: 0 } },
  date: { "summary.collectionDate": { $ne: null } },
  link: { "summary.linkCount": { $gt: 0 } },
};

// Which collections the search covers:
//   all    -> collections I created AND collections shared with me (the default)
//   mine   -> only collections I created
//   shared -> only collections other people shared with me
function scopeClause(scope, userId) {
  if (scope === "mine") return { owner: userId };
  if (scope === "shared") return { collaborators: userId };
  return accessFilter(userId);
}

// Turns the validated query into one MongoDB filter. Every condition is ANDed:
// the more filters the user adds, the fewer collections match.
// Always starts with the scope, so a user can only ever find collections they are part of.
function buildSearchFilter(query, userId) {
  const clauses = [scopeClause(query.scope ?? "all", userId)];

  // Every word in the search box must appear somewhere ("trip budget" needs both).
  for (const word of query.q.split(/\s+/).filter(Boolean)) {
    clauses.push({ searchText: { $regex: escapeRegex(word), $options: "i" } });
  }

  if (query.status.length) clauses.push({ status: { $in: query.status } });
  if (query.tags.length) clauses.push({ tags: { $all: query.tags } });
  for (const type of query.has) clauses.push(HAS_FILTERS[type]);

  // Dates are "YYYY-MM-DD" strings, so text comparison orders them correctly.
  // A collection has several dates (one per date widget): it matches if ANY of them
  // falls in the range. Collections with no date never match a date range.
  if (query.dateFrom && query.dateTo) {
    clauses.push({
      "summary.collectionDates": { $elemMatch: { $gte: query.dateFrom, $lte: query.dateTo } },
    });
  } else if (query.dateFrom) {
    clauses.push({ "summary.collectionDates": { $gte: query.dateFrom } });
  } else if (query.dateTo) {
    clauses.push({ "summary.collectionDates": { $lte: query.dateTo } });
  }

  return { $and: clauses };
}

// The pipeline stages that order the results.
function buildSortStages(sort) {
  switch (sort) {
    case "newest":
      return [{ $sort: { createdAt: -1, _id: -1 } }];
    case "oldest":
      return [{ $sort: { createdAt: 1, _id: 1 } }];
    case "title":
      // Plain sorting is case-sensitive ("Zebra" before "apple"), so sort on a
      // lowercase copy of the title.
      return [
        { $addFields: { titleKey: { $toLower: "$title" } } },
        { $sort: { titleKey: 1, _id: 1 } },
      ];
    case "date_asc":
    case "date_desc":
      // Collections with no date always go last, whichever direction is chosen.
      return [
        {
          $addFields: {
            noDate: {
              $cond: [{ $eq: [{ $ifNull: ["$summary.collectionDate", null] }, null] }, 1, 0],
            },
          },
        },
        {
          $sort: {
            noDate: 1,
            "summary.collectionDate": sort === "date_asc" ? 1 : -1,
            _id: 1,
          },
        },
      ];
    case "recent":
    default:
      return [{ $sort: { updatedAt: -1, _id: -1 } }];
  }
}

// Runs the query. Used by both the Collections grid and the Search page.
// Returns one page of collections plus the total number of matches.
async function findCollections(userId, query) {
  // Blank "new" collections never show up in lists.
  const built = buildSearchFilter(query, userId);
  const filter = { $and: [...built.$and, { status: { $ne: "new" } }] };

  const [collections, total] = await Promise.all([
    Collection.aggregate([
      { $match: filter },
      ...buildSortStages(query.sort),
      { $skip: (query.page - 1) * query.limit },
      { $limit: query.limit },
      // Aggregation ignores select:false, so hide the internal fields here.
      { $project: { searchText: 0, titleKey: 0, noDate: 0, __v: 0 } },
    ]),
    Collection.countDocuments(filter),
  ]);

  return { collections, total };
}

module.exports = {
  buildSearchFilter,
  buildSortStages,
  findCollections,
  escapeRegex,
};
