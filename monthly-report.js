/* ============================================================
   TIJORAT MARKAZI — monthly report generator (for system cron)
   Generates the previous (or given) month's Word report,
   archives it to data/reports/, and sends it to the rais on Telegram.

   Run end of month, e.g. crontab:
     5 0 1 * *  cd /path/to/TIJORAT MARKAZI && node monthly-report.js
   Or a specific month:
     node monthly-report.js 2026-06
   ============================================================ */
const fs   = require("fs");
const path = require("path");
const core = require("./core");

function prevYm(){
  const d = new Date();
  d.setDate(1); d.setMonth(d.getMonth()-1);
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0");
}
function readToken(){
  if(process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN.trim();
  try{ return fs.readFileSync(path.join(__dirname,"telegram bot","telegram.key"),"utf8").trim(); }catch(e){ return ""; }
}

async function sendDoc(token, chat, caption, filename, doc){
  const form = new FormData();
  form.append("chat_id", String(chat));
  form.append("caption", caption);
  form.append("document", new Blob([doc], { type:"application/msword" }), filename);
  const r = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method:"POST", body:form });
  const j = await r.json();
  return !!j.ok;
}

(async function(){
  const ym = process.argv[2] || prevYm();
  console.log(`TIJORAT MARKAZI monthly report → ${ym}`);

  // one SEPARATE Word file per association (uyushma), each with letters from its child companies
  const reports = await core.assocReports(ym, { force: process.argv.includes("--fresh") });
  const dir = path.join(__dirname, "data", "reports", ym);
  fs.mkdirSync(dir, { recursive:true });

  if(!reports.length){
    console.log("No associations had company complaints this month — nothing to send.");
    process.exit(0);
  }

  const token = readToken();
  const o = core.getOrgs();
  const chat = process.env.RAIS_TG_CHAT || (o.rais && o.rais.tgChat);
  const canSend = !!(token && chat);
  if(!canSend) console.log("Telegram: skipped (no token or rais chat id — set rais Telegram chat ID in admin panel or RAIS_TG_CHAT env)");

  let sent = 0;
  for(const rep of reports){
    const file = path.join(dir, rep.filename);
    fs.writeFileSync(file, rep.doc);
    console.log(`Saved: ${file}  (${rep.companyCount} kompaniya, ${rep.questions} murojaat)`);
    if(canSend){
      try{
        const ok = await sendDoc(token, chat, `📩 ${rep.assoc} — ${ym} (a'zo kompaniyalar murojaatlari: ${rep.companyCount})`, rep.filename, rep.doc);
        if(ok){ sent++; console.log(`  → Telegram: sent ✓`); }
        else  { console.log(`  → Telegram: failed`); }
      }catch(e){ console.log(`  → Telegram error: ${e.message}`); }
    }
  }
  console.log(`Done. ${reports.length} association file(s) generated${canSend?`, ${sent} sent to rais.`:"."}`);
  process.exit(0);
})();
