# Tijorat Markazi — Telegram bot

Самодостаточная папка бота: запускается отдельно от сайта.

## Файлы
| Файл | Назначение |
|------|-----------|
| `bot.js` | Сам бот (long-polling Telegram) |
| `core.js` | «Мозг»: Gemini, промпт TIJORAT MARKAZI, голос, документы, история |
| `gemini.key` | Ключ Gemini |
| `telegram.key` | Токен бота от @BotFather |
| `data/` | Создаётся автоматически: история чатов + problems.doc |

## Запуск
```bash
cd "/Users/open/Desktop/Tijorat Markazi/telegram bot"
node bot.js
```

## Возможности
- Текст uz/ru/en (ответ на языке вопроса), только тема TIJORAT MARKAZI
- 🎤 голос, 🖼 фото, 📎 PDF/Word/Excel/PowerPoint/текст
- `/new` — новый чат, `/help` — помощь

## Примечание
`core.js` и `gemini.key` — копии общих файлов с сайтом (чтобы папка была автономной).
Если меняете AI-промпт в `core.js` сайта — обновите и здесь (или попросите синхронизировать).
