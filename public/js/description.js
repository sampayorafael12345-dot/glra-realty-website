/* description.js — one source of truth for turning a listing description that
   was written for a Facebook post into one that belongs on a website.

   Catherine writes her listings as social posts, and they are imported here as
   they were typed. That means every description arrives carrying:

     - decorative emoji on almost every line
     - her own contact block: name, agency, mobile, email
     - a markdown mail link, `[glrarealty@gmail.com](mailto:glrarealty@gmail.com)`,
       which a web page renders as that whole string in the middle of a sentence
     - a tail of hashtags

   None of it belongs on the listing page, which already carries a contact form,
   the phone number and the email in its own footer.

   This runs at RENDER time, not on the stored text. Two reasons: the original
   post is preserved exactly as written, and the next import cannot bring the
   noise back — which is what had been happening.

   Loaded by the browser as a plain script (sets window.glraCleanDescription)
   and by server.js with require(), so the listing page and the modals on
   properties.html and index.html all clean the text identically. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.glraCleanDescription = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Kept deliberately: the peso sign, the registered mark, en/em dashes and
  // the typographic bullets. Those carry meaning; the pictographs do not.
  var EMOJI = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}]/gu;
  var BULLETS = '▪▸‣⁃·•●◦❖◆';
  var BULLET_ONE = new RegExp('[' + BULLETS + ']');
  var BULLET_ANY = new RegExp('[ \\t]*[' + BULLETS + '][ \\t]*', 'g');

  return function glraCleanDescription(raw) {
    var s = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n');

    // A markdown link renders as its own source text here. Keep the label.
    s = s.replace(/\[([^\]]*)\]\((?:mailto:|https?:\/\/|tel:)[^)]*\)/gi, '$1');
    s = s.replace(/\]\((?:mailto:|https?:\/\/|tel:)[^)]*\)/gi, '');

    s = s.replace(EMOJI, '');

    /* The sign-off block, removed as a BOUNDED run rather than by cutting to
       the end of the text. One live listing holds two posts pasted together —
       a condo and a parking slot — and cutting from the first "For inquiries"
       to the end silently deleted the whole second one.

       So: a trigger line opens the block, and the block closes at the first
       line that is not part of a contact sign-off. Anything after it survives. */
    /* Two sign-off styles are in use across the live listings, under two
       different names — "CATHERINE SB SAMPAYO" and "Kate Sampayo" — with two
       different taglines. Both are matched here. */
    var TRIGGER = /\b(?:for inquiries|for inquiry|for more details|for more info|to inquire|site viewing|viewing schedule|viewing appointments|schedule a viewing|book a viewing|for reservation|property collaboration|send us a private message)\b/i;
    var SIGNOFF = [
      /^$/,
      /^#/,                                              // hashtags
      /^CATHERINE\s+SB\s+SAMPAYO\b/i,
      /^KATE\s+SAMPAYO\b/i,
      /^[A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,3},?\s+REALTOR\b/i,   // "<name>, Realtor(R)"
      /^GLRA\s+(?:REALTY|SECRETARIAT)\b/i,
      /^REALTOR\b/i,
      /^PRC\s+(?:REB\s+)?LIC/i,                          // licence line
      /^WE HELP PEOPLE AND HOME FIND EACH OTHER/i,
      /^BRINGING PEOPLE AND THEIR HOMES TOGETHER/i,
      // A phone line, bare or behind a short label ("Primary:", "Mobile:").
      /^(?:primary|secondary|mobile|phone|tel|telephone|contact|viber|whatsapp)?\s*:?\s*\+?63[\d\s().-]{7,}$/i,
      /^(?:primary|secondary|mobile|phone|tel|telephone|contact|viber|whatsapp)?\s*:?\s*0\d{3}[\s.-]?\d{3}[\s.-]?\d{4}$/i,
      /^(?:email|e-mail)?\s*:?\s*[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i,
      /^CONTACT (?:DETAILS|US|INFO)/i
    ];
    function isSignoffLine(line) {
      return SIGNOFF.some(function (re) { return re.test(line); });
    }

    var lines = s.split('\n'), kept = [], skipping = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!skipping && TRIGGER.test(line)) { skipping = true; continue; }
      if (skipping) {
        if (isSignoffLine(line)) continue;
        skipping = false;                                // real content again
      }
      kept.push(lines[i]);
    }

    /* Some posts end with the same block and no lead-in line at all, so
       nothing above opens the run. Trim it from the END instead: walk
       backwards while the lines still look like a sign-off. Only ever
       shortens the tail, so it cannot eat content in the middle. */
    while (kept.length && isSignoffLine(kept[kept.length - 1].trim())) kept.pop();

    s = kept.join('\n');

    // A hashtag tail can also appear without a trigger line in front of it.
    s = s.replace(/(^|\n)[ \t]*#[^\n]*/g, '$1');

    // One bullet shape. A bullet already starting its line keeps that line;
    // one found mid-line starts a new one. Doing both in a single pass put a
    // blank line in front of every bullet.
    s = s.split('\n').map(function (line) {
      var t = line.replace(/^[ \t]+/, '');
      var lead = '';
      if (BULLET_ONE.test(t.charAt(0))) {
        lead = '• ';
        t = t.slice(1).replace(/^[ \t]+/, '');
      }
      return lead + t.replace(BULLET_ANY, '\n• ');
    }).join('\n');

    // Collapse the whitespace the cuts left behind.
    s = s.split('\n')
         .map(function (l) { return l.replace(/[ \t]{2,}/g, ' ').trim(); })
         .filter(function (l) { return l !== '•' && l !== '-' && l !== '–'; })
         .join('\n')
         .replace(/\n{3,}/g, '\n\n')
         .trim();

    return s;
  };
});
