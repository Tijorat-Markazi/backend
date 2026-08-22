#!/usr/bin/env node
/* ============================================================
   TIJORAT MARKAZI — Google Meet setup, driven through a real browser

   Google has no API for creating a consumer OAuth client, so this
   script does the Cloud Console by hand: it opens Chrome, waits for
   you to sign in once, then clicks through project creation, API
   enablement, the consent screen, and the OAuth client — finally
   writing google.key and running the connect flow.

     node setup-google.js                 # full run
     node setup-google.js --project=ID    # reuse an existing project
     node setup-google.js --connect-only  # google.key exists, just link the account

   Every step is *semi*-automatic: if the Console has moved a button,
   the script prints what to click, waits for you, and carries on.
   Nothing is lost when a selector goes stale.
   ============================================================ */
const fs = require("fs");
const path = require("path");
const http = require("http");
const readline = require("readline");
const { spawn } = require("child_process");

let chromium;
try { ({ chromium } = require("playwright-core")); }
catch(e){
  console.error("\n  playwright-core is missing. Install it once:\n\n    npm install\n");
  process.exit(1);
}

const ROOT = __dirname;
const KEY_FILE = path.join(ROOT, "google.key");
const PROFILE   = path.join(ROOT, "data", ".gsetup-profile");   // keeps you signed in between runs

const PORT       = process.env.PORT || 4321;
const HTTPS_PORT = process.env.HTTPS_PORT || 4443;
const APP_NAME   = process.env.APP_NAME || "Tijorat Markazi";
const REDIRECTS  = [
  `http://localhost:${PORT}/api/google/callback`,
  `https://localhost:${HTTPS_PORT}/api/google/callback`,
];
const SCOPE_URL = "https://www.googleapis.com/auth/calendar.events";

const argv = process.argv.slice(2);
const flag = n => argv.some(a => a === "--"+n);
const opt  = n => { const a = argv.find(x => x.startsWith("--"+n+"=")); return a ? a.slice(n.length+3) : ""; };

/* ---------- console chrome ---------- */
const c = { dim:"\x1b[2m", b:"\x1b[1m", g:"\x1b[32m", y:"\x1b[33m", r:"\x1b[31m", x:"\x1b[0m" };
const say  = (...a) => console.log("  ", ...a);
const head = s => console.log(`\n${c.b}  ${s}${c.x}`);
const ok   = s => say(`${c.g}✓${c.x} ${s}`);
const warn = s => say(`${c.y}!${c.x} ${s}`);

const rl = () => readline.createInterface({ input:process.stdin, output:process.stdout });
function ask(q){
  return new Promise(res => { const i = rl(); i.question(`  ${c.y}?${c.x} ${q} `, a => { i.close(); res(String(a||"").trim()); }); });
}
const pause = msg => ask(`${msg} — press Enter when done…`);

/* A step that would rather ask for help than die. Anything the Console
   renamed or moved becomes a short manual instruction, not a crash. */
async function step(title, fn, manual){
  head(title);
  try {
    const r = await fn();
    if(r !== "skipped") ok(title);
    return r;
  } catch(e){
    warn(`could not do this automatically (${String(e.message||e).split("\n")[0].slice(0,120)})`);
    if(manual) manual.split("\n").forEach(l => say(`${c.dim}→${c.x} ${l}`));
    await pause("do it in the browser window");
    return "manual";
  }
}

/* ---------- page helpers ---------- */
const CLIENT_ID_RE = /\d+-[a-z0-9]+\.apps\.googleusercontent\.com/;
const SECRET_RE    = /GOCSPX-[A-Za-z0-9_-]{10,}/;

/* Text beats selectors here: the Console reskins often but the words on
   its buttons are stable, and they are what a human looks for too. */
async function clickText(page, names, timeout=12000){
  const list = [].concat(names);
  const each = Math.max(2000, Math.round(timeout/list.length));
  for(const name of list){
    try { await page.getByRole("button", { name, exact:false }).first().click({ timeout:each }); return true; } catch(e){}
    try { await page.locator(`text=${name}`).first().click({ timeout:1500 }); return true; } catch(e){}
  }
  throw new Error("no button matching "+list.join(" / "));
}
async function fillLabel(page, labels, value){
  for(const label of [].concat(labels)){
    const f = page.getByLabel(label, { exact:false }).first();
    try { await f.fill(value, { timeout:4000 }); return true; } catch(e){}
  }
  throw new Error("no field labelled "+[].concat(labels).join(" / "));
}
const settle = (page, ms=2500) => page.waitForTimeout(ms);

