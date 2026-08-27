# Huquqiy muvofiqlik — O'zbekiston Respublikasi

**Holat:** 2026-08-27 · **Hujjat versiyalari:** oferta 1.0 / maxfiylik 1.0 / shartlar 1.0

Bu fayl platformaning O'zbekiston qonunchiligiga muvofiqligi bo'yicha nima
qilingani va nima qolgani haqida. Kod bilan birga yangilanishi kerak.

---

## 1. Eng muhim xulosa: lokalizatsiya talab qilinmaydi

2021-yildan 2026-yil martigacha O'zbekiston fuqarolarining **barcha** shaxsga
doir ma'lumotlari mamlakat hududidagi serverlarda saqlanishi va baza Davlat
reyestrida ro'yxatdan o'tishi shart edi.

**2026-yil 26-martdagi ZRU-1125-son Qonuni** (27-martdan kuchga kirgan) buni
uchta toifagacha toraytirdi:

| Majburiy lokalizatsiya qilinadigan toifa | Platformada bormi? |
|---|---|
| Jismoniy shaxslarning **biometrik** ma'lumotlari | Yo'q |
| **Genetik** ma'lumotlar | Yo'q |
| O'zbekistondagi **telekom operatorlari** foydalanuvchilari ma'lumotlari | Yo'q |

Platforma faqat F.I.Sh., lavozim, e-pochta, telefon va korxona ma'lumotlarini
to'playdi. Shu sababli:

- **O'zbekistonda hosting majburiy emas.**
- **Davlat reyestrida ro'yxatdan o'tish majburiyati yo'q.**

> Bu holat `srv/legal.js` dagi `COLLECTED` ro'yxatiga bog'langan. Agar biror
> maydonga `biometric: true` qo'yilsa, `/api/legal` darhol
> `localisationRequired: true` qaytaradi va yuqoridagi xulosa bekor bo'ladi.
> **Yuz rasmi, barmoq izi yoki shunga o'xshash identifikator qo'shilsa —
> o'sha kuni lokalizatsiya va ro'yxatdan o'tish majburiyati paydo bo'ladi.**

---

## 2. Bajarilgan ishlar

### 2.1 Parollar — ZRU-547 27-modda (himoya choralari)

**Muammo:** 66 ta hisob qaydnomasining paroli `data/orgs.json` da **ochiq
matnda** saqlanardi. Uchta API (`/api/orgs`, `/api/assoc/login`,
`/api/assoc/companies`) ularni brauzerga qaytarardi — ya'ni uyushma o'z
a'zolarining parollarini panelda o'qiy olardi. Bu KoAO 46-2 bo'yicha
javobgarlik (fuqaroga 7 BHM, mansabdor shaxsga 50 BHM) va resursga kirishni
cheklash choralari uchun asos.

**Yechim:**

| Fayl | Nima qilindi |
|---|---|
| `srv/passwords.js` (yangi) | scrypt (N=16384, r=8) hashlash, har yozuvga alohida sol; `verify()` — parolni ko'radigan yagona joy |
| `core.js` | `getOrgs()` da avtomatik migratsiya; `findCompany()` endi hashni tekshiradi |
| `server.js` | 20 ta `===` solishtirish `PW.verify()` ga o'tkazildi; 5 ta yozish joyi `PW.set()` ga |
| `srv/api.js`, `srv/buyer.js`, `srv/analytics.js` | qolgan barcha solishtirishlar |
| `srv/register.js` | kutilayotgan arizalar ham hashlanadi (7 tasi migratsiya qilindi) |

**Natija:** 66/66 hisob hashlangan, 0 ta ochiq parol. Barcha eski parollar
ishlashda davom etadi — faqat saqlanish shakli o'zgardi.

**Panellar:** uyushma paneli endi parolni ko'rsatmaydi — o'rniga «Parolni
tiklash» tugmasi bor, yangi parol **faqat bir marta** ko'rsatiladi. Admin
paneldagi parol maydonlari faqat yozish uchun (bo'sh qoldirilsa o'zgarmaydi).

