"use strict";
/* ============================================================
   TIJORAT MARKAZI — reading a file attached to the assistant

   A visitor may attach any file. Its bytes, not its name, decide how it is
   read, so a mislabelled or extension-less file still lands on the right path:
     JPEG / PNG / GIF / WebP        → an image block Claude looks at
     PDF                            → a document block Claude reads natively
     plain text of any kind         → the text (code, CSV, JSON, HTML, logs…)
     Word / Excel / PowerPoint 2007+
       and OpenDocument             → the text in their XML parts, via unzip
     RTF                            → its text, control words removed
     anything else — .doc .xls .ppt (OLE2), Pages, EPUB, archives, HEIC…
                                    → converted to text in Anthropic's code
                                      execution sandbox (claude.js)
   Nothing in the file runs on this server: unzip lists entries and copies
   out XML parts whose names match fixed patterns, nothing more. Every step
   is bounded — entries, parts, bytes, time, and sandbox calls in flight —
   so a hostile upload costs a few seconds at most.

   createReader({ tmpDir, readInSandbox })
     → async readAttachment(attachment, { allowSandbox }) → { text, media }
   ============================================================ */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { xmlText, slidesText, workbookText, decodeText, rtfText } = require("./attachment-text");

const MAX_TEXT_CHARS = 60000;             // ≈ 15k tokens; the rest of the file is named as cut
const MAX_FILE_BYTES = 8 * 1024 * 1024;   // the browser refuses larger files before sending
const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024; // the API takes at most 5 MB of base64 per picture
const MAX_ZIP_ENTRIES = 5000;
const MAX_SLIDES = 300;
const MAX_SHEETS = 100;
const MAX_PART_BYTES = 16 * 1024 * 1024;  // one XML part out of a zip — a zip bomb stops here
const MAX_ZIP_TOTAL_BYTES = 32 * 1024 * 1024;
const ZIP_DEADLINE_MS = 15000;            // for all unzip calls of one file together
const MAX_SANDBOX_IN_FLIGHT = 2;          // paid conversions running at once, server-wide
const STALE_TMP_MS = 60 * 60 * 1000;
const CLAUDE_IMAGES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const KINDS = ["text", "image", "binary"];

const NOTE_DAMAGED = "[The attached file arrived empty or damaged and could not be read.]";
const NOTE_UNREADABLE = "[The attached file could not be read: no text could be extracted from it.]";
const NOTE_BUSY = "[The attached file needs a slower conversion and the converter is busy. Ask the user to send it again in a minute.]";
const NOTE_IMAGE_TOO_BIG = "[The attached picture is larger than 3.75 MB, so the assistant cannot see it. Ask the user for a smaller copy.]";
const noteCut = n => `\n\n[The file is longer than this: only the first ${n} characters are shown.]`;

const bytesAt = (buf, bytes, at = 0) => bytes.every((b, i) => buf[at + i] === b);
const ascii = s => Array.from(s, c => c.charCodeAt(0));

function sniff(buf){
  if(bytesAt(buf, ascii("%PDF-"))) return "pdf";
  if(bytesAt(buf, [0x89, 0x50, 0x4E, 0x47])) return "image/png";
  if(bytesAt(buf, [0xFF, 0xD8, 0xFF])) return "image/jpeg";
  if(bytesAt(buf, ascii("GIF8"))) return "image/gif";
  if(bytesAt(buf, ascii("RIFF")) && bytesAt(buf, ascii("WEBP"), 8)) return "image/webp";
  if(bytesAt(buf, [0x50, 0x4B, 0x03, 0x04])) return "zip";
  if(bytesAt(buf, ascii("{\\rtf"))) return "rtf";
  return decodeText(buf) === null ? "other" : "text";
}

const clip = text => text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) + noteCut(MAX_TEXT_CHARS) : text;
const textOrNull = t => (t && t.trim()) ? clip(t.trim()) : null;

/* A name as it may appear in the prompt and in a sandbox upload: no control
   characters, brackets or path separators. */
const cleanName = name => String(name || "file").replace(/[\u0000-\u001F\u007F<>[\]]/g, "")
  .replace(/[\\/]/g, "_").trim().slice(0, 120) || "file";

/* The request body is untrusted: keep only a well-formed attachment. */
function normalize(raw){
  if(!raw || typeof raw !== "object" || !KINDS.includes(raw.kind)) return null;
  const name = cleanName(raw.name);
  if(raw.kind === "text") return { kind: "text", name, content: typeof raw.content === "string" ? raw.content : "" };
  if(typeof raw.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw.data)) return null;
  const buffer = Buffer.from(raw.data, "base64");
  if(!buffer.length || buffer.length > MAX_FILE_BYTES) return null;
  const mime = typeof raw.mime === "string" && /^[\w.+-]{1,60}\/[\w.+-]{1,80}$/.test(raw.mime) ? raw.mime : "application/octet-stream";
  return { kind: raw.kind, name, mime, buffer };
}

/* ---------- zip-based documents ---------- */
function unzip(args, deadline){
  const timeout = deadline - Date.now();
  if(timeout <= 0) return Promise.reject(new Error("zip deadline passed"));
  return new Promise((resolve, reject) => execFile("unzip", args,
    { timeout, maxBuffer: MAX_PART_BYTES, encoding: "buffer" },
    (err, stdout) => err ? reject(err) : resolve(stdout)));
}

