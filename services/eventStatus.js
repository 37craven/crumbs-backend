// Status rules for an event. Anyone who can edit the event may change its status.
//
//   draft ──► planned ──► done
//     │          │          │
//     └──────────┴──► archived ──► (restore) draft
//
// Moves not listed here are refused. Two extra rules apply:
//   - To become "planned", the event needs a date.
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
function checkTransition(event, nextStatus) {
  if (event.status === nextStatus) {
    return `This event is already ${nextStatus}`;
  }

  if (!ALLOWED_TRANSITIONS[event.status]?.includes(nextStatus)) {
    return `An event that is ${event.status} cannot move to ${nextStatus}`;
  }

  const summary = event.summary ?? {};

  if (nextStatus === "planned" && !summary.eventDate) {
    return "Add a date to this event before planning it";
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
