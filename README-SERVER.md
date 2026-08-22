# Tijorat Markazi — server (AI + chat archive)

## Ishga tushirish / Запуск

```bash
cd /Users/open/Desktop/Tijorat Markazi

# 1) Demo rejim (AI kalitisiz) — ishlaydi, lekin javoblar namunaviy:
node server.js

# 2) Haqiqiy AI (Gemini) bilan:
GEMINI_API_KEY=YOUR_KEY node server.js
```

Yoki kalitni faylga yozing (xavfsizroq, brauzerda ko'rinmaydi):

```bash
echo "YOUR_GEMINI_KEY" > gemini.key
node server.js
```

Sayt: **http://localhost:4321**

## Nima saqlanadi (data/ papkasi)

| Fayl | Mazmun |
|------|--------|
| `data/chats.json` | Har bir email uchun barcha suhbatlar arxivi |
| `data/problems.json` | Barcha murojaatlar (xom ko'rinishda) |
| `data/problems.doc` | **Word** fayli — barcha foydalanuvchi savollari/muammolari |

- Foydalanuvchi assistant sahifasida **email** kiritadi → o'sha emailga bog'langan eski suhbatlar yon panelda chiqadi.
- Har bir savol avtomatik `problems.doc` (Word) ga yoziladi.
- "Murojaatlarni Word'ga yuklash" tugmasi — joriy foydalanuvchining savollarini Word'da yuklab beradi.

## Model
`GEMINI_MODEL` env bilan o'zgartirsa bo'ladi (default: `gemini-2.0-flash`).

## Telegram bot

Bir xil AI (Gemini, TIJORAT MARKAZI mavzusi, 3 til, ovoz, hujjatlar) Telegram bot sifatida.

1. Telegramda **@BotFather** ga `/newbot` yozing → bot nomi va username bering → **token** oling.
2. Tokenni faylga yozing:
   ```bash
   echo "123456:ABC-yourtoken" > telegram.key
   ```
3. Botni ishga tushiring (web server bilan parallel ishlashi mumkin):
   ```bash
   node bot.js
   ```

Bot imkoniyatlari:
- Matnli savollar (uz/ru/en — savol tilida javob beradi)
- 🎤 ovozli xabar (Gemini transkripsiya qiladi)
- 🖼 rasm (Gemini Vision)
- 📎 hujjat: PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), matnli fayllar
- `/new` — yangi suhbat, `/help` — yordam
- Har bir foydalanuvchi tarixi `data/chats.json` da (`tg:<id>`), savollar `problems.doc` ga yoziladi

## Onlayn uchrashuvlar

**Hozirgi holat:** konferensiya yaratishda havola **qo'lda kiritiladi**
(Zoom / Meet / YouTube — ixtiyoriy platforma). Ishtirokchi "Qo'shilish"ni
bosganda server `/api/conference/join?id=…` orqali o'sha havolaga yo'naltiradi,
shuning uchun havola keyin o'zgartirilsa ham eski sahifadan kirish ishlaydi.

### Google Meet — ixtiyoriy (hozircha yoqilmagan)

Quyidagi qism **tayyor turibdi, lekin ishlatilmayapti**. Google hisobi ulansa,
havola maydonini bo'sh qoldirish kifoya — server o'sha sana/vaqt uchun Meet
xonasini o'zi ochadi. Ulanmagunicha hech narsa o'zgarmaydi.

> Eslatma: Google Meet havolasini faqat Google beradi, u esa OAuth client'ni
> talab qiladi — OAuth client esa albatta bitta Cloud loyihasi ichida yashaydi.
> Loyiha bepul (karta/billing shart emas), lekin usiz avtomatik Meet bo'lmaydi.

### Sozlash — avtomatik (tavsiya etiladi)

```bash
npm install          # bir marta: playwright-core (brauzer yuklab olinmaydi)
npm run setup:google
```

Skript sizning Chrome'ingizni ochadi va Console'ni **odam kabi bosib chiqadi**:
loyiha yaratish → Calendar API yoqish → consent screen → OAuth client →
`google.key` yozish → hisobni ulash. Sizdan faqat **bitta narsa** talab
qilinadi: ochilgan oynada Google'ga kirish (login/parol skriptga berilmaydi).

Agar Console tugmani ko'chirgan bo'lsa, skript to'xtaydi, nima bosish
kerakligini yozadi va Enter bosilgach davom etadi — hech narsa yo'qolmaydi.

```bash
node setup-google.js --project=mavjud-id   # tayyor loyihadan foydalanish
node setup-google.js --connect-only        # google.key bor, faqat hisobni ulash
node setup-google.js --keep-open           # oxirida brauzer yopilmasin
```

### Sozlash — qo'lda

1. [console.cloud.google.com](https://console.cloud.google.com) → yangi loyiha →
   **APIs & Services → Library → "Google Calendar API" → Enable**.
2. **APIs & Services → OAuth consent screen** → External → o'z Google
   pochtangizni *Test user* sifatida qo'shing (Publish qilinmasa ham ishlaydi).
3. **Credentials → Create credentials → OAuth client ID → Web application**.
   *Authorised redirect URIs* ga qo'shing:
   ```
   http://localhost:4321/api/google/callback
   https://localhost:4443/api/google/callback
   ```
   (LAN/domen orqali kirsangiz — o'sha manzilni ham qo'shing; kerakli URI
   Admin panel → Sozlamalar da ko'rsatiladi)
4. Client id va secret'ni saqlang:
   ```bash
   echo '{"client_id":"…","client_secret":"…"}' > google.key
   ```
   yoki `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` env bilan.
5. Serverni qayta ishga tushiring → **Admin panel → Sozlamalar →
   "Google'ga ulanish"** → uchrashuvlar egasi bo'ladigan hisobni tanlang.

### Ishlashi

| | |
|-|-|
| Konferensiya yaratildi (havola bo'sh) | Server Calendar'da event + Meet xonasi yaratadi, havolani saqlaydi |
| Havola qo'lda kiritildi | O'sha havola ishlatiladi, Google chaqirilmaydi |
| Google ulanmagan | Uchrashuv baribir saqlanadi, panelda "Meet yaratish" tugmasi chiqadi |
| Uchrashuv o'chirildi | Calendar'dagi event ham bekor qilinadi |

Sozlamalar: `GOOGLE_TZ` (default `Asia/Tashkent` — `datetime-local` shu mintaqada
o'qiladi), `GOOGLE_MEET_MINUTES` (default `60` — uchrashuv davomiyligi).

Refresh token `data/google-token.json` da saqlanadi (git'ga tushmaydi).

## Eslatma
Serversiz ochilsa (oddiy fayl yoki statik server) — sayt **demo rejimda** ishlaydi: suhbatlar brauzer (localStorage) da saqlanadi, AI o'rniga namunaviy javoblar.