/* ---------- the browser ----------
   Playwright must NOT launch Chrome here. A Playwright-launched browser
   carries --enable-automation and navigator.webdriver, and Google flatly
   refuses to sign you in to one ("This browser or app may not be secure").
   So we start an ordinary Chrome that happens to expose a debug port, and
   attach to it. Google sees a normal browser, because it is one. */
const DEBUG_PORT = Number(process.env.GSETUP_PORT) || 9222;
const CHROME_PATHS = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  path.join(process.env.LOCALAPPDATA||"", "Google/Chrome/Application/chrome.exe"),
].filter(Boolean);

function chromePath(){
  const hit = CHROME_PATHS.find(p => { try { return fs.statSync(p).isFile(); } catch(e){ return false; } });
  if(!hit) throw new Error("Chrome not found — set CHROME_PATH to chrome.exe");
  return hit;
}
function debugEndpoint(){
  return new Promise(res => {
    const r = http.get({ host:"127.0.0.1", port:DEBUG_PORT, path:"/json/version", timeout:1500 }, s => {
      let b=""; s.on("data", d=>b+=d); s.on("end", ()=>{ try { res(JSON.parse(b)); } catch(e){ res(null); } });
    });
    r.on("error", ()=>res(null));
    r.on("timeout", ()=>{ r.destroy(); res(null); });
  });
}
async function startChrome(){
  if(await debugEndpoint()){
    // someone already left a debuggable Chrome on this port — reuse it
    ok(`attaching to the Chrome already on :${DEBUG_PORT}`);
    return null;
  }
  fs.mkdirSync(PROFILE, { recursive:true });
  const child = spawn(chromePath(), [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${PROFILE}`,     // a custom dir is required: Chrome 136+ refuses debugging on the default profile
    "--no-first-run",
    "--no-default-browser-check",
    "--start-maximized",
    "https://console.cloud.google.com/",
  ], { detached:true, stdio:"ignore" });
  child.unref();

  const until = Date.now() + 30000;
  while(Date.now() < until){
    await new Promise(r => setTimeout(r, 700));
    const v = await debugEndpoint();
    if(v){ ok(`Chrome ready (${(v.Browser||"").replace("Chrome/","Chrome ")})`); return child; }
  }
  throw new Error("Chrome did not open its debug port");
}

/* ---------- our own server ---------- */
function serverStatus(){
  return new Promise(res => {
    const r = http.get({ host:"localhost", port:PORT, path:"/api/google/status", timeout:3000 }, s => {
      let b=""; s.on("data", d=>b+=d); s.on("end", ()=>{ try { res(JSON.parse(b)); } catch(e){ res(null); } });
    });
    r.on("error", ()=>res(null));
    r.on("timeout", ()=>{ r.destroy(); res(null); });
  });
}

/* ============================================================
   1 — sign in
   ============================================================ */
async function waitForLogin(page){
  await page.goto("https://console.cloud.google.com/", { waitUntil:"domcontentloaded" }).catch(()=>{});
  const signedIn = async () => {
    const u = page.url();
    return u.includes("console.cloud.google.com") && !u.includes("accounts.google.com") && !u.includes("signin");
  };
  if(await signedIn()) return ok("already signed in");
  say("sign in to Google in the browser window that just opened");
  say(`${c.dim}(this profile is remembered, so later runs skip the login)${c.x}`);
  const until = Date.now() + 5*60*1000;
  while(Date.now() < until){
    await page.waitForTimeout(2000);
    if(await signedIn()) return ok("signed in");
  }
  throw new Error("timed out waiting for sign-in");
}

/* ============================================================
   2 — project
   ============================================================ */
async function createProject(page){
  const given = opt("project");
  if(given){ ok("using existing project "+given); return given; }

  const name = `${APP_NAME} Meet`.slice(0,28);
  await page.goto("https://console.cloud.google.com/projectcreate", { waitUntil:"domcontentloaded" });
  await settle(page, 4000);
  await fillLabel(page, ["Project name","Nom loyihasi"], name);
  await settle(page, 1500);
  await clickText(page, ["Create","CREATE"]);
  say("waiting for the project to be provisioned…");
  await settle(page, 12000);

  // the Console usually lands back on the new project with ?project= in the URL
  const fromUrl = /[?&]project=([a-z0-9-]+)/.exec(page.url());
  if(fromUrl) return fromUrl[1];

  // otherwise read it off the resource manager list
  await page.goto("https://console.cloud.google.com/cloud-resource-manager", { waitUntil:"domcontentloaded" });
  await settle(page, 5000);
  const body = await page.textContent("body").catch(()=>"");
  const guess = new RegExp(name.toLowerCase().replace(/[^a-z0-9]+/g,"-")+"[a-z0-9-]*").exec(String(body).toLowerCase());
  if(guess) return guess[0];
  throw new Error("project created but its id could not be read");
}

/* ============================================================
   3 — Calendar API
   ============================================================ */
async function enableCalendar(page, project){
  await page.goto(`https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=${project}`,
    { waitUntil:"domcontentloaded" });
  await settle(page, 4000);
  const text = await page.textContent("body").catch(()=>"");
  if(/Manage|API enabled/i.test(text) && !/\bEnable\b/i.test(text)){ ok("Calendar API already enabled"); return "skipped"; }
  await clickText(page, ["Enable","ENABLE"]);
  await settle(page, 8000);
}

/* ============================================================
   4 — consent screen (Google Auth Platform → Branding)
   ============================================================ */
async function brandingSetup(page, project, email){
  await page.goto(`https://console.cloud.google.com/auth/branding?project=${project}`, { waitUntil:"domcontentloaded" });
  await settle(page, 4000);
  const text = await page.textContent("body").catch(()=>"");
  if(!/Get started/i.test(text)){ ok("consent screen already configured"); return "skipped"; }

  await clickText(page, ["Get started","GET STARTED"]);
  await settle(page, 2000);
  await fillLabel(page, ["App name","Application name"], APP_NAME);
  await fillLabel(page, ["User support email","Support email"], email).catch(async ()=>{
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name:email, exact:false }).first().click();
  });
  await clickText(page, ["Next","NEXT"]);
  await settle(page, 1500);

  // Audience → External (a personal Gmail has no other choice)
  await page.getByRole("radio", { name:/External/i }).first().check().catch(()=>{});
  await clickText(page, ["Next","NEXT"]);
  await settle(page, 1500);

  await fillLabel(page, ["Email addresses","Contact information","Contact email"], email).catch(()=>{});
  await clickText(page, ["Next","NEXT"]);
  await settle(page, 1500);

  await page.getByRole("checkbox").first().check().catch(()=>{});
  await clickText(page, ["Continue","Create","CREATE"]);
  await settle(page, 5000);
}

