/**
 * מעקב השאלות ספרים — Google Apps Script
 * הסקריפט מחובר ל-Google Sheet. הנתונים נשמרים בשני גיליונות: "ספרים" ו"השאלות".
 */

const SHEET_BOOKS = 'ספרים';
const SHEET_LOANS = 'השאלות';
const BOOK_HEADERS = ['מזהה', 'ברקוד/ISBN', 'שם', 'מחבר', 'שפה', 'כריכה (קישור)', 'הערות', 'נוסף בתאריך'];
const LOAN_HEADERS = ['מזהה השאלה', 'מזהה ספר', 'שם הספר', 'שואל/ת', 'תאריך השאלה', 'תאריך החזרה'];

// ---------- Web app / API ----------
//
// GET  ?api=public         → קטלוג ציבורי (בלי שמות שואלים). משמש את האתר.
// GET  ?key=<מפתח>         → ממשק הניהול בדפדפן (גיבוי לאפליקציה).
// POST {key, fn, args}     → API לאפליקציה (קריאה וכתיבה).
//
// המפתח נשמר ב-Script Properties בשם API_KEY. ליצירה: להריץ פעם אחת את createApiKey().

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.api === 'public') return json_({ ok: true, result: getPublicCatalog() });
  if (p.key && p.key === apiKey_()) {
    return HtmlService.createHtmlOutputFromFile('Index')
      .setTitle('מאורת הספרים')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1');
  }
  return HtmlService.createHtmlOutput('<p dir="rtl" style="font-family:sans-serif">🐉 מאורת הספרים</p>');
}

const API_FUNCTIONS = { getData, saveBook, deleteBook, lendBook, returnBook, lookupIsbn };

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (!req.key || req.key !== apiKey_()) return json_({ ok: false, error: 'מפתח שגוי' });
    const fn = API_FUNCTIONS[req.fn];
    if (!fn) return json_({ ok: false, error: 'פעולה לא מוכרת: ' + req.fn });
    return json_({ ok: true, result: fn.apply(null, req.args || []) });
  } catch (err) {
    return json_({ ok: false, error: err.message || String(err) });
  }
}

/** קטלוג לאתר הציבורי: רק פרטי ספר וזמינות. נשמר בזיכרון ל-5 דקות. */
function getPublicCatalog() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('public');
  if (hit) return JSON.parse(hit);
  const d = getData();
  const lent = {};
  d.loans.forEach(l => { if (!l.returnDate) lent[l.bookId] = true; });
  const out = d.books.map(b => ({ title: b.title, author: b.author, lang: b.lang, cover: b.cover, code: b.code, available: !lent[b.id] }));
  try { cache.put('public', JSON.stringify(out), 300); } catch (e) { }
  return out;
}

function clearPublicCache_() { CacheService.getScriptCache().remove('public'); }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function apiKey_() {
  return PropertiesService.getScriptProperties().getProperty('API_KEY') || '__unset__' + Math.random();
}

/** להריץ פעם אחת מהעורך. המפתח מודפס ב-Execution log. */
function createApiKey() {
  const key = Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('API_KEY', key);
  Logger.log('API_KEY: ' + key);
  return key;
}

// ---------- Sheet helpers ----------

function getSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sh.setRightToLeft(true);
  }
  return sh;
}

function rows_(sh) {
  const values = sh.getDataRange().getValues();
  values.shift(); // headers
  return values;
}

function fmtDate_(d) {
  if (!d) return '';
  if (!(d instanceof Date)) d = new Date(d);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function newId_() {
  return Utilities.getUuid().slice(0, 8);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); clearPublicCache_(); }
}

/** הרצה ידנית פעם אחת (לא חובה): יוצר את הגיליונות. */
function setup() {
  getSheet_(SHEET_BOOKS, BOOK_HEADERS);
  getSheet_(SHEET_LOANS, LOAN_HEADERS);
}

// ---------- API for the web app ----------

/** מחזיר את כל הספרים עם הסטטוס הנוכחי, ואת היסטוריית ההשאלות. */
function getData() {
  const books = rows_(getSheet_(SHEET_BOOKS, BOOK_HEADERS)).map(r => ({
    id: String(r[0]), code: String(r[1]), title: r[2], author: r[3],
    lang: r[4], cover: r[5], notes: r[6], added: fmtDate_(r[7])
  }));
  const loans = rows_(getSheet_(SHEET_LOANS, LOAN_HEADERS)).map(r => ({
    id: String(r[0]), bookId: String(r[1]), title: r[2], borrower: r[3],
    loanDate: fmtDate_(r[4]), returnDate: fmtDate_(r[5])
  }));
  return { books: books, loans: loans };
}

