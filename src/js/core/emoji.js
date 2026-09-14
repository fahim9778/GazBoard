/*
 * The emoji a whiteboard actually needs.
 *
 * Not all of them. A full emoji keyboard is three and a half thousand
 * characters, most of which nobody has ever put on a whiteboard, and a picker
 * that size is a scrolling chore rather than a quick stamp. This is a curated
 * few hundred: marks and grades, arrows and pointers, faces to react with,
 * warnings, and the everyday objects that turn up in a diagram.
 *
 * Each entry carries the words someone might actually type to find it. "tick"
 * finds the check mark, because half the world calls it that; "right" and
 * "next" both find the right arrow. Searching is on names AND keywords, so a
 * word that appears in neither simply finds nothing rather than guessing.
 *
 * Drawn with whatever emoji font the machine already has - Segoe UI Emoji on
 * Windows, Noto on Android, Apple's on a Mac. Nothing is bundled and nothing
 * is fetched, so this works on a plane like the rest of the app. The trade is
 * that the same character looks slightly different on each platform, which is
 * true of every app that does it this way, including the one this replaces.
 */

/** [character, name, extra search words] */
const CATALOGUE = [
  // --- marks, grades, status -------------------------------------------
  ['✅', 'check mark button', 'tick correct right yes done pass green'],
  ['✔️', 'check mark', 'tick correct yes done'],
  ['❌', 'cross mark', 'wrong no incorrect fail x'],
  ['❎', 'cross mark button', 'wrong no x green'],
  ['⭕', 'hollow red circle', 'correct circle ring o'],
  ['❗', 'exclamation mark', 'important warning attention'],
  ['❓', 'question mark', 'ask unknown query doubt'],
  ['‼️', 'double exclamation', 'important urgent'],
  ['⚠️', 'warning', 'caution careful danger attention'],
  ['🚫', 'prohibited', 'no forbidden banned stop dont'],
  ['⛔', 'no entry', 'stop forbidden'],
  ['💯', 'hundred points', 'full marks perfect score 100'],
  ['⭐', 'star', 'favourite good rating'],
  ['🌟', 'glowing star', 'excellent sparkle special'],
  ['✨', 'sparkles', 'magic new shiny clean'],
  ['🔥', 'fire', 'hot trending great burning'],
  ['📌', 'pushpin', 'pin important note stick'],
  ['📍', 'round pushpin', 'location here pin place'],
  ['🔖', 'bookmark', 'save mark tag'],
  ['🏷️', 'label', 'tag name'],
  ['🔔', 'bell', 'reminder alert notification'],
  ['⏰', 'alarm clock', 'time deadline reminder wake'],
  ['⏳', 'hourglass', 'wait time pending later'],
  ['✏️', 'pencil', 'write edit note draft'],
  ['📝', 'memo', 'note write homework assignment'],
  ['🖊️', 'pen', 'write sign'],
  ['📎', 'paperclip', 'attach file clip'],
  ['🔗', 'link', 'chain url connect'],

  // --- arrows and pointers ---------------------------------------------
  ['➡️', 'right arrow', 'next forward then leads to east'],
  ['⬅️', 'left arrow', 'back previous west'],
  ['⬆️', 'up arrow', 'north increase rise up'],
  ['⬇️', 'down arrow', 'south decrease fall down'],
  ['↔️', 'left right arrow', 'both ways two way swap'],
  ['↕️', 'up down arrow', 'both ways vertical'],
  ['↩️', 'return arrow', 'back undo reply'],
  ['🔁', 'repeat', 'loop again cycle repeat'],
  ['🔄', 'refresh', 'cycle again process loop'],
  ['👉', 'pointing right', 'this look here point'],
  ['👈', 'pointing left', 'back look point'],
  ['👆', 'pointing up', 'above look point'],
  ['👇', 'pointing down', 'below look point'],
  ['🔺', 'red triangle up', 'increase rise up'],
  ['🔻', 'red triangle down', 'decrease fall down'],

  // --- faces and reactions ----------------------------------------------
  ['🙂', 'slight smile', 'happy ok fine'],
  ['😀', 'grinning face', 'happy smile glad'],
  ['😄', 'grinning eyes', 'happy joy smile'],
  ['😂', 'tears of joy', 'laugh funny lol'],
  ['🤣', 'rolling laughing', 'laugh funny lmao'],
  ['😊', 'smiling blush', 'happy shy warm'],
  ['😉', 'wink', 'joke cheeky'],
  ['😍', 'heart eyes', 'love adore great'],
  ['🤩', 'star struck', 'amazing wow excited'],
  ['😎', 'sunglasses', 'cool smooth'],
  ['🤔', 'thinking face', 'hmm consider question wonder'],
  ['🤨', 'raised eyebrow', 'doubt suspicious really'],
  ['😐', 'neutral face', 'meh flat blank'],
  ['😴', 'sleeping', 'tired bored asleep zzz'],
  ['😅', 'sweat smile', 'nervous phew relief'],
  ['😬', 'grimace', 'awkward yikes oops'],
  ['😮', 'open mouth', 'surprise wow shock'],
  ['😱', 'screaming', 'shock fear panic'],
  ['😢', 'crying', 'sad tear upset'],
  ['😭', 'sobbing', 'crying sad very'],
  ['😡', 'angry', 'mad furious rage'],
  ['🥳', 'partying face', 'celebrate congrats party'],
  ['🤯', 'mind blown', 'shocked amazed wow'],
  ['🙃', 'upside down', 'irony sarcasm silly'],
  ['😇', 'halo', 'innocent good angel'],
  ['🤓', 'nerd face', 'study clever glasses'],
  ['🥱', 'yawning', 'bored tired dull'],
  ['🫠', 'melting face', 'overwhelmed hot done'],

  // --- hands and people --------------------------------------------------
  ['👍', 'thumbs up', 'yes good agree approve like'],
  ['👎', 'thumbs down', 'no bad disagree dislike'],
  ['👏', 'clapping', 'applause well done bravo'],
  ['🙌', 'raising hands', 'celebrate praise hooray'],
  ['🙏', 'folded hands', 'please thanks thank you pray'],
  ['👋', 'waving hand', 'hello hi bye greeting'],
  ['🤝', 'handshake', 'deal agree partner'],
  ['✋', 'raised hand', 'stop wait question hand up'],
  ['✌️', 'victory', 'peace two win'],
  ['🤞', 'crossed fingers', 'hope luck wish'],
  ['💪', 'flexed bicep', 'strong effort power'],
  ['🧠', 'brain', 'think smart memory mind idea'],
  ['👀', 'eyes', 'look watch see attention'],
  ['🗣️', 'speaking head', 'talk say speak loud'],
  ['👤', 'silhouette', 'person user someone'],
  ['👥', 'two people', 'group team pair users'],
  ['👨‍🏫', 'teacher', 'lecturer class teach school'],
  ['👩‍🎓', 'graduate', 'student degree graduation'],
  ['👶', 'baby', 'child infant new'],

  // --- teaching, study, work ---------------------------------------------
  ['💡', 'light bulb', 'idea insight solution bright think'],
  ['📚', 'books', 'study read library course'],
  ['📖', 'open book', 'read chapter study'],
  ['🎓', 'graduation cap', 'degree university student graduate'],
  ['🏫', 'school', 'university college campus'],
  ['📐', 'triangular ruler', 'geometry measure angle maths'],
  ['📏', 'straight ruler', 'measure length line'],
  ['🧮', 'abacus', 'count maths arithmetic calculate'],
  ['➕', 'plus', 'add sum more addition'],
  ['➖', 'minus', 'subtract less take away'],
  ['✖️', 'multiply', 'times product multiplication'],
  ['➗', 'divide', 'division split share'],
  ['🟰', 'equals', 'same result equal'],
  ['📊', 'bar chart', 'graph data statistics results'],
  ['📈', 'chart up', 'growth increase rise improve trend'],
  ['📉', 'chart down', 'decline decrease fall drop'],
  ['🗓️', 'calendar', 'date schedule deadline plan'],
  ['📅', 'date', 'calendar day schedule'],
  ['⏱️', 'stopwatch', 'timer speed time measure'],
  ['🔍', 'magnifying glass', 'search find look examine detail'],
  ['🔬', 'microscope', 'science lab biology examine'],
  ['🧪', 'test tube', 'science chemistry experiment lab'],
  ['⚗️', 'alembic', 'chemistry lab science'],
  ['🧬', 'dna', 'biology genetics science'],
  ['🌡️', 'thermometer', 'temperature heat measure'],
  ['⚖️', 'balance scale', 'compare fair justice weigh law'],
  ['🧩', 'puzzle piece', 'part fit solve component'],
  ['🎯', 'bullseye', 'target goal aim objective'],
  ['🏆', 'trophy', 'win prize best champion'],
  ['🥇', 'gold medal', 'first winner best one'],
  ['🥈', 'silver medal', 'second two'],
  ['🥉', 'bronze medal', 'third three'],
  ['🎖️', 'medal', 'award honour merit'],

  // --- computing and objects ---------------------------------------------
  ['💻', 'laptop', 'computer code work pc'],
  ['🖥️', 'desktop computer', 'monitor screen pc'],
  ['📱', 'mobile phone', 'smartphone android mobile'],
  ['⌨️', 'keyboard', 'type input keys'],
  ['🖱️', 'mouse', 'click pointer cursor'],
  ['🖨️', 'printer', 'print paper output'],
  ['💾', 'floppy disk', 'save storage disk old'],
  ['💿', 'optical disc', 'cd dvd disc'],
  ['🗄️', 'file cabinet', 'archive storage records'],
  ['📁', 'folder', 'directory files'],
  ['📂', 'open folder', 'directory files open'],
  ['📄', 'page', 'document file paper sheet'],
  ['📋', 'clipboard', 'copy list tasks paste'],
  ['🗑️', 'wastebasket', 'delete bin trash remove'],
  ['🔒', 'locked', 'secure private closed lock'],
  ['🔓', 'unlocked', 'open access unlock'],
  ['🔑', 'key', 'password access unlock secret'],
  ['⚙️', 'gear', 'settings config mechanism options'],
  ['🔧', 'wrench', 'fix tool repair maintenance'],
  ['🔨', 'hammer', 'build fix tool'],
  ['🛠️', 'hammer and wrench', 'tools build maintenance fix'],
  ['🔌', 'plug', 'power connect electric'],
  ['🔋', 'battery', 'power charge energy'],
  ['📡', 'satellite dish', 'signal network broadcast antenna'],
  ['🛰️', 'satellite', 'space orbit signal'],
  ['☁️', 'cloud', 'weather server internet storage'],
  ['🌐', 'globe with meridians', 'web internet world network'],
  ['🖇️', 'linked paperclips', 'attach group link'],
  ['📦', 'package', 'box parcel module bundle'],
  ['🧰', 'toolbox', 'tools kit repair'],
  ['🪛', 'screwdriver', 'fix tool adjust'],
  ['🧲', 'magnet', 'attract pull physics'],
  ['🔭', 'telescope', 'astronomy look far space'],

  // --- money, business ---------------------------------------------------
  ['💰', 'money bag', 'cash budget funds money'],
  ['💵', 'banknote', 'cash dollar money'],
  ['💳', 'credit card', 'payment pay card'],
  ['🧾', 'receipt', 'bill invoice expense'],
  ['🏦', 'bank', 'money finance building'],
  ['📮', 'postbox', 'mail send post'],
  ['✉️', 'envelope', 'email mail message letter'],
  ['📢', 'loudspeaker', 'announce notice broadcast shout'],
  ['📣', 'megaphone', 'announce cheer shout'],
  ['💬', 'speech balloon', 'comment talk chat message say'],
  ['💭', 'thought balloon', 'thinking idea dream wonder'],

  // --- time, nature, weather ---------------------------------------------
  ['🌞', 'sun with face', 'sunny day warm bright'],
  ['🌙', 'crescent moon', 'night late evening'],
  ['🌧️', 'rain cloud', 'rainy weather wet'],
  ['⛈️', 'thunder cloud', 'storm lightning weather'],
  ['❄️', 'snowflake', 'cold winter snow freeze'],
  ['🌈', 'rainbow', 'colour hope pride weather'],
  ['🌍', 'globe europe africa', 'world earth planet global'],
  ['🌊', 'wave', 'sea ocean water flow'],
  ['🌱', 'seedling', 'grow new start plant'],
  ['🌳', 'tree', 'nature plant forest'],
  ['🍀', 'four leaf clover', 'luck lucky fortune'],
  ['🐛', 'bug', 'insect error defect caterpillar'],
  ['🐞', 'lady beetle', 'bug insect ladybird'],
  ['🦋', 'butterfly', 'change insect transform'],

  // --- travel, places, things ---------------------------------------------
  ['🚀', 'rocket', 'launch fast start ship space'],
  ['✈️', 'aeroplane', 'flight travel plane'],
  ['🚗', 'car', 'drive travel vehicle'],
  ['🚦', 'traffic light', 'stop go signal wait'],
  ['🏁', 'chequered flag', 'finish end race done goal'],
  ['🚩', 'triangular flag', 'flag mark issue attention'],
  ['🏠', 'house', 'home building'],
  ['🏢', 'office building', 'work company business'],
  ['🗺️', 'world map', 'map plan route location'],
  ['🧭', 'compass', 'direction navigate find north'],
  ['🎒', 'backpack', 'school bag student'],
  ['☕', 'hot beverage', 'coffee tea break morning'],
  ['🍕', 'pizza', 'food lunch slice'],
  ['🎂', 'birthday cake', 'celebrate birthday party'],
  ['🎉', 'party popper', 'celebrate congrats yay'],
  ['🎁', 'gift', 'present reward surprise'],
  ['❤️', 'red heart', 'love like favourite'],
  ['💔', 'broken heart', 'sad breakup hurt'],
  ['🧡', 'orange heart', 'love like'],
  ['💛', 'yellow heart', 'love like'],
  ['💚', 'green heart', 'love like'],
  ['💙', 'blue heart', 'love like'],
  ['💜', 'purple heart', 'love like'],
  ['🖤', 'black heart', 'love dark'],
  ['🤍', 'white heart', 'love pure'],
  ['🎵', 'musical note', 'music sound song'],
  ['🔇', 'muted speaker', 'silent quiet mute'],
  ['🔊', 'loud speaker', 'sound volume audio loud'],
  ['📷', 'camera', 'photo picture snapshot'],
  ['🎥', 'movie camera', 'video film record'],
  ['🎬', 'clapper board', 'film action scene start'],
  ['🎨', 'artist palette', 'paint art colour design'],
  ['🎭', 'performing arts', 'drama theatre acting'],
  ['🕹️', 'joystick', 'game play arcade'],
  ['🎲', 'game die', 'random chance dice luck'],
  ['🧿', 'nazar amulet', 'protection luck charm'],

  // --- shapes and blocks ---------------------------------------------------
  ['🔴', 'red circle', 'dot stop bullet red'],
  ['🟠', 'orange circle', 'dot bullet orange'],
  ['🟡', 'yellow circle', 'dot bullet yellow'],
  ['🟢', 'green circle', 'dot go ok bullet green'],
  ['🔵', 'blue circle', 'dot bullet blue'],
  ['🟣', 'purple circle', 'dot bullet purple'],
  ['⚫', 'black circle', 'dot bullet dark'],
  ['⚪', 'white circle', 'dot bullet light'],
  ['🟥', 'red square', 'block box red'],
  ['🟧', 'orange square', 'block box orange'],
  ['🟨', 'yellow square', 'block box yellow'],
  ['🟩', 'green square', 'block box green'],
  ['🟦', 'blue square', 'block box blue'],
  ['🟪', 'purple square', 'block box purple'],
  ['⬛', 'black square', 'block box dark'],
  ['⬜', 'white square', 'block box light'],
  ['🔶', 'orange diamond', 'diamond decision shape'],
  ['🔷', 'blue diamond', 'diamond decision shape']
];

