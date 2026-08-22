/* ============================================================
   TIJORAT MARKAZI — Telegram bot (same AI core as the website)
   Run:  TELEGRAM_BOT_TOKEN=123:abc node bot.js
   or put the token in a file named  telegram.key
   ============================================================ */
const fs   = require("fs");
const path = require("path");
// Use the SAME core as the website → all questions log to one file (../data/problems.json)
let core;
try { core = require("../core"); }
catch(e){ core = require("./core"); }

function readToken(){
  if(process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN.trim();
  try { return fs.readFileSync(path.join(__dirname,"telegram.key"),"utf8").trim(); } catch(e){ return ""; }
}
const TOKEN = readToken();
if(!TOKEN){
  console.error("\n  ❌ Telegram token topilmadi.\n  @BotFather dan token oling va 'telegram.key' fayliga yozing,\n  yoki:  TELEGRAM_BOT_TOKEN=xxxx node bot.js\n");
  process.exit(1);
}
const API = `https://api.telegram.org/bot${TOKEN}`;
const sleep = ms => new Promise(r=>setTimeout(r,ms));

/* ---------- Telegram helpers ---------- */
async function tg(method, params){
  try{
    const r = await fetch(`${API}/${method}`, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(params||{}) });
    return await r.json();
  }catch(e){ return { ok:false, error:e.message }; }
}
async function getFileB64(fileId, mime){
  const r = await tg("getFile", { file_id:fileId });
  const fp = r?.result?.file_path; if(!fp) return null;
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${fp}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { b64: buf.toString("base64"), mime: mime || "application/octet-stream", name: path.basename(fp) };
}
async function sendMessage(chatId, text){
  const chunks = String(text||"").match(/[\s\S]{1,3800}/g) || [""];
  for(const c of chunks){ await tg("sendMessage", { chat_id:chatId, text:c, disable_web_page_preview:true }); }
}

/* ---------- welcome / help ---------- */
const WELCOME =
`👋 Assalomu alaykum! Men Tijorat Markazi AI yordamchisiman.
Здравствуйте! Я ассистент Tijorat Markazi AI.
Hello! I'm the Tijorat Markazi AI assistant.

TIJORAT MARKAZI platformasi (12 markaz · 100 modul) bo'yicha savol bering — investitsiya, eksport, grant, R&D va boshqalar.
Можно писать на 🇺🇿 / 🇷🇺 / 🇬🇧, отправлять 🎤 голос, 🖼 фото и 📎 документы (PDF, Word, Excel, PowerPoint).

/new — yangi suhbat · /help`;

/* ---------- handle one update ---------- */
async function handleUpdate(u){
  const m = u.message || u.edited_message;
  if(!m || !m.chat) return;
  const chatId = m.chat.id;
  const userId = m.from?.id || chatId;
  const email = `tg:${userId}`;
  const sid   = `tg:${userId}`;

  let text = (m.text || m.caption || "").trim();

  // commands
  if(text === "/start"){ return sendMessage(chatId, WELCOME); }
  if(text === "/help"){  return sendMessage(chatId, WELCOME); }
  if(text === "/new"){
    const store = core.getStore();
    if(store[email]?.sessions?.[sid]) { delete store[email].sessions[sid]; core.saveStore(store); }
    return sendMessage(chatId, "🆕 Yangi suhbat boshlandi. / Новый чат начат. / New chat started.");
  }

  let attachment = null;

  try{
    if(m.voice || m.audio){
      const v = m.voice || m.audio;
      await tg("sendChatAction", { chat_id:chatId, action:"typing" });
      const f = await getFileB64(v.file_id, v.mime_type || "audio/ogg");
      const tr = f ? await core.transcribe(f.b64, f.mime) : null;
      if(!tr) return sendMessage(chatId, "🎤 Ovozni aniqlay olmadim, qayta urinib ko'ring. / Не удалось распознать голос.");
      text = text ? (text + "\n" + tr) : tr;
    } else if(m.document){
      const d = m.document;
      const f = await getFileB64(d.file_id, d.mime_type);
      const name = d.file_name || f?.name || "file";
      if(f){
        if(/\.(txt|md|csv|json|log)$/i.test(name)) attachment = { kind:"text", name, content: Buffer.from(f.b64,"base64").toString("utf8").slice(0,20000) };
        else attachment = { kind:"binary", name, mime: d.mime_type || "application/octet-stream", data: f.b64 };
      }
    } else if(m.photo){
      const ph = m.photo[m.photo.length-1];
      const f = await getFileB64(ph.file_id, "image/jpeg");
      if(f) attachment = { kind:"image", name:"photo.jpg", mime:"image/jpeg", data:f.b64 };
    }
  }catch(e){ console.error("attachment error:", e.message); }

  if(!text && !attachment) return;

  await tg("sendChatAction", { chat_id:chatId, action:"typing" });
  const who = [m.from?.first_name, m.from?.last_name, m.from?.username?("@"+m.from.username):""].filter(Boolean).join(" ").trim();
  const reply = await core.answer({ email, sessionId:sid, message:text, attachment, lang:"ru", company: who?("Telegram: "+who):"" });
  await sendMessage(chatId, reply);
}

/* ---------- long polling ---------- */
let offset = 0;
async function poll(){
  // clear old webhook (in case) and identify bot
  await tg("deleteWebhook", { drop_pending_updates:false });
  const me = await tg("getMe");
  console.log(`\n  Tijorat Markazi Telegram bot → @${me?.result?.username || "?"}`);
  console.log(`  AI: ${core.KEY ? "ON (Gemini "+core.MODEL+")" : "OFF — demo mode"}\n`);
  while(true){
    try{
      const r = await tg("getUpdates", { offset, timeout:50 });
      if(r && r.ok){
        for(const u of r.result){ offset = u.update_id + 1; handleUpdate(u).catch(e=>console.error("handle error:", e.message)); }
      } else if(r && r.error_code===409){ await sleep(3000); }
    }catch(e){ console.error("poll error:", e.message); await sleep(2000); }
  }
}
poll();