/* Which parts to copy out, from the member list alone. Only names matched
   by these fixed patterns are ever passed to unzip, so a crafted member
   name cannot reach it as a wildcard or an option. */
function documentPlan(entries){
  const has = new Set(entries);
  if(has.has("word/document.xml")){
    return { kind: "word", parts: ["word/document.xml", ...entries.filter(e => /^word\/(?:footnotes|endnotes)\.xml$/.test(e))] };
  }
  const slides = entries.filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e)).slice(0, MAX_SLIDES);
  if(slides.length) return { kind: "slides", candidates: slides,
    parts: ["ppt/presentation.xml", "ppt/_rels/presentation.xml.rels", ...slides].filter(p => has.has(p)) };
  const sheets = entries.filter(e => /^xl\/worksheets\/sheet\d+\.xml$/.test(e)).slice(0, MAX_SHEETS);
  if(sheets.length) return { kind: "sheets", candidates: sheets,
    parts: ["xl/sharedStrings.xml", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", ...sheets].filter(p => has.has(p)) };
  if(has.has("content.xml")) return { kind: "odf", parts: ["content.xml"] };   // .odt .ods .odp
  return null;
}

async function readParts(file, partNames, deadline){
  const parts = new Map();
  let total = 0;
  for(const part of partNames){
    if(total >= MAX_ZIP_TOTAL_BYTES || Date.now() >= deadline) break;
    try{
      const xml = (await unzip(["-p", file, part], deadline)).toString("utf8");
      parts.set(part, xml);
      total += xml.length;
    }catch{ /* an oversized or broken part is skipped; the rest still reads */ }
  }
  return parts;
}

function planText(plan, parts){
  const get = part => parts.get(part) || "";
  if(plan.kind === "slides") return slidesText(get, plan.candidates);
  if(plan.kind === "sheets") return workbookText(get, plan.candidates);
  return plan.parts.map(p => xmlText(get(p))).join("\n\n");
}

async function zipDocumentText(buf, tmpDir){
  const file = path.join(tmpDir, "attach_" + crypto.randomUUID() + ".zip");
  const deadline = Date.now() + ZIP_DEADLINE_MS;
  try{
    fs.writeFileSync(file, buf, { mode: 0o600 });
    const entries = (await unzip(["-Z1", file], deadline)).toString("utf8").split(/\r?\n/).filter(Boolean);
    if(entries.length > MAX_ZIP_ENTRIES) return null;
    const plan = documentPlan(entries);
    return plan ? planText(plan, await readParts(file, plan.parts, deadline)) : null;
  }catch{ return null; }   // not a zip unzip can open, or out of time: the sandbox gets a try
  finally{ fs.rmSync(file, { force: true }); }
}

/* A crash mid-read can leave a temporary copy behind; clear old ones. */
function sweepStaleCopies(tmpDir){
  try{
    fs.mkdirSync(tmpDir, { recursive: true });
    const cutoff = Date.now() - STALE_TMP_MS;
    for(const name of fs.readdirSync(tmpDir)){
      if(!/^attach_[0-9a-f-]{36}\.zip$/.test(name)) continue;
      const full = path.join(tmpDir, name);
      if(fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
    }
  }catch(e){ console.error("[attachments] could not sweep", tmpDir + ":", (e && e.message) || e); }
}

/* ---------- the reader ---------- */
function createReader({ tmpDir, readInSandbox }){
  sweepStaleCopies(tmpDir);
  let inFlight = 0;

  async function convertInSandbox(file){
    if(inFlight >= MAX_SANDBOX_IN_FLIGHT) return NOTE_BUSY;
    inFlight++;
    try{ return textOrNull(await readInSandbox({ data: file.buffer, name: file.name, mime: file.mime })) || NOTE_UNREADABLE; }
    catch(e){ console.error("[attachments] sandbox read failed:", (e && e.message) || e); return NOTE_UNREADABLE; }
    finally{ inFlight--; }
  }

  async function localText(kind, buf){
    if(kind === "text") return textOrNull(decodeText(buf));
    if(kind === "rtf") return textOrNull(rtfText(buf.toString("latin1")));
    if(kind === "zip") return textOrNull(await zipDocumentText(buf, tmpDir));
    return null;
  }

  /* `allowSandbox` is false for a request with no account or guest identity:
     a paid conversion is never run for an unmetered caller. */
  return async function readAttachment(raw, { allowSandbox = true } = {}){
    const file = normalize(raw);
    if(!file) return { text: NOTE_DAMAGED, media: null };
    if(file.kind === "text") return { text: textOrNull(file.content) || NOTE_DAMAGED, media: null };

    const buf = file.buffer;
    const kind = sniff(buf);
    if(CLAUDE_IMAGES.includes(kind)){
      return buf.length > MAX_IMAGE_BYTES ? { text: NOTE_IMAGE_TOO_BIG, media: null }
        : { text: "", media: { mime: kind, data: buf.toString("base64") } };
    }
    if(kind === "pdf") return { text: "", media: { mime: "application/pdf", data: buf.toString("base64") } };

    const text = await localText(kind, buf);
    if(text) return { text, media: null };
    return { text: allowSandbox ? await convertInSandbox(file) : NOTE_UNREADABLE, media: null };
  };
}

module.exports = { createReader, sniff, normalize, cleanName, MAX_TEXT_CHARS, MAX_FILE_BYTES, MAX_IMAGE_BYTES };
