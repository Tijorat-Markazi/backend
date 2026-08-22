/* ============================================================
   TIJORAT MARKAZI — Claude (Anthropic) client

   Every AI call in the platform goes through here: the assistant
   chat, the official letters, the government-appeal drafts and the
   sector news search.

   Key:   ANTHROPIC_API_KEY, or an anthropic.key file next to this
          one (gitignored, same pattern as gemini.key used to be).
   Model: claude-opus-5 — override with ANTHROPIC_MODEL.

   Notes for anyone editing the request shapes:
     · temperature / top_p / top_k are rejected by this model (400);
       steer with the system prompt instead.
     · thinking is ON by default and its tokens count against
       max_tokens, so the budgets below are deliberately generous.
       `effort` is the cost/latency dial, not max_tokens.
     · refusals arrive as a normal 200 with stop_reason "refusal",
       so stop_reason is checked before the content is read.
   ============================================================ */
const fs   = require("fs");
const path = require("path");

let Anthropic = null;
try { Anthropic = require("@anthropic-ai/sdk"); }
catch(e){ Anthropic = null; }               // no SDK installed → the platform runs in demo mode

const ROOT  = __dirname;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";

/* the server-side fallback re-runs a declined request on Anthropic's
   recommended model instead of handing us a refusal */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

