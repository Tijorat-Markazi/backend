/* ============================================================
   AI COPILOTS for the three market modules

   Bozor  §9.1  Catalog · Quote Builder · Export Copilot
   Moliya §17.1 Investor-Ready · Idea-to-Business · Finance Finder
   Mehnat §16.1 Vacancy · CV parser · Career · Interview coach

   Guardrails that all three TZs state and that are enforced here
   rather than left to prompt wording:

   • Every output is a DRAFT. `draft:true` and a review notice ride
     on every response, so no caller can present one as final.
   • Facts the user did not supply are labelled `assumption`, never
     merged into the record. Bozor §9.2, Moliya §8.2, Mehnat §16.2.
   • Nothing here writes to a domain store. A copilot proposes; the
     user saves. That keeps the human in the loop by construction.
   • No legal, tax, Sharia, credit or investment conclusion is
     produced — those are named as expert-review items instead.
   ============================================================ */
const AI = require("../claude");
const H  = require("./store");

const LANG_NAME = { uz: "Uzbek (Latin script)", ru: "Russian", en: "English" };
const lang = l => LANG_NAME[H.S(l, 4)] || LANG_NAME.uz;

const REVIEW_NOTE = {
  uz: "Bu AI tayyorlagan qoralama. Foydalanishdan oldin tekshiring va tasdiqlang.",
  ru: "Это черновик, подготовленный ИИ. Проверьте и подтвердите перед использованием.",
  en: "This is an AI-prepared draft. Review and approve before use.",
};

/** Shared JSON contract: the model must answer with one object and nothing else. */
const JSON_RULES = `
OUTPUT CONTRACT — follow exactly:
- Reply with ONE JSON object and nothing else. No markdown fence, no prose around it.
- Use only the keys named in the schema. Omit a key you have no grounds for.
- Never invent a number, price, certificate, law, salary or company fact the user did not give you.
  If a figure is needed to make the document useful, put it in "assumptions" as an explicit
  assumption with its reasoning — never inside the body as if it were a fact.
- Everything you produce is a DRAFT for human approval.`;

async function ask(system, user, opts){
  if(!AI.ready()) return { ok: false, error: "ai_off" };
  try{
    const text = await AI.write(system, user, opts || { maxTokens: 4000 });
    if(!text) return { ok: false, error: "empty" };
    return { ok: true, text };
  }catch(e){ return { ok: false, error: String((e && e.message) || e).slice(0, 200) }; }
}

/** Models sometimes wrap JSON in a fence despite instructions — recover it. */
function parseJson(text){
  const raw = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(raw); } catch(e){}
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  if(a >= 0 && b > a){ try { return JSON.parse(raw.slice(a, b + 1)); } catch(e){} }
  return null;
}

async function structured(system, user, l){
  const r = await ask(system + "\n" + JSON_RULES, user);
  if(!r.ok) return r;
  const obj = parseJson(r.text);
  if(!obj) return { ok: false, error: "bad_json", raw: r.text.slice(0, 400) };
  return { ok: true, draft: true, review: REVIEW_NOTE[H.S(l, 4)] || REVIEW_NOTE.uz, data: obj };
}

/* ============================================================
   BOZOR
   ============================================================ */
/** §4.1 / §9.1 Catalog Copilot — raw text into a structured product card. */
function catalogDraft(body){
  const l = H.S(body.lang, 4) || "uz";
  const system = `You are the Catalog Copilot of TIJORAT MARKAZI's "Bozor" B2B/B2G/Export marketplace.
Turn a seller's rough description into a structured product card, written in ${lang(l)}.
Suggest the sales channels the product plausibly fits: b2b (wholesale), b2g (state/corporate buyers),
export (foreign buyers). Recommend a channel only when the description supports it.
Schema: {"title":"","desc":"","category":"","brand":"","specs":"","unit":"","channels":["b2b"],
"hs":"","incoterms":[],"markets":[],"certificates":[],"keywords":[],"assumptions":[{"field":"","assumed":"","why":""}],
"missing":["what the seller still has to fill in: price, MOQ, lead time, certificates…"]}
HS codes: give one only if the product category makes it unambiguous; otherwise leave "" and list it under "missing".`;
  return structured(system, `Mahsulot tavsifi:\n${H.S(body.text, 4000)}\n` +
    (body.sector ? `Kompaniya sohasi: ${H.S(body.sector, 120)}\n` : "") +
    (body.company ? `Kompaniya: ${H.S(body.company, 160)}` : ""), l);
}