### 2.2 Rozilik — ZRU-547 21 va 22-moddalar

**Muammo:** rozilik belgisi (`#rgConsent`) faqat brauzerda tekshirilardi va
hech qayerda saqlanmasdi. 21-modda bo'yicha rozilik berilganini isbotlash
majburiyati **operator zimmasida** — saqlanmagan belgi hech narsani isbotlamaydi.
Matn esa maqsadlarni, muddatlarni va qaytarib olish huquqini aytmasdi.

**Yechim:**

- Serverda qayta tekshiriladi (`srv/register.js` → `consentGate`) — endpointga
  to'g'ridan-to'g'ri so'rov yuborib chetlab bo'lmaydi.
- Har bir rozilik dalil sifatida yoziladi: **vaqt, hujjat versiyalari,
  qisqartirilgan IP, brauzer**. Barchasi so'rovning o'zidan olinadi, tanadagi
  maydondan emas.
- Rozilik matni endi hujjatlarga havola qiladi, toifalarni sanaydi va qaytarib
  olish huquqini aytadi.

### 2.3 Huquqiy hujjatlar

| Sahifa | Asos |
|---|---|
| `oferta.html` | FK 367, 370-moddalar; ZRU-792 9, 13, 16, 19-moddalar; KM 185-son Qoidalar 24-band |
| `maxfiylik.html` | ZRU-547 (21, 22, 26, 27, 27-1-moddalar) |
| `shartlar.html` | foydalanish qoidalari, moderatsiya va shikoyat tartibi |

Matnlar o'zbek va rus tillarida; o'zbek tili ustunlik qiladi (tarjima bandi
har uchala hujjatda bor).

**Muhim arxitektura qarori:** hujjatlardagi rekvizitlar, ma'lumot toifalari
jadvali, saqlash muddatlari va transchegaraviy uzatishlar **qo'lda yozilmagan**
— ular `/api/legal` orqali `srv/legal.js` dan render qilinadi. Shu sababli
maxfiylik siyosati kod to'plamaydigan maydonni tasvirlay olmaydi va
to'playdiganini tushirib qoldira olmaydi.

### 2.4 Rekvizitlar — ZRU-792, KM 185-son 24-band

Operator rekvizitlari **22 ta sahifaning** futerida ko'rsatiladi
(`legal-footer.js`). Bu talab bitim tuzilgunga qadar amal qilgani uchun —
xaridor mahsulot sahifasiga qidiruvdan tushib, o'sha yerdan sotuvchiga yozishi
mumkin — futer barcha sahifalarda bor yagona joy. `item.html`, `kirish.html`,
`biznes-id.html`, `xizmatlar.html`, `davlat-xizmatlari.html` va
`assistant.html` sahifalariga futer yangidan qo'shildi.

### 2.5 Ommaviy oferta — ro'yxatdan o'tishdan OLDIN

Rozilik belgisi yonidagi havola offertani ko'rsatish emas — u havolani
ko'rsatish. Endi ariza yuborilganda offerta matni **modal oynada ochiladi**
va u qabul qilinmaguncha ariza yuborilmaydi:

- oyna ichida offertaning haqiqiy matni (13 band) va maxfiylik siyosati
  alohida ilova sifatida;
- «Roziman» tugmasi offerta **oxirigacha varaqlanmaguncha faol emas**;
- qabul qilingandan keyingina rozilik belgisi qo'yiladi va forma yuboriladi.

Bu FK 370-moddasi bilan bog'liq: shartnoma arizani yuborish harakati bilan
tuziladi, shuning uchun ariza beruvchiga shartlar oldindan ko'rsatilgani
muhim. Matn `legal-render.js` orqali chiqadi — ya'ni oynada aynan
`oferta.html` dagi matn ko'rsatiladi, uning nusxasi emas.

**Xatolik holatida yopiladi, ochilmaydi.** Agar hujjat matni yuklanmasa,
«Roziman» tugmasi faol bo'lmaydi va ogohlantirish chiqadi — matnni
ko'rmasdan rozilik berish mumkin emas.