function saveBook(book) {
  return withLock_(() => {
    const sh = getSheet_(SHEET_BOOKS, BOOK_HEADERS);
    const data = sh.getDataRange().getValues();
    const code = String(book.code || '').trim();

    if (book.id) { // עדכון
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][0]) === book.id) {
          sh.getRange(i + 1, 2, 1, 6).setValues([[code, book.title, book.author, book.lang, book.cover || '', book.notes || '']]);
          return book.id;
        }
      }
      throw new Error('הספר לא נמצא');
    }

    if (code) {
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][1]) === code) throw new Error('ספר עם הברקוד הזה כבר קיים: ' + data[i][2]);
      }
    }
    const id = newId_();
    sh.appendRow([id, code, book.title, book.author || '', book.lang || '', book.cover || '', book.notes || '', new Date()]);
    // שמירת הברקוד כטקסט (שלא יהפוך למספר מדעי)
    sh.getRange(sh.getLastRow(), 2).setNumberFormat('@').setValue(code);
    return id;
  });
}

function deleteBook(bookId) {
  return withLock_(() => {
    if (openLoanRow_(bookId)) throw new Error('הספר מושאל כרגע. סמני "הוחזר" לפני מחיקה.');
    const sh = getSheet_(SHEET_BOOKS, BOOK_HEADERS);
    const data = sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === bookId) { sh.deleteRow(i + 1); return true; }
    }
    return false;
  });
}

function lendBook(bookId, borrower) {
  borrower = String(borrower || '').trim();
  if (!borrower) throw new Error('חסר שם השואל/ת');
  return withLock_(() => {
    if (openLoanRow_(bookId)) throw new Error('הספר כבר מושאל');
    const title = bookTitle_(bookId);
    getSheet_(SHEET_LOANS, LOAN_HEADERS).appendRow([newId_(), bookId, title, borrower, new Date(), '']);
    return true;
  });
}

function returnBook(bookId) {
  return withLock_(() => {
    const row = openLoanRow_(bookId);
    if (!row) throw new Error('הספר לא מושאל כרגע');
    getSheet_(SHEET_LOANS, LOAN_HEADERS).getRange(row, 6).setValue(new Date());
    return true;
  });
}

function openLoanRow_(bookId) {
  const data = getSheet_(SHEET_LOANS, LOAN_HEADERS).getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][1]) === bookId && !data[i][5]) return i + 1;
  }
  return 0;
}

function bookTitle_(bookId) {
  const data = getSheet_(SHEET_BOOKS, BOOK_HEADERS).getDataRange().getValues();
  for (let i = 1; i < data.length; i++) if (String(data[i][0]) === bookId) return data[i][2];
  throw new Error('הספר לא נמצא');
}

// ---------- ISBN lookup ----------

/** מחפש פרטי ספר לפי ISBN ב-Google Books ואז ב-Open Library. מחזיר null אם לא נמצא. */
function lookupIsbn(isbn) {
  isbn = String(isbn).replace(/[^0-9X]/gi, '');
  if (!isbn) return null;

  try {
    const r = UrlFetchApp.fetch('https://www.googleapis.com/books/v1/volumes?q=isbn:' + isbn, { muteHttpExceptions: true });
    if (r.getResponseCode() === 200) {
      const j = JSON.parse(r.getContentText());
      if (j.totalItems && j.items && j.items.length) {
        const v = j.items[0].volumeInfo;
        const cover = v.imageLinks ? (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail || '').replace('http://', 'https://') : '';
        return { title: v.title + (v.subtitle ? ': ' + v.subtitle : ''), author: (v.authors || []).join(', '), lang: langOf_(v.language, v.title), cover: cover };
      }
    }
  } catch (e) { /* ממשיכים למקור הבא */ }

  try {
    const r = UrlFetchApp.fetch('https://openlibrary.org/api/books?bibkeys=ISBN:' + isbn + '&format=json&jscmd=data', { muteHttpExceptions: true });
    if (r.getResponseCode() === 200) {
      const b = JSON.parse(r.getContentText())['ISBN:' + isbn];
      if (b) {
        return { title: b.title, author: (b.authors || []).map(a => a.name).join(', '), lang: langOf_('', b.title), cover: b.cover ? (b.cover.medium || b.cover.small || '') : '' };
      }
    }
  } catch (e) { }

  return null;
}

function langOf_(code, title) {
  if (code === 'he' || code === 'iw' || /[֐-׿]/.test(title || '')) return 'עברית';
  if (code === 'en' || /^[\x00-\x7F]+$/.test(title || '')) return 'אנגלית';
  return '';
}
