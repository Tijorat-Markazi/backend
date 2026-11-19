"use strict";
/* ============================================================
   TIJORAT MARKAZI — text out of document markup

   Pure functions, no I/O: srv/attachments.js hands them the parts it has
   already pulled out of a file. Every parser here makes one linear pass
   over its input, so a crafted file cannot make it backtrack (no ReDoS),
   and each stops once it has more text than the assistant will be shown.
     xmlText(xml)                       Word / PowerPoint / OpenDocument XML → text
     slidesText(get, candidates)        PowerPoint slides in presentation order
     workbookText(get, candidates)      Excel sheets, one tab-separated block each
     decodeText(buffer)                 UTF-8, BOM-marked UTF-16 or Windows-1251 → string; null when binary
     rtfText(source)                    RTF → text, control words and hidden groups removed
   `get(part)` returns a part's XML, or "" when the file has no such part.
   ============================================================ */

const OUTPUT_LIMIT = 200000;   // characters; srv/attachments.js shows fewer and says so
const MAX_CELL_GAP = 50;       // empty columns kept between two cells of a row
const MAX_RTF_DEPTH = 256;

const ENTITIES = { amp:"&", lt:"<", gt:">", quot:'"', apos:"'" };
function decodeEntities(s){
  return String(s).replace(/&(#x[0-9a-f]{1,8}|#\d{1,8}|[a-z]{1,10});/gi, (whole, e) => {
    if(e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? whole;
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : whole;
  });
}

const tidy = s => s.split("\n").map(line => line.replace(/ {2,}/g, " ").trim())
  .join("\n").replace(/\n{3,}/g, "\n\n").trim();

/* ---------- one pass over XML ----------
   A tag cannot contain "<", so the regex never scans a position twice; a
   stray "<" is passed on as text. */
const XML_TOKEN = /<([^<>]*)>|[^<]+|</g;
function* xmlTokens(xml){
  for(const m of String(xml).matchAll(XML_TOKEN)){
    if(m[1] === undefined){ yield { text: m[0] }; continue; }
    const raw = m[1];
    yield { raw, name: (raw.match(/^\/?([^\s/]+)/) || [])[1] || "", closing: raw[0] === "/", selfClosing: raw.endsWith("/") };
  }
}

const attrPatterns = new Map();
function attr(raw, name){
  if(!attrPatterns.has(name)) attrPatterns.set(name, new RegExp("\\s" + name + '="([^"]*)"'));
  const m = raw.match(attrPatterns.get(name));
  return m ? decodeEntities(m[1]) : "";
}

const LINE_ENDS = new Set(["w:p", "a:p", "text:p", "text:h", "table:table-row", "w:tr", "a:tr"]);
const LINE_BREAKS = new Set(["w:br", "w:cr", "a:br", "text:line-break"]);
const CELL_ENDS = new Set(["table:table-cell", "w:tc", "a:tc"]);
const TABS = new Set(["w:tab", "text:tab"]);
/* field codes, tracked deletions and tab-stop definitions are not text */
const SKIPPED = new Set(["w:instrText", "w:delText", "w:delInstrText", "w:tabs"]);

/* Paragraph and row ends become line breaks, cell ends tabs; every other tag
   is dropped without a space, because Word splits one word into several runs
   whenever its formatting or spell-check state changes. */
function xmlText(xml){
  const out = [];
  let size = 0, skipped = 0;
  const push = s => { out.push(s); size += s.length; };
  for(const t of xmlTokens(xml)){
    if(size > OUTPUT_LIMIT) break;
    if(t.text !== undefined){ if(!skipped) push(t.text); continue; }
    if(SKIPPED.has(t.name)){
      if(!t.selfClosing) skipped = Math.max(0, skipped + (t.closing ? -1 : 1));
      continue;
    }
    if(skipped) continue;
    if(t.closing){
      if(LINE_ENDS.has(t.name)) push("\n");
      else if(CELL_ENDS.has(t.name)) push("\t");
    } else if(t.selfClosing){
      if(LINE_BREAKS.has(t.name)) push("\n");
      else if(TABS.has(t.name)) push("\t");
      else if(t.name === "text:s") push(" ");
    }
  }
  return tidy(decodeEntities(out.join("")));
}

/* ---------- part order from a package's relationships ---------- */
function relationTargets(relsXml, base){
  const targets = new Map();
  for(const t of xmlTokens(relsXml)){
    if(t.name !== "Relationship" || t.closing) continue;
    const target = attr(t.raw, "Target");
    targets.set(attr(t.raw, "Id"), target.startsWith("/") ? target.slice(1) : base + target);
  }
  return targets;
}

const partNumber = name => Number((name.match(/(\d+)\.xml$/) || [])[1] || 0);

/* The parts `mainXml` lists, in its order, via `tag` elements' r:id; parts it
   does not list follow in numeric order. */
function orderedParts(candidates, mainXml, relsXml, base, tag){
  const targets = relationTargets(relsXml, base);
  const listed = [];
  for(const t of xmlTokens(mainXml)){
    if(t.name !== tag || t.closing) continue;
    const part = targets.get(attr(t.raw, "r:id"));
    if(part && candidates.includes(part) && !listed.some(l => l.part === part)) listed.push({ part, name: attr(t.raw, "name") });
  }
  const rest = candidates.filter(c => !listed.some(l => l.part === c)).sort((a, b) => partNumber(a) - partNumber(b));
  return listed.concat(rest.map(part => ({ part, name: "" })));
}

function slidesText(get, candidates){
  return orderedParts(candidates, get("ppt/presentation.xml"), get("ppt/_rels/presentation.xml.rels"), "ppt/", "p:sldId")
    .map(({ part }, i) => `--- slide ${i + 1} ---\n` + xmlText(get(part))).join("\n\n");
}

/* ---------- Excel ---------- */
function sharedStrings(xml){
  const list = [];
  let current = null, phonetic = 0;
  for(const t of xmlTokens(xml)){
    if(t.text !== undefined){ if(current && !phonetic) current.push(t.text); continue; }
    if(t.name === "si"){
      if(t.selfClosing) list.push("");
      else if(t.closing){ if(current) list.push(decodeEntities(current.join(""))); current = null; }
      else current = [];
    } else if(t.name === "rPh" && !t.selfClosing){
      phonetic = Math.max(0, phonetic + (t.closing ? -1 : 1));
    }
  }
  return list;
}

/* "C12" → 2. Null without a usable reference. */
function columnOf(ref){
  const letters = (ref.match(/^[A-Z]{1,3}/) || [])[0];
  if(!letters) return null;
  let n = 0;
  for(const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

function placeCell(row, cell, shared){
  const raw = decodeEntities(cell.text.join(""));
  const value = cell.type === "s" ? (shared[Number(raw)] ?? "") : raw;
  const column = columnOf(cell.ref);
  const at = column === null ? row.length : Math.min(Math.max(column, row.length), row.length + MAX_CELL_GAP);
  while(row.length < at) row.push("");
  row.push(value.replace(/[\t\r\n]+/g, " "));
}

function sheetRows(xml, shared){
  const rows = [];
  let row = null, cell = null, inValue = false, size = 0;
  for(const t of xmlTokens(xml)){
    if(size > OUTPUT_LIMIT) break;
    if(t.text !== undefined){ if(cell && inValue) cell.text.push(t.text); continue; }
    if(t.name === "row"){
      if(t.closing && row){
        while(row.length && !row[row.length - 1]) row.pop();
        const line = row.join("\t");
        if(line.trim()){ rows.push(line); size += line.length; }
        row = null;
      } else if(!t.closing && !t.selfClosing) row = [];
    } else if(t.name === "c"){
      if(t.closing){ if(cell && row) placeCell(row, cell, shared); cell = null; }
      else if(!t.selfClosing) cell = { ref: attr(t.raw, "r"), type: attr(t.raw, "t"), text: [] };
    } else if(t.name === "v" || t.name === "t"){
      inValue = !t.closing && !t.selfClosing;   // <v> holds a value, <is><t> an inline string
    }
  }
  return rows;
}

function workbookText(get, candidates){
  const shared = sharedStrings(get("xl/sharedStrings.xml"));
  return orderedParts(candidates, get("xl/workbook.xml"), get("xl/_rels/workbook.xml.rels"), "xl/", "sheet")
    .map(({ part, name }, i) => `--- ${name || "Sheet " + (i + 1)} ---\n` + sheetRows(get(part), shared).join("\n"))
    .join("\n\n");
}

/* ---------- plain text ----------
   Binary formats can be valid UTF-8 by accident; they give themselves away
   with NUL bytes or a scatter of control characters. A file that is not
   UTF-8 but reads as mostly Cyrillic letters in Windows-1251 is the old
   Russian-Windows encoding and is read as such. */
const tooManyControls = text => (text.match(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g) || []).length > text.length / 100;

function looksLikeCp1251(buf){
  let high = 0, letters = 0;
  for(const b of buf){
    if(b < 0x80) continue;
    high++;
    if(b >= 0xC0 || b === 0xA8 || b === 0xB8) letters++;
  }
  return high > 0 && letters / high > 0.9;
}

function decodeText(buf){
  if(buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if(buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return new TextDecoder("utf-16be").decode(buf.subarray(2));
  if(buf.includes(0)) return null;
  let text = null;
  try{ text = new TextDecoder("utf-8", { fatal:true }).decode(buf); }
  catch{ text = looksLikeCp1251(buf) ? new TextDecoder("windows-1251").decode(buf) : null; }
  return text === null || tooManyControls(text) ? null : text;
}

/* ---------- RTF ----------
   The striprtf approach: walk tokens, keep a stack of groups, and drop any
   group that is a destination (font table, pictures, metadata) or marked
   ignorable with \*. \'hh bytes are decoded in the document's code page,
   \uN characters directly, and \binN data is stepped over unread. */
const RTF_HIDDEN = new Set(["fonttbl","colortbl","stylesheet","info","pict","object","objdata","themedata",
  "colorschememapping","latentstyles","datastore","xmlnstbl","listtable","listoverridetable","rsidtbl",
  "generator","filetbl","revtbl","fldinst","header","headerl","headerr","headerf","footer","footerl",
  "footerr","footerf","bkmkstart","bkmkend","shppict","nonshppict","mmathPr","pgdsctbl","template"]);
const RTF_CHARS = { par:"\n", line:"\n", sect:"\n\n", page:"\n\n", row:"\n", cell:"\t", tab:"\t",
  emdash:"—", endash:"–", emspace:" ", enspace:" ", bullet:"•",
  lquote:"‘", rquote:"’", ldblquote:"“", rdblquote:"”" };
const RTF_TOKEN = "\\\\([a-z]{1,32})(-?\\d{1,10})? ?|\\\\'([0-9a-f]{2})|\\\\([^a-z])|([{}])|[\\r\\n]+|([^\\\\{}\\r\\n]+)";

function codePageDecoder(source){
  const cp = (source.match(/\\ansicpg(\d{1,5})/) || [])[1] || "1252";
  try{ return new TextDecoder("windows-" + cp); }catch{ return new TextDecoder("windows-1252"); }
}

function rtfText(input){
  const source = String(input);
  const decoder = codePageDecoder(source);
  const out = [], stack = [];
  let bytes = [], hidden = false, ucSkip = 1, skip = 0, overflow = 0, size = 0;
  const flush = () => { if(bytes.length){ const s = decoder.decode(Uint8Array.from(bytes)); out.push(s); size += s.length; bytes = []; } };
  const emit = s => { if(!hidden){ flush(); out.push(s); size += s.length; } };
  const token = new RegExp(RTF_TOKEN, "gi");
  let m;
  while(size <= OUTPUT_LIMIT && (m = token.exec(source)) !== null){
    const [, word, arg, hex, symbol, brace, text] = m;
    if(brace){
      skip = 0;
      if(brace === "{"){ if(stack.length < MAX_RTF_DEPTH) stack.push({ ucSkip, hidden }); else overflow++; }
      else if(overflow) overflow--;
      else if(stack.length) ({ ucSkip, hidden } = stack.pop());
    } else if(symbol){
      skip = 0;
      if(symbol === "*") hidden = true;
      else if(symbol === "~") emit(" ");
      else if(symbol === "_") emit("‑");
      else if("{}\\".includes(symbol)) emit(symbol);
      else if(symbol === "\n" || symbol === "\r") emit("\n");
    } else if(word){
      skip = 0;
      if(word === "bin"){ token.lastIndex += Math.max(0, Number(arg) || 0); continue; }
      if(RTF_HIDDEN.has(word)) hidden = true;
      else if(hidden) continue;
      else if(word === "uc") ucSkip = Number(arg) || 0;
      else if(word === "u"){ let code = Number(arg); if(code < 0) code += 0x10000; emit(String.fromCharCode(code)); skip = ucSkip; }
      else if(RTF_CHARS[word]) emit(RTF_CHARS[word]);
    } else if(hex){
      if(skip > 0) skip--;
      else if(!hidden) bytes.push(parseInt(hex, 16));
    } else if(text){
      let rest = text;
      if(skip > 0){ const n = Math.min(skip, rest.length); rest = rest.slice(n); skip -= n; }
      if(rest) emit(rest);
    }
  }
  flush();
  return tidy(out.join(""));
}

module.exports = { xmlText, slidesText, workbookText, decodeText, rtfText, decodeEntities, OUTPUT_LIMIT };
