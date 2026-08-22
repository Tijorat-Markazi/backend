/* ============================================================
   TIJORAT MARKAZI — Google Meet rooms without an API

   No Cloud project, no OAuth client, no API key. A signed-in Chrome
   profile lives in data/.meet-profile, and when a conference is
   scheduled the server drives that browser exactly the way a person
   would:  meet.google.com → New meeting → Create a meeting for later
   → copy the link.

   You sign in once (Admin panel → Sozlamalar → "Google'ga kirish").
   The session is remembered from then on.

   The price of skipping the API: the profile has to stay signed in,
   and the buttons belong to Google. Both failure modes are reported
   back to the admin panel instead of being swallowed.

   Chrome is NEVER launched by Playwright here — a Playwright-launched
   browser carries --enable-automation and navigator.webdriver, and
   Google refuses to sign in to one. We start an ordinary Chrome that
   merely exposes a debug port, then attach.
   ============================================================ */
const fs    = require("fs");
const path  = require("path");
const http  = require("http");
const { spawn } = require("child_process");

const ROOT    = __dirname;
const DATA    = path.join(ROOT, "data");
const PROFILE = path.join(DATA, ".meet-profile");
const STATE   = path.join(DATA, "meet-bot.json");

const PORT      = Number(process.env.MEET_BOT_PORT) || 9223;
const IDLE_MS   = Number(process.env.MEET_BOT_IDLE_MS) || 10*60*1000;   // close the hidden browser when unused
const VISIBLE   = process.env.MEET_BOT_VISIBLE === "1";                 // show the window (debugging)
const NAV_MS    = 45000;

const MEET_LINK_RE = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i;

/* Google localises Meet to the account's language and prefixes menu labels
   with icon ligatures ("link Создать встречу"), so exact strings are useless.
   Match loosely instead, and rule the wrong items out by what they say. */
const MEET_HOME = "https://meet.google.com/?hl=en";
const T_NEW   = [/new meeting/i, /новая встреча/i, /yangi uchrashuv/i, /^\s*(создать|create)\s*$/i];
const T_LATER = [/create a meeting for later/i, /создать встречу/i, /uchrashuv yaratish/i, /create a meeting/i];
/* the two neighbours in that menu, which must never be picked by accident */
const NOT_LATER = [/instant/i, /мгновен/i, /schedule/i, /запланир/i, /calendar/i, /календар/i];

let playwright = null;
function pw(){
  if(playwright) return playwright;
  try { playwright = require("playwright-core"); }
  catch(e){ throw new Error("playwright_missing"); }
  return playwright;
}

/* ---------- small state file (what we know between restarts) ---------- */
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE,"utf8")); } catch(e){ return {}; } };
function saveState(patch){
  const s = Object.assign(loadState(), patch);
  fs.mkdirSync(DATA, { recursive:true });
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
  return s;
}
function status(){
  const s = loadState();
  return {
    available: hasChrome() && hasPlaywright(),
    signedIn: !!s.signedIn,
    email: s.email || "",
    since: s.since || 0,
    lastError: s.lastError || "",
    visible: VISIBLE,
  };
}
function hasPlaywright(){ try { pw(); return true; } catch(e){ return false; } }

/* ---------- chrome ---------- */
const CHROME_PATHS = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  path.join(process.env.LOCALAPPDATA||"", "Google/Chrome/Application/chrome.exe"),
  "/usr/bin/google-chrome", "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
function chromePath(){
  const hit = CHROME_PATHS.find(p => { try { return fs.statSync(p).isFile(); } catch(e){ return false; } });
  if(!hit) throw new Error("chrome_not_found");
  return hit;
}
const hasChrome = () => { try { chromePath(); return true; } catch(e){ return false; } };

function endpoint(){
  return new Promise(res => {
    const r = http.get({ host:"127.0.0.1", port:PORT, path:"/json/version", timeout:1500 }, s => {
      let b=""; s.on("data", d=>b+=d); s.on("end", ()=>{ try{ res(JSON.parse(b)); }catch(e){ res(null); } });
    });
    r.on("error", ()=>res(null));
    r.on("timeout", ()=>{ r.destroy(); res(null); });
  });
}