/* Test users — without this an unpublished app refuses to hand out tokens. */
async function addTestUser(page, project, email){
  await page.goto(`https://console.cloud.google.com/auth/audience?project=${project}`, { waitUntil:"domcontentloaded" });
  await settle(page, 4000);
  const text = await page.textContent("body").catch(()=>"");
  if(text.includes(email)){ ok("test user already added"); return "skipped"; }
  await clickText(page, ["Add users","ADD USERS"]);
  await settle(page, 1500);
  await page.getByRole("textbox").last().fill(email);
  await clickText(page, ["Save","SAVE","Add"]);
  await settle(page, 3000);
}

/* ============================================================
   5 — the OAuth client itself
   ============================================================ */
async function createClient(page, project){
  await page.goto(`https://console.cloud.google.com/auth/clients/create?project=${project}`, { waitUntil:"domcontentloaded" });
  await settle(page, 4000);

  // Application type → Web application
  try {
    await page.getByRole("combobox", { name:/Application type/i }).first().click({ timeout:6000 });
    await page.getByRole("option", { name:/Web application/i }).first().click({ timeout:6000 });
  } catch(e){
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name:/Web application/i }).first().click();
  }
  await settle(page, 1500);
  await fillLabel(page, ["Name"], APP_NAME+" server").catch(()=>{});

  // redirect URIs — one "Add URI" click per entry
  for(const uri of REDIRECTS){
    await clickText(page, ["Add URI","ADD URI"]).catch(()=>{});
    await settle(page, 800);
    const boxes = page.getByRole("textbox");
    await boxes.last().fill(uri);
    await settle(page, 400);
  }
  await clickText(page, ["Create","CREATE"]);
  await settle(page, 6000);

  // the credentials show up in a dialog — read them straight out of the text
  const text = await page.textContent("body").catch(()=>"");
  const id = (CLIENT_ID_RE.exec(text)||[])[0];
  const secret = (SECRET_RE.exec(text)||[])[0];
  if(!id || !secret) throw new Error("client created but id/secret were not on screen");
  return { id, secret };
}

