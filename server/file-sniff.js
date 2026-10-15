// =============================================================================
// FILE SNIFF — what an uploaded file really is, from its first bytes
// =============================================================================
// multer's fileFilter only sees the type the browser DECLARES, which is
// whatever the sender typed. The staff upload routes (cases, leasing) call
// checkUpload() on the saved temp file before it goes to Cloudinary, so an
// HTML page or a script renamed "contract.pdf" is refused instead of stored
// and later handed out through a signed link.
//
// Allowed kinds match ALLOWED_TASK_ATTACHMENT_MIMES in server.js: photos
// (JPEG, PNG, WebP, GIF, HEIC/HEIF), PDF, Word/Excel (old OLE files and the
// newer zip-based .docx/.xlsx) and plain text / CSV.
// =============================================================================
const fs = require('fs');

function readHead(p, n) {
  try {
    const fd = fs.openSync(p, 'r');
    const b = Buffer.alloc(n);
    const got = fs.readSync(fd, b, 0, n, 0);
    fs.closeSync(fd);
    return b.slice(0, got);
  } catch { return null; }
}

// 'jpeg' | 'png' | 'webp' | 'gif' | 'heic' | 'pdf' | 'ole' | 'zip' | 'text' | ''
function sniffKind(p) {
  const b = readHead(p, 4096);
  if (!b || !b.length) return '';
  const s = (from, to) => b.slice(from, to).toString('latin1');
  if (s(0, 4) === '%PDF') return 'pdf';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return 'webp';
  if (/^GIF8[79]a/.test(s(0, 6))) return 'gif';
  // ISO-BMFF: "....ftyp" + a HEIF brand
  if (s(4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif)$/.test(s(8, 12))) return 'heic';
  if (b.length >= 8 && b.slice(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'ole';
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'zip';
  // Plain text: no NUL bytes, and not markup a browser would run.
  if (!b.includes(0)) {
    const head = b.toString('utf8').replace(/^﻿/, '').trimStart().slice(0, 200).toLowerCase();
    if (/^<(!doctype|html|script|svg|\?xml|body|iframe)/.test(head)) return '';
    return 'text';
  }
  return '';
}

const KIND_FOR_MIME = {
  'image/jpeg': ['jpeg'], 'image/pjpeg': ['jpeg'], 'image/png': ['png'], 'image/webp': ['webp'], 'image/gif': ['gif'],
  'image/heic': ['heic'], 'image/heif': ['heic'],
  'application/pdf': ['pdf'],
  'application/msword': ['ole'], 'application/vnd.ms-excel': ['ole'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['zip'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['zip'],
  'text/plain': ['text'], 'text/csv': ['text']
};

// '' when the file's content matches what it claims to be, else a message.
function checkUpload(file) {
  if (!file || !file.path) return 'No file provided';
  const want = KIND_FOR_MIME[String(file.mimetype || '').toLowerCase()];
  const got = sniffKind(file.path);
  if (!want || !got || !want.includes(got)) {
    return 'That file\'s contents do not match its type. Use a photo, PDF, Word, Excel or plain-text file.';
  }
  return '';
}

module.exports = { sniffKind, checkUpload };