/** §9.1 Quote Builder — a commercial offer skeleton against a real RFQ. */
function quoteDraft(body){
  const l = H.S(body.lang, 4) || "uz";
  const system = `You are the Quote Builder of TIJORAT MARKAZI "Bozor".
Draft a commercial offer for a seller replying to a buyer's RFQ, in ${lang(l)}.
You must not invent the seller's price. If the seller gave a unit price, use it and compute totals.
If they did not, leave price fields empty and say so under "missing".
Schema: {"summary":"","lineItems":[{"item":"","qty":0,"unit":"","unitPrice":0,"total":0}],
"terms":{"payment":"","delivery":"","incoterm":"","validity":"","warranty":""},
"coverNote":"","questionsForBuyer":[],"assumptions":[{"field":"","assumed":"","why":""}],"missing":[]}`;
  const rfq = body.rfq || {};
  return structured(system,
    `RFQ: ${H.S(rfq.title, 200)}\nSpec: ${H.S(rfq.spec, 2000)}\nQty: ${H.N(rfq.qty)} ${H.S(rfq.unit, 20)}\n` +
    `Budget: ${H.N(rfq.budget)} ${H.S(rfq.currency, 5)}\nChannel: ${H.S(rfq.channel, 10)}\n` +
    `Incoterm: ${H.S(rfq.incoterm, 12)}\n\nSotuvchi maʼlumoti:\n${H.S(body.seller, 2000)}`, l);
}

/** §8 Export Copilot — market fit and the export-readiness checklist. */
function exportAdvice(body){
  const l = H.S(body.lang, 4) || "uz";
  const system = `You are the Export Copilot of TIJORAT MARKAZI "Bozor", advising an Uzbek producer.
Answer in ${lang(l)}. Cover: plausible target markets and why, HS-code direction, the export document
checklist, packaging/marking notes, Incoterm options and the logistics questions to resolve.
Do NOT state customs duties, quotas, tariff rates or legal requirements as fact — name them as items to
verify with the customs authority or a licensed broker, under "verify".
Schema: {"markets":[{"country":"","why":"","difficulty":"low|medium|high"}],"hsDirection":"",
"documents":[],"packaging":[],"incoterms":[],"logisticsQuestions":[],"verify":[],
"nextSteps":[],"assumptions":[{"field":"","assumed":"","why":""}]}`;
  return structured(system, `Mahsulot: ${H.S(body.product, 2000)}\nKompaniya: ${H.S(body.company, 300)}\n` +
    `Maqsadli bozor (agar bor boʻlsa): ${H.S(body.market, 120)}`, l);
}

/* ============================================================
   MOLIYA
   ============================================================ */
/** §8.1 Investor-Ready Studio — teaser, IM outline, risk register, data-room checklist. */
function investorReady(body){
  const l = H.S(body.lang, 4) || "uz";
  const system = `You are the Investor-Ready Copilot of TIJORAT MARKAZI "Moliya bozori".
Structure the user's project or startup into an investor-facing package, in ${lang(l)}.
You are a structurer and analyst, not a source of facts. Every figure must come from the user's input.
Where a figure is missing and the pack needs one, put it in "assumptions" with its basis — never in the body.
Mark each number you carry over with its source status: "user-provided" or "assumption".
Do NOT give investment advice, a valuation conclusion, a legal opinion, or a Sharia ruling.
Schema: {"teaser":{"problem":"","solution":"","market":"","traction":"","ask":"","useOfFunds":""},
"deckOutline":[{"slide":"","content":""}],
"imSections":[{"section":"","summary":""}],
"riskRegister":[{"risk":"","category":"commercial|financial|operational|legal|esg|execution","mitigation":"","severity":"low|medium|high"}],
"dataRoomChecklist":[{"item":"","required":true}],
"ddQuestions":[],
"readinessGaps":[],
"figures":[{"label":"","value":"","source":"user-provided|assumption"}],
"assumptions":[{"field":"","assumed":"","why":""}],
"expertReview":["items that need a licensed/legal/audit/Sharia expert"]}`;
  return structured(system, `Loyiha / startup maʼlumoti:\n${H.S(body.text, 6000)}\n\n` +
    `Soʻralayotgan kapital: ${H.N(body.ask)} ${H.S(body.currency, 5)}\nSektor: ${H.S(body.sector, 120)}\n` +
    `Bosqich: ${H.S(body.stage, 40)}`, l);
}

