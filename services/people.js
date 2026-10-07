const User = require("../models/User");

// What one person may see about another: id, username, names and photo.
// NEVER an email — toSummary() does not include one. Shared by the friends
// routes, the collections payload and the public profile, so there is exactly
// one definition of "a person".
const PERSON_FIELDS = "username firstName lastName name avatar";

// Accepts a User document or a lean object and returns the person shape.
function personSummary(user) {
  const summary = new User(user).toSummary();

  return {
    id: summary.id,
    username: summary.username,
    firstName: summary.firstName,
    lastName: summary.lastName,
    avatarUrl: summary.avatarUrl,
  };
}

// Ids to people, in one query. Accepts an array or any iterable (callers pass
// both). `Map` keyed by id string; a missing id simply is not in the map, so
// callers fall back to whatever they show for "unknown".
async function loadPeople(ids) {
  const wanted = [...new Set([...ids].map(String))];
  if (wanted.length === 0) return new Map();

  const users = await User.find({ _id: { $in: wanted } })
    .select(PERSON_FIELDS)
    .lean();

  return new Map(users.map((user) => [String(user._id), personSummary(user)]));
}

module.exports = { PERSON_FIELDS, personSummary, loadPeople };
