/*
 * A Stoic line under "Happy Inking !!" on an empty board.
 *
 * Every quote is copied word for word from a public-domain translation:
 *   Marcus Aurelius, Meditations - George Long, 1862
 *   Epictetus, Enchiridion       - T. W. Higginson, 1865 (standard chapter numbers)
 *   Seneca, Minor Dialogues      - Aubrey Stewart, 1889
 *
 * Each board keeps ONE quote for good, the way a notebook keeps its cover:
 *
 *   - A board made from now on stores the id of its quote (doc.quote), picked
 *     from the whole list when it is made.
 *   - A board from before quotes has no id. It gets one worked out from its own
 *     board id, over the first FIRST_BATCH quotes only. That count never
 *     changes, so adding quotes later never moves an old board's quote.
 *
 * So the rules for this list are:
 *   - an id is never reused, renumbered or removed;
 *   - new quotes only ever go on the END, with the next id;
 *   - FIRST_BATCH stays 118 for ever.
 *
 * The quote is drawn over the board like the greeting, never on it: it is not
 * an object, so it is never saved into a picture, a PDF, a print or a share.
 */

export const FIRST_BATCH = 118;

export const QUOTES = [
  { id: 1, text: "Give thyself time to learn something new and good, and cease to be whirled around.", by: "Marcus Aurelius", ref: "Meditations 2.7" },
  { id: 2, text: "A man then must stand erect, not be kept erect by others.", by: "Marcus Aurelius", ref: "Meditations 3.5" },
  { id: 3, text: "Let no act be done without a purpose, nor otherwise than according to the perfect principles of art.", by: "Marcus Aurelius", ref: "Meditations 4.2" },
  { id: 4, text: "While thou livest, while it is in thy power, be good.", by: "Marcus Aurelius", ref: "Meditations 4.17" },
  { id: 5, text: "Neither worse then nor better is a thing made by being praised.", by: "Marcus Aurelius", ref: "Meditations 4.20" },
  { id: 6, text: "Thou must turn to profit the present by the aid of reason and justice.", by: "Marcus Aurelius", ref: "Meditations 4.26" },
  { id: 7, text: "Be like the promontory against which the waves continually break, but it stands firm and tames the fury of the water around it.", by: "Marcus Aurelius", ref: "Meditations 4.49" },
  { id: 8, text: "In the morning when thou risest unwillingly, let this thought be present — I am rising to the work of a human being.", by: "Marcus Aurelius", ref: "Meditations 5.1" },
  { id: 9, text: "Such as are thy habitual thoughts, such also will be the character of thy mind; for the soul is dyed by the thoughts.", by: "Marcus Aurelius", ref: "Meditations 5.16" },
  { id: 10, text: "Nothing happens to any man which he is not formed by nature to bear.", by: "Marcus Aurelius", ref: "Meditations 5.18" },
  { id: 11, text: "Strive to continue to be such as philosophy wished to make thee.", by: "Marcus Aurelius", ref: "Meditations 6.30" },
  { id: 12, text: "Accustom thyself to attend carefully to what is said by another, and as much as it is possible, be in the speaker’s mind.", by: "Marcus Aurelius", ref: "Meditations 6.53" },
  { id: 13, text: "That which is not good for the swarm, neither is it good for the bee.", by: "Marcus Aurelius", ref: "Meditations 6.54" },
  { id: 14, text: "Be not ashamed to be helped; for it is thy business to do thy duty like a soldier in the assault on a town.", by: "Marcus Aurelius", ref: "Meditations 7.7" },
  { id: 15, text: "Whatever any one does or says, I must be emerald and keep my color.", by: "Marcus Aurelius", ref: "Meditations 7.15" },
  { id: 16, text: "Look within. Within is the fountain of good, and it will ever bubble up, if thou wilt ever dig.", by: "Marcus Aurelius", ref: "Meditations 7.59" },
  { id: 17, text: "Very little indeed is necessary for living a happy life.", by: "Marcus Aurelius", ref: "Meditations 7.67" },
  { id: 18, text: "Remember that to change thy opinion and to follow him who corrects thy error is as consistent with freedom as it is to persist in thy error.", by: "Marcus Aurelius", ref: "Meditations 8.16" },
  { id: 19, text: "Attend to the matter which is before thee, whether it is an opinion or an act or a word.", by: "Marcus Aurelius", ref: "Meditations 8.22" },
  { id: 20, text: "Speak both in the senate and to every man, whoever he may be, appropriately, not with any affectation: use plain discourse.", by: "Marcus Aurelius", ref: "Meditations 8.30" },
  { id: 21, text: "If thou art pained by any external thing, it is not this thing that disturbs thee, but thy own judgment about it.", by: "Marcus Aurelius", ref: "Meditations 8.47" },
  { id: 22, text: "Men exist for the sake of one another. Teach them then, or bear with them.", by: "Marcus Aurelius", ref: "Meditations 8.59" },
  { id: 23, text: "If a man is mistaken, instruct him kindly and show him his error.", by: "Marcus Aurelius", ref: "Meditations 10.4" },
  { id: 24, text: "No longer talk at all about the kind of man that a good man ought to be, but be such.", by: "Marcus Aurelius", ref: "Meditations 10.16" },
  { id: 25, text: "Neither in writing nor in reading wilt thou be able to lay down rules for others before thou shalt have first learned to obey rules thyself.", by: "Marcus Aurelius", ref: "Meditations 11.29" },
  { id: 26, text: "Practise thyself even in the things which thou despairest of accomplishing.", by: "Marcus Aurelius", ref: "Meditations 12.6" },
  { id: 27, text: "Consider that everything is opinion, and opinion is in thy power.", by: "Marcus Aurelius", ref: "Meditations 12.22" },
  { id: 28, text: "Since it is possible that thou mayest depart from life this very moment, regulate every act and thought accordingly.", by: "Marcus Aurelius", ref: "Meditations 2.11" },
  { id: 29, text: "Do not waste the remainder of thy life in thoughts about others, when thou dost not refer thy thoughts to some object of common utility.", by: "Marcus Aurelius", ref: "Meditations 3.4" },
  { id: 30, text: "Be cheerful also, and seek not external help nor the tranquillity which others give.", by: "Marcus Aurelius", ref: "Meditations 3.5" },
  { id: 31, text: "Reverence the faculty which produces opinion.", by: "Marcus Aurelius", ref: "Meditations 3.9" },
  { id: 32, text: "Do not have such an opinion of things as he has who does thee wrong, or such as he wishes thee to have, but look at them as they are in truth.", by: "Marcus Aurelius", ref: "Meditations 4.11" },
  { id: 33, text: "Do not act as if thou wert going to live ten thousand years.", by: "Marcus Aurelius", ref: "Meditations 4.17" },
  { id: 34, text: "Now a man should take away not only unnecessary acts, but also unnecessary thoughts, for thus superfluous acts will not follow after.", by: "Marcus Aurelius", ref: "Meditations 4.24" },
  { id: 35, text: "Always run to the short way; and the short way is the natural.", by: "Marcus Aurelius", ref: "Meditations 4.51" },
  { id: 36, text: "How easy it is to repel and to wipe away every impression which is troublesome or unsuitable, and immediately to be in all tranquillity.", by: "Marcus Aurelius", ref: "Meditations 5.2" },
  { id: 37, text: "Where a man can live, there he can also live well.", by: "Marcus Aurelius", ref: "Meditations 5.16" },
  { id: 38, text: "Thou canst pass thy life in an equable flow of happiness, if thou canst go by the right way, and think and act in the right way.", by: "Marcus Aurelius", ref: "Meditations 5.34" },
  { id: 39, text: "Let neither the peculiar quality of anything nor its value escape thee.", by: "Marcus Aurelius", ref: "Meditations 6.3" },
  { id: 40, text: "Teach them then, and show them without being angry.", by: "Marcus Aurelius", ref: "Meditations 6.27" },
  { id: 41, text: "One thing here is worth a great deal, to pass thy life in truth and justice, with a benevolent disposition even to liars and unjust men.", by: "Marcus Aurelius", ref: "Meditations 6.47" },
  { id: 42, text: "Look at things again as thou didst use to look at them; for in this consists the recovery of thy life.", by: "Marcus Aurelius", ref: "Meditations 7.2" },
  { id: 43, text: "In discourse thou must attend to what is said, and in every movement thou must observe what is doing.", by: "Marcus Aurelius", ref: "Meditations 7.4" },
  { id: 44, text: "It is peculiar to man to love even those who do wrong.", by: "Marcus Aurelius", ref: "Meditations 7.22" },
  { id: 45, text: "Understand well what happens either to thee or to another.", by: "Marcus Aurelius", ref: "Meditations 7.29" },
  { id: 46, text: "Adorn thyself with simplicity and modesty.", by: "Marcus Aurelius", ref: "Meditations 7.31" },
  { id: 47, text: "It is royal to do good and to be abused.", by: "Marcus Aurelius", ref: "Meditations 7.36" },
  { id: 48, text: "It is most necessary to bear this constantly in mind, for thus thou wilt be more gentle towards all.", by: "Marcus Aurelius", ref: "Meditations 7.63" },
  { id: 49, text: "Do not then be tired of receiving what is useful by doing it to others.", by: "Marcus Aurelius", ref: "Meditations 7.74" },
  { id: 50, text: "On the occasion of every act ask thyself, How is this with respect to me?", by: "Marcus Aurelius", ref: "Meditations 8.2" },
  { id: 51, text: "All things are change, yet we need not fear anything new.", by: "Marcus Aurelius", ref: "Meditations 8.6" },
  { id: 52, text: "It is satisfaction to a man to do the proper works of a man.", by: "Marcus Aurelius", ref: "Meditations 8.26" },
  { id: 53, text: "Do not disturb thyself by thinking of the whole of thy life.", by: "Marcus Aurelius", ref: "Meditations 8.36" },
  { id: 54, text: "Say nothing more to thyself than what the first appearances report.", by: "Marcus Aurelius", ref: "Meditations 8.49" },
  { id: 55, text: "Enter into every man’s ruling faculty; and also let every other man enter into thine.", by: "Marcus Aurelius", ref: "Meditations 8.61" },
  { id: 56, text: "He who does wrong does wrong against himself.", by: "Marcus Aurelius", ref: "Meditations 9.4" },
  { id: 57, text: "If thou art able, correct by teaching those who do wrong.", by: "Marcus Aurelius", ref: "Meditations 9.11" },
  { id: 58, text: "To-day I have got out of all trouble, or rather I have cast out all trouble, for it was not outside, but within and in my opinions.", by: "Marcus Aurelius", ref: "Meditations 9.13" },
  { id: 59, text: "As thou thyself art a component part of a social system, so let every act of thine be a component part of social life.", by: "Marcus Aurelius", ref: "Meditations 9.23" },
  { id: 60, text: "He must use the power that he has and be tranquil.", by: "Marcus Aurelius", ref: "Meditations 9.39" },
  { id: 61, text: "He who follows reason in all things is both tranquil and active at the same time, and also cheerful and collected.", by: "Marcus Aurelius", ref: "Meditations 10.12" },
  { id: 62, text: "The healthy eye ought to see all visible things and not to say, I wish for green things.", by: "Marcus Aurelius", ref: "Meditations 10.35" },
  { id: 63, text: "Have I done something for the general interest?", by: "Marcus Aurelius", ref: "Meditations 11.4" },
  { id: 64, text: "There is no nature which is inferior to art, for the arts imitate the natures of things.", by: "Marcus Aurelius", ref: "Meditations 11.10" },
  { id: 65, text: "A good disposition is invincible if it be genuine, and not an affected smile and acting a part.", by: "Marcus Aurelius", ref: "Meditations 11.18" },
  { id: 66, text: "He who has not one and always the same object in life, cannot be one and the same all through his life.", by: "Marcus Aurelius", ref: "Meditations 11.21" },
  { id: 67, text: "All those things at which thou wishest to arrive by a circuitous road thou canst have now, if thou dost not refuse them to thyself.", by: "Marcus Aurelius", ref: "Meditations 12.1" },
  { id: 68, text: "See what things are in themselves, dividing them into matter, form, and purpose.", by: "Marcus Aurelius", ref: "Meditations 12.10" },
  { id: 69, text: "How ridiculous and what a stranger he is who is surprised at anything which happens in life.", by: "Marcus Aurelius", ref: "Meditations 12.13" },
  { id: 70, text: "Men are disturbed not by things, but by the views which they take of things.", by: "Epictetus", ref: "Enchiridion 5" },
  { id: 71, text: "Demand not that events should happen as you wish; but wish them to happen as they do happen, and you will go on well.", by: "Epictetus", ref: "Enchiridion 8" },
  { id: 72, text: "Never say of anything, “I have lost it,” but, “I have restored it.”", by: "Epictetus", ref: "Enchiridion 11" },
  { id: 73, text: "Begin therefore with little things.", by: "Epictetus", ref: "Enchiridion 12" },
  { id: 74, text: "If you would improve, be content to be thought foolish and dull with regard to externals.", by: "Epictetus", ref: "Enchiridion 13" },
  { id: 75, text: "You can be unconquerable if you enter into no combat in which it is not in your own power to conquer.", by: "Epictetus", ref: "Enchiridion 19" },
  { id: 76, text: "Be mostly silent, or speak merely what is needful, and in few words.", by: "Epictetus", ref: "Enchiridion 33" },
  { id: 77, text: "As in walking you take care not to tread upon a nail, or turn your foot, so likewise take care not to hurt the ruling faculty of your mind.", by: "Epictetus", ref: "Enchiridion 38" },
  { id: 78, text: "Everything has two handles: one by which it may be borne, another by which it cannot.", by: "Epictetus", ref: "Enchiridion 43" },
  { id: 79, text: "Never proclaim yourself a philosopher, nor make much talk among the ignorant about your principles, but show them by actions.", by: "Epictetus", ref: "Enchiridion 46" },
  { id: 80, text: "This instant, then, think yourself worthy of living as a man grown up and a proficient.", by: "Epictetus", ref: "Enchiridion 51" },
  { id: 81, text: "There are things which are within our power, and there are things which are beyond our power.", by: "Epictetus", ref: "Enchiridion 1" },
  { id: 82, text: "Where it is practically necessary for you to pursue or avoid anything, do even this with discretion and gentleness and moderation.", by: "Epictetus", ref: "Enchiridion 2" },
  { id: 83, text: "When you set about any action, remind yourself of what nature the action is.", by: "Epictetus", ref: "Enchiridion 4" },
  { id: 84, text: "Be not elated at any excellence not your own.", by: "Epictetus", ref: "Enchiridion 6" },
  { id: 85, text: "Upon every accident, remember to turn toward yourself and inquire what faculty you have for its use.", by: "Epictetus", ref: "Enchiridion 10" },
  { id: 86, text: "Exercise, therefore, what is in your power.", by: "Epictetus", ref: "Enchiridion 14" },
  { id: 87, text: "Remember that you must behave as at a banquet.", by: "Epictetus", ref: "Enchiridion 15" },
  { id: 88, text: "For this is your business—to act well the given part, but to choose it belongs to another.", by: "Epictetus", ref: "Enchiridion 17" },
  { id: 89, text: "Try, therefore, in the first place, not to be bewildered by appearances.", by: "Epictetus", ref: "Enchiridion 20" },
  { id: 90, text: "If you are persistent, those very persons who at first ridiculed will afterwards admire you.", by: "Epictetus", ref: "Enchiridion 22" },
  { id: 91, text: "It is enough if everyone fully performs his own proper business.", by: "Epictetus", ref: "Enchiridion 24" },
  { id: 92, text: "In every affair consider what precedes and what follows, and then undertake it.", by: "Epictetus", ref: "Enchiridion 29" },
  { id: 93, text: "You must be one man, either good or bad.", by: "Epictetus", ref: "Enchiridion 29" },
  { id: 94, text: "Duties are universally measured by relations.", by: "Epictetus", ref: "Enchiridion 30" },
  { id: 95, text: "Begin by prescribing to yourself some character and demeanor, such as you may preserve both alone and in company.", by: "Epictetus", ref: "Enchiridion 33" },
  { id: 96, text: "Do not say that he does it ill, but hastily.", by: "Epictetus", ref: "Enchiridion 45" },
  { id: 97, text: "The condition and characteristic of a philosopher is that he looks to himself for all help or harm.", by: "Epictetus", ref: "Enchiridion 48" },
  { id: 98, text: "Let whatever appears to be the best be to you an inviolable law.", by: "Epictetus", ref: "Enchiridion 51" },
  { id: 99, text: "Though you are not yet a Socrates, you ought, however, to live as one seeking to be a Socrates.", by: "Epictetus", ref: "Enchiridion 51" },
  { id: 100, text: "Fire tries gold, misfortune tries brave men.", by: "Seneca", ref: "Of Providence 5" },
  { id: 101, text: "Life is long enough, if you know how to use it.", by: "Seneca", ref: "Of the Shortness of Life 2" },
  { id: 102, text: "Men’s minds ought to have relaxation: they rise up better and more vigorous after rest.", by: "Seneca", ref: "Of Peace of Mind 17" },
  { id: 103, text: "No condition can be so wretched that an impartial mind can find no compensations in it.", by: "Seneca", ref: "Of Peace of Mind 10" },
  { id: 104, text: "Men deserve praise for engaging in profitable studies, even though they stop short of producing any results.", by: "Seneca", ref: "Of a Happy Life 20" },
  { id: 105, text: "The invulnerable is not that which is never struck, but that which is never wounded.", by: "Seneca", ref: "Of the Firmness of the Wise Man 3" },
  { id: 106, text: "Mankind is born for mutual assistance, anger for mutual ruin.", by: "Seneca", ref: "Of Anger I.5" },
  { id: 107, text: "In fine, the culture of any of the virtues is easy, while vices require a great expense.", by: "Seneca", ref: "Of Anger II.13" },
  { id: 108, text: "We should always allow some time to elapse, for time discloses the truth.", by: "Seneca", ref: "Of Anger II.22" },
  { id: 109, text: "What we want is straightforwardness, and a kindly interpretation of things.", by: "Seneca", ref: "Of Anger II.24" },
  { id: 110, text: "Now, we ought to be slow to believe what is told us.", by: "Seneca", ref: "Of Anger II.29" },
  { id: 111, text: "Anger often comes to us, but we often go to it.", by: "Seneca", ref: "Of Anger III.12" },
  { id: 112, text: "Our inward thoughts gradually become influenced by our outward demeanour.", by: "Seneca", ref: "Of Anger III.13" },
  { id: 113, text: "The spirit ought to be brought up for examination daily.", by: "Seneca", ref: "Of Anger III.36" },
  { id: 114, text: "A good man delights in receiving advice: all the worst men are the most impatient of guidance.", by: "Seneca", ref: "Of Anger III.36" },
  { id: 115, text: "The mind is strong enough to bear those evils for which it is prepared.", by: "Seneca", ref: "Of Anger III.37" },
  { id: 116, text: "There are many ways in which anger may be checked; most things may be turned into jest.", by: "Seneca", ref: "Of Anger III.11" },
  { id: 117, text: "Let a child hear the truth, and sometimes fear it: let him always reverence it.", by: "Seneca", ref: "Of Anger II.21" },
  { id: 118, text: "If he be weaker, spare him: if he be stronger, spare yourself.", by: "Seneca", ref: "Of Anger III.5" }
];

const BY_ID = new Map(QUOTES.map((q) => [q.id, q]));

/** A board's stored quote id is only kept when it looks like one. */
export function quoteId(v) {
  return Number.isInteger(v) && v > 0 && v < 1e6 ? v : undefined;
}

/** A quote for a brand new board, from the whole list. */
export function pickQuote(random = Math.random) {
  return QUOTES[Math.floor(random() * QUOTES.length) % QUOTES.length].id;
}

/** FNV-1a: small, fast, and the same answer on every device for ever. */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/**
 * The quote this board shows.
 *
 * Its own stored id when it has one this build knows. Otherwise - a board
 * from before quotes, or one made by a newer version with quotes this one has
 * not got yet - one chosen from its board id over the first batch only.
 */
export function quoteFor(doc) {
  if (!doc) return null;
  const own = BY_ID.get(quoteId(doc.quote));
  if (own) return own;
  return QUOTES[hash(String(doc.id || '')) % FIRST_BATCH];
}