function writeKey(id, secret){
  fs.writeFileSync(KEY_FILE, JSON.stringify({ client_id:id, client_secret:secret }, null, 2));
  ok(`google.key written (${id.slice(0,18)}…)`);
}

/* ============================================================
   6 — connect: run our own OAuth flow in the same window
   ============================================================ */
async function connectAccount(page){
  let s = await serverStatus();
  while(!s || s.configured === undefined){
    warn(`the server on :${PORT} is not running the new routes`);
    say(`${c.dim}→${c.x} restart it:  node server.js`);
    await pause("restart the server");
    s = await serverStatus();
  }
  if(s.connected){ ok(`already connected as ${s.email}`); return "skipped"; }

  await page.goto(`http://localhost:${PORT}/api/google/connect?pass=admin`, { waitUntil:"domcontentloaded" });
  await settle(page, 3000);

  // an unpublished app shows a scary interstitial — the way through is Advanced
  for(let i=0;i<6;i++){
    const t = await page.textContent("body").catch(()=>"");
    if(/Google ulandi|ulanib bo'lmadi/i.test(t)) break;
    if(/hasn.t verified|verified this app|Advanced/i.test(t)){
      await clickText(page, ["Advanced","Kengaytirilgan"]).catch(()=>{});
      await settle(page, 1000);
      await page.locator("text=/Go to .*(unsafe)/i").first().click({ timeout:5000 }).catch(()=>{});
      await settle(page, 2000);
      continue;
    }
    await clickText(page, ["Continue","Allow","Davom etish"]).catch(()=>{});
    await settle(page, 2500);
  }
  const final = await serverStatus();
  if(!final || !final.connected) throw new Error("the callback did not report a connected account");
  ok(`connected as ${final.email}`);
}

/* ============================================================
   run
   ============================================================ */
(async () => {
  console.log(`\n${c.b}  Google Meet setup — Tijorat Markazi${c.x}`);
  say(`${c.dim}redirect URIs: ${REDIRECTS.join("  ")}${c.x}`);

  const child = await startChrome();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.bringToFront().catch(()=>{});

  // proof the attach stayed invisible: a launched browser would report true
  const flagged = await page.evaluate(() => navigator.webdriver === true).catch(()=>null);
  if(flagged) warn("this browser reports navigator.webdriver — Google may refuse the sign-in");

  try {
    if(!flag("connect-only")){
      await step("Sign in to Google", () => waitForLogin(page),
        "Sign in at console.cloud.google.com in the open window.");

      const email = await ask("which Google address are you using?");
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("that is not an email address");

      const project = await step("Create the Cloud project", () => createProject(page),
        "Create a project at console.cloud.google.com/projectcreate.") ;
      const projectId = (typeof project === "string" && project !== "manual")
        ? project
        : await ask("project id?");

      await step("Enable the Calendar API", () => enableCalendar(page, projectId),
        `Open console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=${projectId} and press Enable.`);

      await step("Configure the consent screen", () => brandingSetup(page, projectId, email),
        `Open console.cloud.google.com/auth/branding?project=${projectId} → Get started → app name + your email → External.`);

      await step("Add yourself as a test user", () => addTestUser(page, projectId, email),
        `Open console.cloud.google.com/auth/audience?project=${projectId} → Test users → Add users → ${email}.`);

      const creds = await step("Create the OAuth client", () => createClient(page, projectId),
        [`Open console.cloud.google.com/auth/clients/create?project=${projectId}`,
         `Application type: Web application`,
         `Authorised redirect URIs:`, ...REDIRECTS.map(u=>"   "+u)].join("\n"));

      if(creds && creds.id) writeKey(creds.id, creds.secret);
      else {
        const id = await ask("client id?"), secret = await ask("client secret?");
        if(!id || !secret) throw new Error("no credentials — cannot continue");
        writeKey(id, secret);
      }
    }

    await step("Connect the account", () => connectAccount(page),
      `Restart the server, then open http://localhost:${PORT}/api/google/connect?pass=admin`);

    head("Done");
    say("scheduling a conference now books a Google Meet room automatically.");
    say(`${c.dim}scope: ${SCOPE_URL}${c.x}`);
  } catch(e){
    console.error(`\n  ${c.r}✗${c.x} ${e.message}\n`);
    process.exitCode = 1;
  } finally {
    // detach first, so closing never looks like a crash to Chrome
    await browser.close().catch(()=>{});
    if(!flag("keep-open") && child) { try { process.kill(-child.pid); } catch(e){ try { child.kill(); } catch(e2){} } }
  }
})();