### 2.6 Har bir kabinet sozlamalarida

«Ma'lumotlarim va huquqlarim» bo'limi uch kabinetga ham qo'shildi:
kompaniya, xaridor va uyushma. Bo'limda: huquqiy hujjatlar, offertani qayta
o'qish, rozilik yozuvi (qachon va qaysi versiyaga berilgan), ma'lumotni
yuklab olish, o'chirishni talab qilish va rozilikni qaytarib olish.

Yagona modul (`legal-settings.js`) uchala kabinetda ham, alohida
`mening-malumotlarim.html` sahifasida ham ishlatiladi — huquqlar bir
marta amalga oshirilgan, to'rt joyda takrorlanmagan.

### 2.7 Sub'ekt huquqlari — ZRU-547 21, 22-moddalar

Amalga oshirish: `srv/rights.js` (server) va `legal-settings.js` (interfeys).

| Huquq | Qanday ishlaydi |
|---|---|
| Ma'lumot olish | JSON fayl — hisob yozuvi, ariza, rozilik dalili, AI yozishmalari |
| Aniqlashtirish | kabinetdagi profil formasi (mavjud edi) |
| Rozilikni qaytarib olish | **darhol** — hisob to'xtatiladi, chunki qayta ishlash asosi shu rozilik edi |
| O'chirishni talab qilish | **murojaat sifatida qayd etiladi**, 10 ish kuni ichida asoslantirilgan javob |

Admin panelda «Ma'lumot murojaatlari» bo'limi — muddati o'tganlar qizil bilan.
Sababsiz rad etish qabul qilinmaydi (22-modda asoslantirilgan javobni talab
qiladi).

> **Nega o'chirish darhol emas:** bitim va buxgalteriya hujjatlari qonun
> talabiga ko'ra 5 yil saqlanadi, rozilik yozuvi esa qayta ishlash qonuniy
> bo'lganini isbotlovchi yagona dalil. «O'chirish» tugmasi bu ikkalasini ham
> yo'q qilgan bo'lardi. Batafsil: `srv/rights.js` sarlavhasi.

---

## 3. QOLGAN ISHLAR — bularsiz hujjatlar huquqiy kuchga ega emas

### 3.1 🔴 Operator rekvizitlarini to'ldirish

`srv/legal.js` faylidagi `OPERATOR` obyektida hamma narsa hozircha
`[TO'LDIRILSIN: …]` holatida. Saytda ular **oltin ramkali ogohlantirish**
sifatida ko'rinadi va hujjat boshida «rekvizitlar to'ldirilmagan» banneri
chiqadi — ya'ni tasodifan e'lon qilib bo'lmaydi.

Kerak: to'liq yuridik nom, tashkiliy-huquqiy shakl, STIR, davlat
ro'yxatidan o'tkazilganlik raqami va sanasi, pochta manzili, rasmiy e-pochta,
telefon.

Bitta faylni tahrirlaysiz — futer, oferta va maxfiylik siyosati o'zi yangilanadi.

### 3.2 🔴 Mas'ul shaxsni tayinlash

ZRU-547 va Vazirlar Mahkamasining 2023-yil 15-noyabrdagi 3477-son qarori bilan
tasdiqlangan Namunaviy tartib bo'yicha shaxsga doir ma'lumotlarni qayta ishlash
va himoya qilishni ta'minlovchi **tarkibiy bo'linma yoki vakolatli shaxs**
belgilanishi kerak. Buyruq bilan rasmiylashtiriladi.

Uning F.I.Sh. va e-pochtasi `srv/legal.js` → `OPERATOR.dpoName` / `dpoEmail`
maydonlariga yoziladi — maxfiylik siyosatining 13-bandi va futer o'sha yerdan
oladi.

### 3.3 🔴 Admin parolini o'zgartirish

Server har ishga tushganda ogohlantiradi:

```
⚠  ADMIN PASSWORD IS THE DEFAULT — set ADMIN_PASSWORD or create admin.key
```