let child = null;          // the Chrome we spawned
let browser = null;        // the CDP connection
let idleTimer = null;

function chromeArgs(visible){
  const window = visible
    ? ["--start-maximized"]
    : ["--window-position=-32000,-32000", "--window-size=1280,900"];   // parked off-screen, still renders
  return [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,      // required: Chrome 136+ refuses a debug port on the default profile
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    ...window,
  ];
}

async function connect(visible){
  clearTimeout(idleTimer);
  if(browser && browser.isConnected()) return browser;

  if(!await endpoint()){
    fs.mkdirSync(PROFILE, { recursive:true });
    child = spawn(chromePath(), chromeArgs(visible), { detached:true, stdio:"ignore" });
    child.unref();
    const until = Date.now() + 30000;
    let up = null;
    while(Date.now() < until && !up){
      await new Promise(r=>setTimeout(r, 700));
      up = await endpoint();
    }
    if(!up) throw new Error("chrome_no_debug_port");
  }
  browser = await pw().chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  return browser;
}
function touchIdle(){
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { close().catch(()=>{}); }, IDLE_MS);
  if(idleTimer.unref) idleTimer.unref();
}
async function close(){
  clearTimeout(idleTimer);
  try { if(browser && browser.isConnected()) await browser.close(); } catch(e){}
  browser = null;
  if(child){ try { process.kill(-child.pid); } catch(e){ try { child.kill(); } catch(e2){} } child = null; }
}

async function blankPage(visible){
  const b = await connect(visible);
  const ctx = b.contexts()[0] || await b.newContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  return page;
}

/* ---------- is the profile still signed in? ---------- */
async function readSignedIn(page){
  const url = page.url();
  if(/accounts\.google\.com|ServiceLogin|signin/i.test(url)) return { signedIn:false, email:"" };
  const body = await page.textContent("body").catch(()=>"") || "";
  if(/Sign in|Kirish|Войти/i.test(body) && !/New meeting|Yangi uchrashuv|Новая встреча/i.test(body))
    return { signedIn:false, email:"" };
  // the account button spells the address out in its aria-label
  const label = await page.evaluate(() => {
    const n = document.querySelector('[aria-label*="@"]');
    return n ? n.getAttribute("aria-label") : "";
  }).catch(()=>"");
  const email = (/[\w.+-]+@[\w-]+\.[\w.]+/.exec(label||"")||[])[0] || "";
  return { signedIn:true, email };
}

async function check(){
  const page = await blankPage(VISIBLE);
  try {
    await page.goto("https://meet.google.com/", { waitUntil:"domcontentloaded", timeout:NAV_MS });
    await page.waitForTimeout(3500);
    const r = await readSignedIn(page);
    saveState({ signedIn:r.signedIn, email:r.email||loadState().email||"", lastError:r.signedIn?"":"not_signed_in" });
    return r;
  } finally { await page.close().catch(()=>{}); touchIdle(); }
}

/* ---------- sign in (a visible window, a human, once) ---------- */
let loginPage = null;
async function openLogin(){
  if(browser && browser.isConnected() && !VISIBLE) await close();   // the hidden window is no use for typing
  const b = await connect(true);
  const ctx = b.contexts()[0] || await b.newContext();
  loginPage = ctx.pages()[0] || await ctx.newPage();
  await loginPage.goto("https://accounts.google.com/ServiceLogin?continue=https://meet.google.com/",
    { waitUntil:"domcontentloaded", timeout:NAV_MS }).catch(()=>{});
  await loginPage.bringToFront().catch(()=>{});
  watchLogin();
  return true;
}
/* poll quietly in the background so the admin panel can flip to "signed in" */
async function watchLogin(){
  const until = Date.now() + 10*60*1000;
  while(Date.now() < until){
    await new Promise(r=>setTimeout(r, 4000));
    if(!loginPage || loginPage.isClosed()) return;
    const url = loginPage.url();
    if(!/meet\.google\.com/.test(url)) continue;
    const r = await readSignedIn(loginPage).catch(()=>null);
    if(r && r.signedIn){
      saveState({ signedIn:true, email:r.email, since:Date.now(), lastError:"" });
      return;
    }
  }
}

