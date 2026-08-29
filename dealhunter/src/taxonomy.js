'use strict';

// Surplus listings are written by whoever ran the auction, not by a catalogue
// team: "LOT OF 25 DELL LATITUDE 5490 LAPTOPS", "Cisco Cat 2960X 48pt",
// "(3) Fluke 87V". Classification therefore runs on keyword weight rather than
// on any field the sites provide, and the site's own category (when it gives
// one) only breaks ties.

const CATEGORIES = [
  {
    id: 'laptops',
    label: 'Laptops & notebooks',
    patterns: [
      [/\blaptops?\b/i, 6], [/\bnotebooks?\b/i, 5], [/\bmacbooks?\b/i, 6],
      [/\bchromebooks?\b/i, 6], [/\bultrabooks?\b/i, 4],
      [/\b(latitude|elitebook|probook|thinkpad|inspiron|vostro|zbook|precision\s?7\d{3})\b/i, 5],
      [/\bsurface\s+(pro|laptop|book)\b/i, 4],
    ],
  },
  {
    id: 'desktops',
    label: 'Desktops & workstations',
    patterns: [
      [/\bdesktops?\b/i, 6], [/\bworkstations?\b/i, 5], [/\ball[- ]in[- ]one\b/i, 4],
      [/\b(optiplex|prodesk|elitedesk|thinkcentre|thinkstation|imac|mac\s?mini|mac\s?pro)\b/i, 5],
      [/\bsff\b/i, 2], [/\bmicro\s?pc\b/i, 3], [/\btower\s?pc\b/i, 4],
    ],
  },
  {
    id: 'servers',
    label: 'Servers & racks',
    patterns: [
      [/\bservers?\b/i, 6], [/\brack\s?mount\b/i, 3], [/\bblades?\b/i, 3],
      [/\b(poweredge|proliant|thinksystem|ucs|primergy|supermicro)\b/i, 6],
      [/\b[rd]\s?\d{3}0?xd?\b/i, 2], [/\bdl\s?\d{3}\b/i, 4], [/\bchassis\b/i, 2],
      [/\bsan\b/i, 3], [/\b(vnx|isilon|nimble|equallogic|compellent)\b/i, 5],
    ],
  },
  {
    id: 'networking',
    label: 'Networking',
    patterns: [
      [/\bswitch(es)?\b/i, 5], [/\brouters?\b/i, 5], [/\bfirewalls?\b/i, 5],
      [/\baccess\s?points?\b/i, 5], [/\bwireless\s+(ap|controller)\b/i, 4],
      [/\b(catalyst|nexus|meraki|aruba|ubiquiti|unifi|fortigate|palo\s?alto|juniper|ex\d{4})\b/i, 5],
      [/\bsfp\+?\b/i, 3], [/\bpatch\s?panel\b/i, 3], [/\bpoe\b/i, 2],
    ],
  },
  {
    id: 'storage',
    label: 'Drives & storage',
    patterns: [
      [/\bhard\s?drives?\b/i, 5], [/\bhdds?\b/i, 5], [/\bssds?\b/i, 5],
      [/\bnas\b/i, 4], [/\bdisk\s?shelf\b/i, 4], [/\bnvme\b/i, 4],
      [/\btape\s+(drive|library)\b/i, 4], [/\b(synology|qnap|netapp)\b/i, 4],
    ],
  },
  {
    id: 'monitors',
    label: 'Monitors & displays',
    patterns: [
      [/\bmonitors?\b/i, 6], [/\bdisplays?\b/i, 3], [/\blcd\b/i, 3],
      [/\b\d{2}["”]?\s*(inch)?\s*(led|lcd|monitor)\b/i, 4],
      [/\bultrasharp\b/i, 5], [/\bprojectors?\b/i, 5],
    ],
  },
  {
    id: 'phones',
    label: 'Phones & radios',
    patterns: [
      [/\biphones?\b/i, 6], [/\bsmart\s?phones?\b/i, 5], [/\bgalaxy\s+s\d{1,2}\b/i, 5],
      [/\bpixel\s+\d\b/i, 4], [/\bcell\s?phones?\b/i, 5],
      [/\b(motorola|kenwood)\s+(apx|xts|xpr|nx)\b/i, 5], [/\btwo[- ]way\s+radios?\b/i, 5],
    ],
  },
  {
    id: 'tablets',
    label: 'Tablets',
    patterns: [[/\btablets?\b/i, 6], [/\bipads?\b/i, 6], [/\bgalaxy\s+tab\b/i, 5], [/\bsurface\s+go\b/i, 4]],
  },
  {
    id: 'printers',
    label: 'Printers & scanners',
    patterns: [
      [/\bprinters?\b/i, 6], [/\bcopiers?\b/i, 5], [/\bplotters?\b/i, 5],
      [/\bscanners?\b/i, 4], [/\b(laserjet|officejet|workcentre|imagerunner|zebra\s+z[a-z0-9]+)\b/i, 5],
      [/\bmulti[- ]?function\b/i, 3],
    ],
  },
  {
    id: 'testequipment',
    label: 'Test & lab equipment',
    patterns: [
      [/\boscilloscopes?\b/i, 6], [/\bmultimeters?\b/i, 6], [/\bspectrum\s+analyzers?\b/i, 6],
      [/\b(fluke|tektronix|keysight|agilent|rohde|anritsu)\b/i, 5],
      [/\bcalibrat(or|ion)\b/i, 3], [/\bthermal\s+imager\b/i, 5], [/\bmicroscopes?\b/i, 5],
      [/\btotal\s+station\b/i, 5], [/\bcentrifuges?\b/i, 4],
    ],
  },
  {
    id: 'av',
    label: 'Audio / video',
    patterns: [
      [/\bcameras?\b/i, 4], [/\bcamcorders?\b/i, 5], [/\bmixers?\b/i, 3],
      [/\bmicrophones?\b/i, 4], [/\bspeakers?\b/i, 3], [/\bdrones?\b/i, 5],
      [/\b(canon|nikon|sony)\s+(eos|d\d{3,4}|alpha|a7)\b/i, 5],
    ],
  },
  {
    id: 'medical',
    label: 'Medical',
    patterns: [
      [/\bdefibrillators?\b/i, 6], [/\binfusion\s+pumps?\b/i, 6], [/\bventilators?\b/i, 6],
      [/\bpatient\s+monitors?\b/i, 6], [/\bexam\s+tables?\b/i, 4], [/\bautoclaves?\b/i, 5],
      [/\bultrasound\b/i, 5],
    ],
  },
  {
    id: 'tools',
    label: 'Tools & shop equipment',
    patterns: [
      [/\bpower\s+tools?\b/i, 5], [/\bwelders?\b/i, 5], [/\bair\s+compressors?\b/i, 5],
      [/\b(dewalt|milwaukee|makita|snap[- ]?on|hilti)\b/i, 5], [/\btool\s?box(es)?\b/i, 4],
      [/\bgenerators?\b/i, 4], [/\blathes?\b/i, 5],
    ],
  },
  {
    id: 'vehicles',
    label: 'Vehicles',
    patterns: [
      [/\b(sedan|pickup|truck|van|suv|cruiser|ambulance|bus)\b/i, 4],
      [/\b(ford|chevrolet|chevy|dodge|ram|toyota|freightliner|international)\b\s+\w+/i, 3],
      [/\b(crown\s+victoria|f[- ]?\d{3}|silverado|tahoe|explorer|impala|charger)\b/i, 5],
      [/\bvin\b/i, 4], [/\bodometer\b/i, 5], [/\btrailers?\b/i, 4],
    ],
  },
  {
    id: 'heavyequipment',
    label: 'Heavy equipment',
    patterns: [
      [/\b(excavators?|backhoes?|bulldozers?|loaders?|graders?)\b/i, 6],
      [/\b(caterpillar|komatsu|john\s+deere|case\s+\d|bobcat)\b/i, 5],
      [/\bforklifts?\b/i, 6], [/\bmowers?\b/i, 4], [/\btractors?\b/i, 5],
      [/\bskid\s?steer\b/i, 6],
    ],
  },
  {
    id: 'furniture',
    label: 'Furniture',
    patterns: [
      [/\b(desks?|chairs?|cubicles?|file\s+cabinets?|bookcases?|lockers?)\b/i, 5],
      [/\b(herman\s+miller|steelcase|aeron|knoll)\b/i, 6], [/\bconference\s+tables?\b/i, 5],
    ],
  },
];

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

// Categories where a single lot is normally one sellable unit no matter how the
// title reads, so quantity parsing should not multiply the valuation.
const SINGLE_UNIT_CATEGORIES = new Set(['vehicles', 'heavyequipment']);

function classify(text, hint) {
  const haystack = String(text || '');
  const scores = new Map();
  for (const category of CATEGORIES) {
    let score = 0;
    for (const [pattern, weight] of category.patterns) {
      if (pattern.test(haystack)) score += weight;
    }
    if (score > 0) scores.set(category.id, score);
  }

  // The site's own category is a weak signal — it is often just "Computers" or
  // "Miscellaneous" — so it adds a point rather than deciding the outcome.
  if (hint) {
    const hintText = String(hint).toLowerCase();
    for (const category of CATEGORIES) {
      if (hintText.includes(category.id) || hintText.includes(category.label.toLowerCase().split(' ')[0])) {
        scores.set(category.id, (scores.get(category.id) || 0) + 1);
      }
    }
  }

  if (!scores.size) return { category: 'misc', label: 'Uncategorised', score: 0 };
  let best = null;
  for (const [id, score] of scores) {
    if (!best || score > best.score) best = { category: id, score };
  }
  return { category: best.category, label: BY_ID.get(best.category).label, score: best.score };
}

function label(categoryId) {
  const found = BY_ID.get(categoryId);
  return found ? found.label : 'Uncategorised';
}

function isSingleUnit(categoryId) {
  return SINGLE_UNIT_CATEGORIES.has(categoryId);
}

function listCategories() {
  return CATEGORIES.map((c) => ({ id: c.id, label: c.label }))
    .concat([{ id: 'misc', label: 'Uncategorised' }]);
}

module.exports = { classify, label, listCategories, isSingleUnit, CATEGORIES };
