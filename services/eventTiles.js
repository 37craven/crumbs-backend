// The Collections card is a "folder" of up to FOUR tiles, in this order:
// date, note, image, link. A kind that is missing leaves a slot free, and
// the free slots are filled with MORE of the other kinds (pictures first, then
// links, dates, notes). So an event with a date, a note and 5 pictures shows
// date, note, image, image.
const ORDER = ["date", "note", "image", "link"];
const FILL_ORDER = ["image", "link", "date", "note"];

function buildTiles(summary, slots = 4) {
  const pools = {
    date: (summary.eventDates ?? []).map((date) => ({ type: "date", date })),
    note: (summary.noteExcerpts ?? []).map((text) => ({ type: "note", text })),
    image: (summary.imageUrls ?? []).map((url) => ({ type: "image", url })),
    link: (summary.links ?? []).map((link) => ({ type: "link", ...link })),
  };

  const tiles = [];
  for (const type of ORDER) if (pools[type].length) tiles.push(pools[type].shift());
  for (const type of FILL_ORDER) {
    while (tiles.length < slots && pools[type].length) tiles.push(pools[type].shift());
  }

  // Keep the date/note/image/link order; extras stay in their own order.
  return tiles.sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
}

module.exports = { buildTiles };