/* ---------- the actual job: one meeting, created like a person ---------- */
async function makeMeeting(){
  const page = await blankPage(VISIBLE);
  try {
    await page.goto(MEET_HOME, { waitUntil:"domcontentloaded", timeout:NAV_MS });
    await page.waitForTimeout(3500);

    const who = await readSignedIn(page);
    if(!who.signedIn){ saveState({ signedIn:false, lastError:"not_signed_in" }); throw new Error("not_signed_in"); }

    const newBtn = await clickMatching(page, {
      selector: 'button,[role="button"]', want: T_NEW,
    }).catch(e => { throw new Error("no_new_meeting_button"); });
    await page.waitForTimeout(1500);

    // the menu that drops down holds three items; we want the "for later" one,
    // never the instant meeting and never the calendar entry
    const item = await clickMatching(page, {
      selector: '[role="menuitem"]', want: T_LATER, avoid: NOT_LATER, fallbackFirst: true,
    }).catch(e => { throw new Error("no_create_later_item"); });
    console.log(`[meet-bot] ${newBtn} → ${item}`);
    await page.waitForTimeout(2500);

    // the link shows up in a dialog — read it straight out of the text
    let link = "";
    for(let i=0; i<12 && !link; i++){
      const body = await page.textContent("body").catch(()=>"") || "";
      const m = MEET_LINK_RE.exec(body);
      if(m) link = "https://meet.google.com/" + m[1].toLowerCase();
      else await page.waitForTimeout(1000);
    }
    if(!link) throw new Error("link_not_shown");

    saveState({ signedIn:true, email:who.email||loadState().email||"", lastError:"" });
    return { link };
  } finally { await page.close().catch(()=>{}); touchIdle(); }
}

/* Click the first visible element whose label matches, doing the matching
   inside the page: the accessible name and the icon-prefixed innerText are
   both fair game, and a real .click() sidesteps Playwright's strict checks. */
async function clickMatching(page, { selector, want, avoid = [], fallbackFirst = false }){
  const picked = await page.evaluate(({ selector, want, avoid, fallbackFirst }) => {
    const rx = s => new RegExp(s.source, s.flags);
    const wants = want.map(w => rx(w)), avoids = avoid.map(a => rx(a));
    const label = n => ((n.innerText || "") + " " + (n.getAttribute("aria-label") || ""))
      .replace(/\s+/g, " ").trim();
    const visible = [...document.querySelectorAll(selector)].filter(n => {
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const usable = visible.filter(n => !avoids.some(a => a.test(label(n))));
    const hit = usable.find(n => wants.some(w => w.test(label(n))))
             || (fallbackFirst ? usable[0] : null);
    if(!hit) return null;
    hit.click();
    return label(hit).slice(0, 60);
  }, { selector, want, avoid, fallbackFirst });
  if(!picked) throw new Error("button_not_found");
  return picked;
}

/* One browser, one page at a time — conferences created at the same
   moment queue up instead of fighting over the same window. */
let chain = Promise.resolve();
function serialize(fn){
  const run = chain.then(fn, fn);
  chain = run.catch(()=>{});
  return run;
}
const createMeeting = () => serialize(makeMeeting);
const verify        = () => serialize(check);

function signOut(){
  return close().then(() => {
    try { fs.rmSync(PROFILE, { recursive:true, force:true }); } catch(e){}
    saveState({ signedIn:false, email:"", since:0, lastError:"" });
    return true;
  });
}

module.exports = { status, createMeeting, verify, openLogin, signOut, close, PROFILE };