Admin paroli hozir `admin`. `ADMIN_PASSWORD` muhit o'zgaruvchisini
o'rnating yoki `admin.key` fayl yarating. Bu parol butun platformaga to'liq
kirish beradi — barcha kompaniyalar, arizalar va shaxsga doir ma'lumotlarga.

### 3.4 🟠 `credentials.txt` va `credentials.xlsx` fayllari

Loyiha ildizida hisob ro'yxatlari **ochiq parollar bilan** yotibdi. Ular
`.gitignore` da (git ga tushmagan), lekin diskda. Parollar hashlangan bo'lsa
ham, **bu fayllardagi parollar hali ham ishlaydi** — ular hozirgi hisoblarning
haqiqiy parollari.

Tavsiya: kerak bo'lmasa o'chiring; kerak bo'lsa shifrlangan joyga ko'chiring.
Men o'chirmadim — bu sizning qaroringiz.

### 3.5 🟠 Anthropic bilan qayta ishlash shartlari

Maxfiylik siyosatining 5-bandi AI yordamchisi matni Anthropic (AQSh) ga
uzatilishini va bu ZRU-547 27-1-modda bo'yicha **tasdiqlangan standart
shartlar** asosida amalga oshirilishini aytadi. Bu asosning haqiqatan mavjud
bo'lishi uchun Anthropic bilan tegishli shartnoma (DPA) rasmiylashtirilishi
kerak. Agar boshqa asos tanlansa (masalan, davlat adekvat himoya
ta'minlaydi deb tan olingan ro'yxat), `srv/legal.js` → `TRANSFERS[].ground`
yangilanadi.

### 3.6 🟡 Yurist ko'rigi

Hujjatlar amaldagi qonun matnlari asosida yozilgan, lekin men yurist emasman.
E'lon qilishdan oldin O'zbekiston huquqi bo'yicha mutaxassis ko'rigidan
o'tkazing — ayniqsa oferta (4-band: operatorning axborot vositachisi maqomi)
va 9-band (javobgarlik chegaralari).

---

## 4. Tekshirilgan va talab qilinmasligi aniqlangan

| Talab | Holat |
|---|---|
| Serverlarni O'zbekistonda joylashtirish | Talab qilinmaydi — ZRU-1125 (26.03.2026) |
| Davlat reyestrida ro'yxatdan o'tish | Talab qilinmaydi — lokalizatsiya majburiyati yo'q |
| Biometrik ma'lumotlar uchun maxsus shartlar | Qo'llanilmaydi — bunday ma'lumot to'planmaydi |

---

## 5. Manbalar

- ZRU-547 «Shaxsga doir ma'lumotlar to'g'risida» — <https://lex.uz/docs/4396428>
- ZRU-1125 (26.03.2026) o'zgartirishlar — <https://lex.uz/docs/8104580>
- ZRU-792 «Elektron tijorat to'g'risida» — <https://lex.uz/ru/docs/6213428>
- KM 185-son (02.06.2016) Elektron tijorat Qoidalari — <https://lex.uz/ru/docs/2973942>
- KM 3477-son (15.11.2023) mas'ul bo'linma Namunaviy tartibi — <https://lex.uz/en/docs/6668412>
- KM 71-son (08.02.2020) Davlat reyestri reglamenti — <https://lex.uz/docs/4732190>
- Fuqarolik kodeksi (367, 370-moddalar) — <https://lex.uz/docs/180550>

---

## 6. Hujjat versiyasini o'zgartirish tartibi

Matn mazmunan o'zgarganda `srv/legal.js` → `DOCS[<hujjat>].version` va
`effective` yangilanadi. Rozilik yozuvlari versiyaga bog'langani uchun eski
rozilik qaysi tahrirga berilgani saqlanib qoladi — yangi tahrir o'tmishni
qayta yozmaydi. Ma'lumot toifalari yoki maqsadlari jiddiy o'zgarsa, yangi
rozilik so'ralishi kerak.
