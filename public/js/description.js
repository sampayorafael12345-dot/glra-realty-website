/* description.js — lay a listing description out top to bottom.

   This is about LAYOUT, not content. The descriptions are written as posts,
   with an icon starting most lines, and they are meant to read as a list:

       📌 HOUSE AND LOT FOR SALE — BRGY. HIGHWAY HILLS
       🔹 Land Area: 400.00 SQM
       🔹 Selling Price: ₱65,000,000.00

   The icons stay. They are the author's own structure and they are what makes
   the list scannable. What this does is make sure each item actually starts on
   its own line, and repairs the one thing that genuinely renders wrong.

   THE ONE REPAIR. A line written as

       📧 [glrarealty@gmail.com](mailto:glrarealty@gmail.com)

   is markdown. A web page has no idea what that is, so it prints the whole
   string — brackets, "mailto:", the address twice — in the middle of the text.
   That becomes just the address.

   Loaded by the browser as a plain script (sets window.glraCleanDescription)
   and by server.js with require(), so the listing page and the modals on
   properties.html and index.html lay a description out identically. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.glraCleanDescription = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The icons that start a line in these posts. Used only to find where a new
  // item begins — they are kept in the output exactly as written.
  var LEAD = /^\s*(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}][\u{FE0F}\u{20E3}]?|[▪▸‣⁃•●◦❖◆])\s*/u;
  // The same set, found anywhere in a line: that is a new item that lost its
  // line break somewhere between the post and the database.
  var INLINE = /(?!^)\s*((?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}][\u{FE0F}\u{20E3}]?|[▪▸‣⁃•●◦❖◆])\s*)/gu;

  return function glraCleanDescription(raw) {
    var s = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n');

    // Markdown links print as their own source text on a web page.
    s = s.replace(/\[([^\]]*)\]\((?:mailto:|https?:\/\/|tel:)[^)]*\)/gi, '$1');
    s = s.replace(/\]\((?:mailto:|https?:\/\/|tel:)[^)]*\)/gi, '');

    // One item per line. An icon already starting a line is left alone; one
    // found mid-line means that item lost its break, so give it one back.
    s = s.split('\n').map(function (line) {
      var lead = '';
      var m = line.match(LEAD);
      if (m) { lead = m[0].replace(/\s+$/, ' ').replace(/^\s+/, ''); line = line.slice(m[0].length); }
      return lead + line.replace(INLINE, '\n$1');
    }).join('\n');

    // Tidy the spacing without touching the words: trailing spaces off, runs
    // of blank lines down to one, so the sections stay separated but the list
    // inside each one stays tight.
    s = s.split('\n')
         .map(function (l) { return l.replace(/[ \t]+$/, '').replace(/[ \t]{2,}/g, ' '); })
         .join('\n')
         .replace(/\n{3,}/g, '\n\n')
         .trim();

    return s;
  };
});
