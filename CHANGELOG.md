# Changelog

All notable changes to PolyLingua AI will be documented in this file.

## [1.0.0] — 2026-08-03

### Added
- User registration & login (phone/email + scrypt password hashing)
- Daily check-in with streak tracking
- Multi-level membership (Free / Pro / Partner)
- Course marketplace with categorized courses
- Course detail with chapter lessons
- Sentence dictation practice with grammar annotations
- Mistake notebook with review
- Word lookup with bilingual dictionary (Chinese + Russian)
- AI-generated word images for visual vocabulary learning
- English TTS pronunciation (Edge TTS + Web Speech fallback)
- AI customer service bot
- Knowledge base articles
- User profile editing (nickname, gender, birthday, city, email)
- Activity tracking & behavior logging
- Railway one-click cloud deployment

### Technical
- Express + better-sqlite3 backend
- Single-page frontend (vanilla JS, no framework)
- Same-origin deployment (no CORS needed)
- SQLite WAL mode for concurrent reads
- Edge TTS en-US-AriaNeural for native American English pronunciation