/** §12.3 Idea-to-Business Copilot. */
function ideaToBusiness(body){
  const l = H.S(body.lang, 4) || "uz";
  const system = `You are the Idea-to-Business Copilot of TIJORAT MARKAZI "Moliya bozori" Idea Exchange.
Break an idea into a business structure, in ${lang(l)}, and score its attractiveness with reasons.
The score is a discussion aid, never a verdict on the idea's worth.
Do NOT assess patentability or IP ownership — flag those for a legal expert.
Schema: {"problem":"","customer":"","valueProposition":"","revenueModel":"","goToMarket":"",
"mvpScope":[],"costStructure":[],"risks":[],"competition":"",
"attractiveness":{"score":0,"reasons":[],"weaknesses":[]},
"validationExperiments":[{"experiment":"","cost":"low|medium|high","learns":""}],
"monetization":{"recommended":"sale|license|royalty|equity|codev","why":""},
"expertReview":[],"assumptions":[{"field":"","assumed":"","why":""}]}`;
  return structured(system, `Gʻoya:\n${H.S(body.text, 5000)}\nSektor: ${H.S(body.sector, 120)}`, l);
}

/** §4.3 Smart Finance Finder — natural language into a structured, filterable need. */
function financeNeed(body){
  const l = H.S(body.lang, 4) || "uz";
  const system = `You are the Smart Finance Finder of TIJORAT MARKAZI "Moliya bozori".
Turn a business's plain-language funding sentence into a structured search, in ${lang(l)}.
Never state that any financing will be approved or quote a rate.
category must be one of: banking, nobank, insurance, fintech, equity, islamic, development.
Schema: {"amount":0,"currency":"UZS|USD|EUR|RUB","tenor":0,"purpose":"","category":"",
"instruments":[],"sharia":false,"sector":"","region":"",
"whyThese":[],"documentsLikelyNeeded":[],"questionsToAnswer":[],
"assumptions":[{"field":"","assumed":"","why":""}]}
tenor is in MONTHS.`;
  return structured(system, H.S(body.text, 1500), l);
}

/* ============================================================
   MEHNAT
   ============================================================ */
/** §6.2 Smart Vacancy Builder. */
function vacancyDraft(body){
  const l = H.S(body.lang, 4) || "uz";
  const system = `You are the Vacancy Copilot of TIJORAT MARKAZI "Human Capital Markazi".
Draft a standardised job advert in ${lang(l)}.
Separate MUST-HAVE from NICE-TO-HAVE requirements — the TZ requires that split.
Never write a requirement based on gender, age, marital status, nationality, religion or appearance;
if the user asked for one, drop it and say so in "removedRequirements".
Do not invent a salary. If the user gave none, leave the fields at 0 and list it in "missing".
seniority must be one of: intern, junior, middle, senior, lead, head.
Schema: {"title":"","occupation":"","summary":"","duties":"","skillsRequired":[],"skillsPreferred":[],
"languages":[],"certificates":[],"seniority":"","yearsMin":0,"salaryMin":0,"salaryMax":0,
"format":"onsite|hybrid|remote","employment":"full|part|shift|project|seasonal|internship",
"screeningQuestions":[],"removedRequirements":[],"missing":[],"assumptions":[{"field":"","assumed":"","why":""}]}`;
  return structured(system, `Lavozim haqida:\n${H.S(body.text, 3000)}\n` +
    `Kompaniya: ${H.S(body.company, 160)} · Soha: ${H.S(body.sector, 120)} · Hudud: ${H.S(body.region, 120)}`, l);
}

