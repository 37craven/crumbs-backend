// Status rules for a collection. Anyone who can edit the collection may change its status.
//
//   draft ──► planned ──► done
//     │          │          │
//     └──────────┴──► archived ──► (restore) draft
//
// Moves not listed here are refused. Two extra rules apply:
//   - To become "planned", the collection needs a date.
//   - To become "done", a checklist in use must be fully ticked.
//     (A notes widget set to plain notes has no checklist, so it never blocks.)

const ALLOWED_TRANSITIONS = {
  new: [], // becomes a draft by itself once something is added
  draft: ["planned", "archived"],
  planned: ["draft", "done", "archived"],
  done: ["planned", "archived"], // reopening is allowed
  archived: ["draft"], // restoring starts again from draft
};

// Returns null when the move is allowed, or a message explaining why not.
function checkTransition(collection, nextStatus) {
  if (collection.status === nextStatus) {
    return `This collection is already ${nextStatus}`;
  }

  if (!ALLOWED_TRANSITIONS[collection.status]?.includes(nextStatus)) {
    return `A collection that is ${collection.status} cannot move to ${nextStatus}`;
  }

  const summary = collection.summary ?? {};

  if (nextStatus === "planned" && !summary.collectionDate) {
    return "Add a date to this collection before planning it";
  }

  if (nextStatus === "done") {
    const open = summary.openChecklistItems ?? 0;
    if (open > 0) {
      return `Finish the checklist first: ${open} item${open === 1 ? " is" : "s are"} still open`;
    }
  }

  return null;
}

module.exports = { checkTransition, ALLOWED_TRANSITIONS };