function readKey(){
  if(process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  try { return fs.readFileSync(path.join(ROOT, "anthropic.key"), "utf8").trim(); } catch(e){ return ""; }
}
const KEY = readKey();
const client = (Anthropic && KEY) ? new Anthropic({ apiKey:KEY, maxRetries:2 }) : null;
const ready = () => !!client;

/* ---------- shaping ---------- */
/* An attachment is a base64 blob plus a mime type: pictures become image
   blocks, PDFs become document blocks, and a document has to precede the
   text it belongs to. */
function mediaBlock(media){
  if(!media || !media.data) return null;
  const mime = String(media.mime||"");
  if(mime === "application/pdf")
    return { type:"document", source:{ type:"base64", media_type:"application/pdf", data:media.data } };
  if(/^image\//.test(mime))
    return { type:"image", source:{ type:"base64", media_type:mime, data:media.data } };
  return null;
}
/* core.js speaks {role, text, image}; the API speaks content blocks */
function toMessages(list){
  return (list||[]).map(m => {
    const blocks = [];
    const media = mediaBlock(m.image || m.media);
    if(media) blocks.push(media);
    blocks.push({ type:"text", text: String(m.text||"") || "(bo'sh xabar)" });
    return { role: m.role === "assistant" ? "assistant" : "user", content: blocks };
  }).filter(m => m.content.length);
}
const textOf = msg => (msg && msg.content || [])
  .filter(b => b.type === "text").map(b => b.text).join("").trim();

function logFail(where, e){
  const status = e && e.status ? " ["+e.status+"]" : "";
  console.error(`[claude] ${where} failed${status}:`, (e && e.message) || e);
}

/* ---------- the one call everything funnels through ---------- */
async function send({ system, messages, effort, maxTokens, tools, where }){
  if(!ready()) return null;
  try{
    const req = {
      model: MODEL,
      max_tokens: maxTokens || 8000,
      system,
      messages,
      output_config: { effort: effort || "medium" },
      betas: [FALLBACK_BETA],
      fallbacks: "default",
    };
    if(tools) req.tools = tools;
    let msg = await client.beta.messages.create(req);

    // a server tool can pause the turn mid-way; picking it back up is a plain re-send
    for(let i=0; i<3 && msg.stop_reason === "pause_turn"; i++){
      msg = await client.beta.messages.create(Object.assign({}, req, {
        messages: messages.concat([{ role:"assistant", content: msg.content }]),
      }));
    }
    if(msg.stop_reason === "refusal"){
      console.error(`[claude] ${where||"request"} refused:`, (msg.stop_details && msg.stop_details.category) || "");
      return null;
    }
    return msg;
  }catch(e){ logFail(where||"request", e); return null; }
}

/* ---------- what core.js calls ---------- */

/* The assistant can hand over a finished file, so it needs a way to say so.
   Without this tool it can only describe a document — which is how you end up
   telling people to paste a template into PowerPoint themselves. */
const DOC_TOOL = {
  name: "create_document",
  description: "Create a real, downloadable file for the user and return its download link. "
    + "Call this whenever the user asks for a document, report, presentation, spreadsheet, "
    + "letter, plan, table or any other file — including phrasings like 'make me a PDF', "
    + "'prepare a presentation', 'send it as Word', 'jadval qilib ber', 'сделай презентацию'. "
    + "Never describe a document the user has to assemble themselves and never claim you cannot "
    + "send files: call this tool instead. It writes the actual file and gives you a URL to share.",
  input_schema: {
    type: "object",
    properties: {
      kind:   { type:"string", enum:["pdf","docx","xlsx","pptx"],
                description:"File format. pdf=PDF, docx=Word, xlsx=Excel, pptx=PowerPoint." },
      title:  { type:"string", description:"Short document title, in the user's language." },
      prompt: { type:"string", description:"Full, self-contained brief of everything the document must contain: "
                + "sections, tables, figures and any data the user supplied. The generator sees only this text." },
    },
    required: ["kind","title","prompt"],
  },
};

/** Assistant chat: full history, optional image/PDF, and real file creation.
    `makeFile` is injected by core.js — it produces the file and returns a URL. */
async function chat(history, systemText, opts){
  opts = opts || {};
  const messages = toMessages(history);
  const files = [];
  const tools = opts.makeFile ? [DOC_TOOL] : null;

  for(let round = 0; round < 3; round++){
    const msg = await send({
      system: systemText, messages, tools,
      effort: "low",            // conversational turns; quality holds and replies stay quick
      maxTokens: 8000,
      where: "chat",
    });
    if(!msg) return { text:null, files };

    const calls = (msg.content || []).filter(b => b.type === "tool_use" && b.name === "create_document");
    if(!calls.length) return { text: textOf(msg) || null, files };

    messages.push({ role:"assistant", content: msg.content });
    const results = [];
    for(const call of calls){
      const inp = call.input || {};
      let out;
      try{ out = await opts.makeFile({ kind:inp.kind, title:inp.title, prompt:inp.prompt, lang:opts.lang }); }
      catch(e){ out = { ok:false, error:String((e && e.message) || e) }; }

      if(out && out.ok){
        files.push(out);
        results.push({ type:"tool_result", tool_use_id:call.id,
          content:`File created. Give the user this exact download link: ${out.url} (${out.name}). Do not describe the contents at length — the file speaks for itself.` });
      } else {
        results.push({ type:"tool_result", tool_use_id:call.id, is_error:true,
          content:`Could not create the file (${(out && out.error) || "unknown"}). Tell the user briefly and offer to try a different format.` });
      }
    }
    messages.push({ role:"user", content: results });
  }
  return { text:null, files };
}

/** One-shot generation — official letters, appeal drafts, report prose. */
async function write(systemText, userText, opts){
  opts = opts || {};
  const msg = await send({
    system: systemText,
    messages: [{ role:"user", content:[{ type:"text", text:String(userText||"") }] }],
    effort: opts.effort || "medium",   // formal documents: worth the extra deliberation
    maxTokens: opts.maxTokens || 12000,
    where: opts.where || "write",
  });
  return msg ? (textOf(msg) || null) : null;
}

/** Search the live web and report back both the prose and the pages actually read. */
async function search(systemText, userText){
  const msg = await send({
    system: systemText,
    messages: [{ role:"user", content:[{ type:"text", text:String(userText||"") }] }],
    effort: "medium",
    maxTokens: 16000,
    tools: [{ type:"web_search_20260209", name:"web_search", max_uses:6 }],
    where: "news search",
  });
  if(!msg) return { text:null, sources:[] };

  // the URLs Claude actually opened — more trustworthy than links it writes into prose
  const sources = [];
  for(const block of msg.content || []){
    if(block.type !== "web_search_tool_result") continue;
    const results = block.content;
    if(!Array.isArray(results)) continue;             // an error result is an object, not a list
    for(const r of results){
      if(r && r.url) sources.push({ uri:r.url, title:r.title || "" });
    }
  }
  return { text: textOf(msg) || null, sources };
}

/* ---------- documents: PDF / Word / Excel / PowerPoint ----------
   Claude writes these with Anthropic's own document skills inside a
   sandboxed container: it runs code there (python-docx, openpyxl,
   python-pptx, reportlab…), writes the file, and hands back a file id
   we download. Nothing executes on this server. */
const DOC_KINDS = {
  pdf:  { skill:"pdf",  ext:"pdf",  mime:"application/pdf" },
  docx: { skill:"docx", ext:"docx", mime:"application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  xlsx: { skill:"xlsx", ext:"xlsx", mime:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  pptx: { skill:"pptx", ext:"pptx", mime:"application/vnd.openxmlformats-officedocument.presentationml.presentation" },
};
const DOC_BETAS = ["code-execution-2025-08-25", "skills-2025-10-02", "files-api-2025-04-14"];
const docKinds = () => Object.keys(DOC_KINDS);

/* Walk the response for file ids the container produced. The block shape
   differs between the bash and text-editor sub-tools, so this looks for
   any `file_id` rather than pinning one path. */
function collectFileIds(content){
  const ids = [];
  const walk = node => {
    if(!node || typeof node !== "object") return;
    if(Array.isArray(node)) return node.forEach(walk);
    if(typeof node.file_id === "string" && node.file_id) ids.push(node.file_id);
    for(const k of Object.keys(node)) if(node[k] && typeof node[k] === "object") walk(node[k]);
  };
  walk(content);
  return [...new Set(ids)];
}

async function makeDocument({ kind, prompt, lang, title }){
  if(!ready()) return { ok:false, error:"ai_unavailable" };
  const spec = DOC_KINDS[String(kind||"").toLowerCase()];
  if(!spec) return { ok:false, error:"bad_kind" };

  const LANGS = { uz:"Uzbek", ru:"Russian", en:"English" };
  const system = `You are the TIJORAT MARKAZI document generator for a national trade platform serving Uzbek associations and their member companies.
Produce exactly ONE .${spec.ext} file, then EXPORT it so the user actually receives it — a file left sitting in the working directory is never delivered.
Write all document content in ${LANGS[lang] || "Uzbek"}.
Make it complete and presentable: a real title, structured sections, and realistic professional formatting — never a placeholder or a stub.
Invent no figures that were not given to you. When the request lacks data, structure the document so the missing values are clearly marked for the user to fill in.
Reply with one short sentence describing what you produced; the file itself is the deliverable.`;

  try{
    const msg = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: DOC_BETAS,
      container: { skills: [{ type:"anthropic", skill_id:spec.skill, version:"latest" }] },
      tools: [{ type:"code_execution_20260521", name:"code_execution" }],
      output_config: { effort: "medium" },
      system,
      messages: [{ role:"user", content:[{ type:"text",
        text: (title ? `Title: ${title}\n\n` : "") + String(prompt||"") }] }],
    });
    if(msg.stop_reason === "refusal") return { ok:false, error:"refused" };

    const ids = collectFileIds(msg.content);
    if(!ids.length) return { ok:false, error:"no_file", note:textOf(msg).slice(0,300) };

    /* The container may export previews (a page thumbnail, an intermediate)
       alongside the deliverable, so pick the export whose name actually ends
       in the format that was asked for; fall back to the last one exported. */
    const metas = await Promise.all(ids.map(id =>
      client.beta.files.retrieveMetadata(id, { betas:DOC_BETAS })
        .then(m => ({ id, name:(m && m.filename) || "" }))
        .catch(() => ({ id, name:"" }))));
    const want = new RegExp("\\." + spec.ext + "$", "i");
    const picked = metas.filter(m => want.test(m.name)).pop() || metas[metas.length - 1];

    const fileId = picked.id;
    const meta = { filename: picked.name };
    const res  = await client.beta.files.download(fileId, { betas:DOC_BETAS });
    const data = Buffer.from(await res.arrayBuffer());
    if(!data.length) return { ok:false, error:"empty_file" };

    return { ok:true, data, ext:spec.ext, mime:spec.mime,
      filename: (meta && meta.filename) || `document.${spec.ext}`,
      note: textOf(msg).slice(0,400) };
  }catch(e){ logFail("document", e); return { ok:false, error:String((e && e.message) || e).slice(0,200) }; }
}

/* Claude has no audio input, so speech cannot be transcribed here.
   Kept as an explicit, honest failure rather than a silent empty string —
   the caller reports "transcription unavailable" instead of an empty message. */
async function transcribe(){ return null; }
const canTranscribe = () => false;

module.exports = { MODEL, KEY, ready, chat, write, search, transcribe, canTranscribe,
  makeDocument, docKinds, DOC_KINDS, toMessages, textOf };