/** §16.1 CV Parser — free-form CV text into a Human Capital Passport draft. */
function cvParse(body){
  const l = H.S(body.lang, 4) || "uz";
  const system = `You are the CV Parser of TIJORAT MARKAZI "Human Capital Markazi".
Extract a structured candidate profile from CV text. Keep the person's own wording where possible.
Extract ONLY what the CV states. Never infer a salary, a skill level or an employer that is not written.
Do NOT extract or return gender, age, date of birth, marital status, nationality, religion or photo —
those must not enter the platform at all.
seniority must be one of: intern, junior, middle, senior, lead, head.
Schema: {"name":"","headline":"","occupation":"","region":"","seniority":"","years":0,
"skills":[],"languages":[],"certificates":[],"education":"","experience":"",
"portfolio":"","missing":[],"assumptions":[{"field":"","assumed":"","why":""}]}`;
  return structured(system, H.S(body.text, 12000), l);
}

/** §5.2 Career Copilot — skill-gap plan and career paths against a target role. */
function careerPlan(body){
  const l = H.S(body.lang, 4) || "uz";
  const system = `You are the Career Copilot of TIJORAT MARKAZI "Human Capital Markazi".
Answer in ${lang(l)}. Given a candidate profile and a target role, produce the skill gap and a
realistic learning path. Do not promise employment, salary or timelines as certainty — express
transition likelihood as low/medium/high with the reasoning.
Schema: {"targetRole":"","gapSkills":[{"skill":"","why":"","effort":"low|medium|high"}],
"strengths":[],"learningPlan":[{"step":"","outcome":"","weeks":0}],
"careerPaths":[{"role":"","likelihood":"low|medium|high","why":""}],
"cvImprovements":[],"interviewQuestions":[],"assumptions":[{"field":"","assumed":"","why":""}]}`;
  return structured(system, `Nomzod profili:\n${H.S(body.profile, 4000)}\n\nMaqsadli lavozim: ${H.S(body.target, 200)}\n` +
    (body.market ? `Bozor maʼlumoti:\n${H.S(body.market, 2000)}` : ""), l);
}

/** §5.2 Interview Coach — role-specific questions and a scorecard for the interviewer. */
function interviewKit(body){
  const l = H.S(body.lang, 4) || "uz";
  const system = `You are the Interview Coach of TIJORAT MARKAZI "Human Capital Markazi".
Produce an interview kit in ${lang(l)} for one specific role.
Every question must probe a job-related competency. Never suggest a question about family plans,
age, health, religion, nationality, politics or any protected characteristic.
Schema: {"competencies":[{"name":"","whyItMatters":""}],
"questions":[{"q":"","competency":"","lookFor":"","redFlag":""}],
"scorecard":[{"criterion":"","weight":0,"levels":{"1":"","3":"","5":""}}],
"candidatePrep":[],"assumptions":[{"field":"","assumed":"","why":""}]}`;
  return structured(system, `Vakansiya:\n${H.S(body.vacancy, 3000)}` +
    (body.candidate ? `\n\nNomzod:\n${H.S(body.candidate, 2000)}` : ""), l);
}

/* Route table — one place the API layer can dispatch from. */
const AGENTS = {
  "bozor.catalog":  catalogDraft,
  "bozor.quote":    quoteDraft,
  "bozor.export":   exportAdvice,
  "moliya.investor-ready": investorReady,
  "moliya.idea":    ideaToBusiness,
  "moliya.finance-need": financeNeed,
  "mehnat.vacancy": vacancyDraft,
  "mehnat.cv":      cvParse,
  "mehnat.career":  careerPlan,
  "mehnat.interview": interviewKit,
};

const agentNames = () => Object.keys(AGENTS);
function run(agent, body){
  const fn = AGENTS[H.S(agent, 60)];
  if(!fn) return Promise.resolve({ ok: false, error: "unknown_agent", agents: agentNames() });
  return fn(body || {});
}

module.exports = { AGENTS, agentNames, run, ready: AI.ready, REVIEW_NOTE };
