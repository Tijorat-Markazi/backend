/* ============================================================
   Demo data for the three market modules.

     node srv/seed.js --clear    empty Bozor / Moliya / Mehnat
     node srv/seed.js            empty them, then load a small
                                 coherent starter set

   Only the three new collections are touched. Companies,
   associations, chats, appeals and the showroom are never
   written to by this script.
   ============================================================ */
const path = require("path");
const DB = require("../db");

const DATA = path.join(__dirname, "..", "data");
const FILES = ["bozor.json", "moliya.json", "mehnat.json"];

const EMPTY = {
  "bozor.json":  { products: [], rfqs: [], quotes: [], deals: [], inquiries: [], events: [] },
  "moliya.json": { products: [], requests: [], offers: [], passports: [], investors: [],
                   projects: [], startups: [], ideas: [], events: [] },
  "mehnat.json": { candidates: [], vacancies: [], applications: [], events: [] },
};

async function main(){
  await DB.init();

  for(const f of FILES) DB.set(path.join(DATA, f), EMPTY[f]);
  await DB.flush();
  console.log("cleared: " + FILES.join(", "));

  if(process.argv.includes("--clear")){ await DB.close(); return; }

  /* Modules are required only now, so they read the cleared state. */
  const B = require("./bozor");
  const M = require("./moliya");
  const K = require("./moliya-capital");
  const W = require("./mehnat");

  const orgs = DB.get(path.join(DATA, "orgs.json"), { companies: [] });
  const co = (orgs.companies || [])[0];
  if(!co){ console.log("no company registered — nothing to attach demo data to"); await DB.close(); return; }
  const company = { id: co.id, name: co.name, sector: co.sector, assocId: co.assocId };
  console.log("attaching demo data to: " + company.name);

  /* ---- Bozor ---- */
  B.productSave(company, {
    title: "Quritilgan oʻrik — Premium", desc: "Namangan oʻrigi, oltingugurtsiz quritilgan, eksport qadoqda.",
    category: "Quruq mevalar", price: 4.2, currency: "USD", unit: "kg", moq: 1000,
    tiers: [{ from: 5000, price: 3.9 }, { from: 20000, price: 3.6 }],
    leadTime: 14, stock: 80000, region: "Namangan", channels: ["b2b", "export"],
    hs: "081310", incoterms: ["FOB", "CIF"], markets: ["Russia", "Poland", "Germany"],
    certificates: ["ISO 22000", "Halal"], localMade: true,
    specs: "Namlik 18%, kalibr 25-30 mm, urugʻsiz",
  });
  B.productSave(company, {
    title: "Pomidor pastasi 25%", desc: "800 g banka, ulgurji va davlat xaridlari uchun.",
    category: "Konserva", price: 1.1, currency: "USD", unit: "dona", moq: 5000,
    leadTime: 21, stock: 240000, region: "Toshkent", channels: ["b2b", "b2g"],
    certificates: ["ISO 22000"], localMade: true, specs: "Quruq modda 25%, Brix 26",
  });

  B.rfqAdd({
    channel: "export", title: "Dried apricot — 20 t", buyerName: "PolFood Sp. z o.o.",
    spec: "Quritilgan oʻrik, oltingugurtsiz, ISO 22000 sertifikati bilan, FOB Toshkent.",
    category: "Quruq mevalar", qty: 20000, unit: "kg", budget: 78000, currency: "USD",
    country: "Poland", incoterm: "FOB", certificates: ["ISO 22000"], maxLead: 30,
  }, { id: "u:buyer@polfood.pl", name: "PolFood Sp. z o.o." });

  B.rfqAdd({
    channel: "b2g", title: "Maktab oshxonalari uchun konserva", buyerName: "Hudud xarid boʻlimi",
    spec: "Pomidor pastasi 800 g, yillik yetkazib berish, mahalliy ishlab chiqaruvchi ustuvor.",
    category: "Konserva", qty: 60000, unit: "dona", budget: 70000, currency: "USD",
    region: "Toshkent", maxLead: 45,
  }, { id: "u:xarid@hokimlik.uz", name: "Hudud xarid boʻlimi" });

  /* ---- Moliya bozori ---- */
  M.productSave(company, {
    category: "banking", name: "Agro aylanma mablagʻ", instrument: "Working capital",
    summary: "Qishloq xoʻjaligi korxonalari uchun 24 oygacha aylanma mablagʻ.",
    segments: ["sme", "agro", "exporter"], minAmount: 100000000, maxAmount: 5000000000,
    currency: "UZS", tenorMin: 6, tenorMax: 24, rate: "22–26% yillik", feeModel: "1% bir martalik",
    collateral: "Koʻchmas mulk yoki tovar zaxirasi", eligibility: "12 oy faoliyat, ijobiy cash-flow",
    docs: ["Moliyaviy hisobot", "Bank koʻchirmasi", "Taʼminot hujjatlari"],
    sectors: ["Agriculture"], sla: 7, licence: "Namunaviy demo yozuv",
  });
  M.productSave(company, {
    category: "islamic", name: "Murabaha — uskuna", instrument: "Murabaha", sharia: true,
    summary: "Uskuna xaridi uchun Murabaha strukturasi; yakuniy xulosa Sharia board tomonidan beriladi.",
    segments: ["sme"], minAmount: 50000000, maxAmount: 2000000000, currency: "UZS",
    tenorMin: 12, tenorMax: 36, feeModel: "Kelishilgan ustama", licence: "Namunaviy demo yozuv",
  });
  M.productSave(company, {
    category: "nobank", name: "Eksport faktoringi", instrument: "Factoring",
    summary: "Eksport shartnomalari boʻyicha debitorlikni 80% gacha oldindan moliyalashtirish.",
    segments: ["exporter", "sme"], minAmount: 200000000, maxAmount: 3000000000,
    currency: "USD", tenorMin: 1, tenorMax: 9, feeModel: "Advance 80%, komissiya kelishuv asosida",
    licence: "Namunaviy demo yozuv",
  });

  K.investorSave({ id: "u:vc@silkroad.uz", name: "Silk Road Ventures" }, {
    type: "vc", ticketMin: 100000, ticketMax: 2000000, currency: "USD",
    stages: ["seed", "growth"], sectors: ["Agriculture", "Logistics"],
    geos: ["Uzbekistan", "Central Asia"], instruments: ["equity", "convertible"],
    thesis: "Agro qayta ishlash, eksport logistikasi va oziq-ovqat texnologiyalarida oʻsuvchi kompaniyalar.",
  });
  K.projectSave({ id: "u:sponsor@agro.uz", name: "AgroPro MChJ" }, {
    name: "Meva quritish zavodi", sector: "Agriculture", region: "Namangan",
    summary: "Quvvati 5 000 t/yil quritilgan meva zavodi, eksportga yoʻnaltirilgan.",
    capex: 4200000, opex: 900000, revenue: 6500000, currency: "USD",
    irr: 24, npv: 3100000, dscr: 1.8, ask: 2500000, instruments: ["equity", "debt"],
    jobs: 120, exportShare: 70, risks: "Xom ashyo narxi, valyuta kursi, logistika kechikishi",
  });
  K.startupSave({ id: "u:founder@agtech.uz", name: "AgTech Uz" }, {
    stage: "seed", sector: "Agriculture", region: "Toshkent",
    pitch: "Fermerlar uchun sunʼiy intellektli hosildorlik prognozi va suv sarfi optimizatsiyasi.",
    mrr: 8000, users: 340, growth: 12, runway: 9, ask: 500000, currency: "USD", valuation: 4000000,
  });
  K.ideaSave({ id: "u:author@idea.uz", name: "Dilshod" }, {
    title: "Paxta chiqindisidan qadoqlash materiali",
    teaser: "Paxta qayta ishlash chiqindisini biologik parchalanuvchi qadoqqa aylantirish texnologiyasi.",
    confidential: "Maxfiy qism: jarayon uch bosqichli — gidroliz, presslash va qoplama.",
    sector: "Manufacturing", model: "license", price: 60000, currency: "USD",
    ipStatus: "Patent arizasi topshirilgan",
  });

  /* ---- Human Capital ---- */
  W.vacancySave(company, {
    title: "Moliyaviy tahlilchi", occupation: "Moliyaviy tahlilchi",
    summary: "Agro korxona uchun byudjet, cash-flow prognozi va IFRS hisobot.",
    duties: "Byudjet tayyorlash, cash-flow prognozi, IFRS hisobotlarini yigʻish",
    skillsRequired: ["IFRS", "Excel", "Financial modelling"], skillsPreferred: ["SQL", "1C"],
    languages: ["uz", "ru"], seniority: "senior", yearsMin: 5,
    salaryMin: 13000000, salaryMax: 17000000, currency: "UZS",
    region: "Toshkent", format: "hybrid", employment: "full", headcount: 1,
  });
  W.vacancySave(company, {
    title: "Eksport menejeri", occupation: "Eksport menejeri",
    summary: "Xorijiy xaridorlar bilan ishlash, eksport hujjatlari va logistika muvofiqlashtiruvi.",
    duties: "Buyer discovery, tijorat taklifi, Incoterms, eksport hujjatlari",
    skillsRequired: ["Eksport", "Ingliz tili", "Muzokara"], skillsPreferred: ["Incoterms", "CRM"],
    languages: ["uz", "en"], seniority: "middle", yearsMin: 3,
    salaryMin: 9000000, salaryMax: 14000000, currency: "UZS",
    region: "Toshkent", format: "onsite", employment: "full", headcount: 2,
  });
  W.candidateSave({ id: "u:aziz@example.uz", name: "Aziz Karimov" }, {
    headline: "Senior moliyachi · agro sektor", region: "Toshkent", occupation: "Moliyaviy tahlilchi",
    seniority: "senior", years: 8, skills: ["IFRS", "Excel", "1C", "Financial modelling", "SQL"],
    languages: ["uz", "ru", "en"], certificates: ["ACCA F1–F3"], education: "TDIU, moliya",
    experience: "8 yil agro-sanoat korxonalarida moliyaviy tahlil va byudjetlashtirish.",
    expectedMin: 12000000, expectedMax: 18000000, currency: "UZS",
    availability: "active", formats: ["hybrid", "onsite"], employment: ["full"],
  });
  W.candidateSave({ id: "u:nilufar@example.uz", name: "Nilufar Yoʻldosheva" }, {
    headline: "Eksport menejeri · oziq-ovqat", region: "Toshkent", occupation: "Eksport menejeri",
    seniority: "middle", years: 4, skills: ["Eksport", "Ingliz tili", "Incoterms", "Muzokara"],
    languages: ["uz", "ru", "en"], education: "TDIU, xalqaro savdo",
    experience: "4 yil quruq meva va konserva eksporti; Rossiya va Polsha bozorlari.",
    expectedMin: 10000000, expectedMax: 15000000, currency: "UZS",
    availability: "open", formats: ["onsite", "hybrid"], employment: ["full"], visibility: "anonymous",
  });

  await DB.flush();
  const b = B.load(), m = M.load(), w = W.load();
  console.log(`bozor:  ${b.products.length} product(s), ${b.rfqs.length} RFQ(s)`);
  console.log(`moliya: ${m.products.length} product(s), ${m.investors.length} investor(s), ` +
    `${m.projects.length} project(s), ${m.startups.length} startup(s), ${m.ideas.length} idea(s)`);
  console.log(`mehnat: ${w.vacancies.length} vacancy(ies), ${w.candidates.length} candidate(s)`);
  await DB.close();
}

main().catch(e => { console.error(e); process.exit(1); });