/**
 * Groups, in the order the picker shows them.
 *
 * The ranges are the catalogue's own order, so adding an entry in the middle
 * of a section does not mean renumbering anything: the boundaries are found
 * by the first character of each group.
 */
const GROUP_STARTS = [
  ['Marks', '✅'], ['Arrows', '➡️'], ['Faces', '🙂'], ['Hands', '👍'],
  ['Study', '💡'], ['Things', '💻'], ['Money', '💰'], ['Nature', '🌞'],
  ['Places', '🚀'], ['Shapes', '🔴']
];

export const EMOJI = CATALOGUE.map(([ch, name, keywords]) => ({ ch, name, keywords }));

export const EMOJI_GROUPS = GROUP_STARTS.map(([label, first], i) => {
  const from = EMOJI.findIndex((e) => e.ch === first);
  const nextFirst = GROUP_STARTS[i + 1]?.[1];
  const to = nextFirst ? EMOJI.findIndex((e) => e.ch === nextFirst) : EMOJI.length;
  return { label, items: EMOJI.slice(from, to) };
});

/**
 * Find emoji for what was typed.
 *
 * Whole words beat fragments, which is the difference between typing "tick"
 * and being offered the check mark rather than the joystick, and between
 * "star" finding the star rather than everything whose keywords mention
 * starting. Several words all have to match, so "up arrow" narrows rather
 * than widening. An empty query answers nothing and the picker shows its
 * groups instead.
 */
export function searchEmoji(query, limit = 60) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const e of EMOJI) {
    const name = e.name.toLowerCase();
    const kw = e.keywords.toLowerCase().split(/\s+/);
    const hay = name + ' ' + e.keywords.toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    const first = words[0];
    const nameWords = name.split(/\s+/);
    let score;
    if (name === first) score = 0;                               // the thing itself
    else if (name.startsWith(first)) score = 1;                  // "star" -> "star"
    else if (nameWords.includes(first)) score = 2;               // a word of the name
    else if (kw.includes(first)) score = 3 + kw.indexOf(first) / 100;  // a keyword, best first
    else if (name.includes(first)) score = 6;                    // buried in the name
    else score = 7;                                              // buried in a keyword
    scored.push({ e, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.e);
}
