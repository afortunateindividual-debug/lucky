# -*- coding: utf-8 -*-
"""PolyLingua AI - Knowledge articles publisher"""
import requests

BASE = "https://lucky-production-e5cc.up.railway.app"
s = requests.Session()

def login():
    r = s.post(f"{BASE}/api/login", json={"phone":"13800008885","password":"123456"})
    d = r.json()
    ok = d.get("ok")
    print(f"[{'OK' if ok else 'FAIL'}] Login")
    return d.get("token") if ok else None

def pub(title, summary, cover, tag, content):
    r = s.post(f"{BASE}/api/admin/knowledge", json={
        "title": title, "summary": summary, "cover": cover, "tag": tag, "content": content
    })
    d = r.json()
    ok = d.get("ok")
    print(f"[{'OK' if ok else 'FAIL'}] {title}")

if __name__ == "__main__":
    token = login()
    if not token:
        exit(1)

    articles = [
        (
            "English Immersion: The Golden Rule",
            "How to immerse yourself in English for maximum learning effectiveness.",
            "\U0001f30a",
            "Methods",
            "# Immersive Learning\n\nImmersion means surrounding yourself with the target language through massive listening, speaking, reading, and writing input.\n\n## Core Principles\n\n1. **Comprehensible input**: Choose materials at your level (80%+ understanding)\n2. **High frequency**: At least 30 minutes of input daily\n3. **Multi-modal**: Audio + video + text at the same time\n4. **Active output**: Shadowing, retelling, writing practice\n\n## Daily Plan\n\n- Morning: 15 min English podcast\n- Noon: 10 min TED-Ed video\n- Evening: Write 3 sentences in English\n- Weekly: Read one short article and take notes"
        ),
        (
            "Russian Alphabet: Your First Step",
            "Start your Russian learning journey with the Cyrillic alphabet.",
            "\U0001f1f7\U0001f1fa",
            "Russian",
            "# The Cyrillic Alphabet\n\nRussian uses 33 Cyrillic letters, divided into vowels and consonants.\n\n## Letters Similar to English\n\n- **A a** = [a] as in father\n- **K k** = [k] as in king\n- **M m** = [m] as in mother\n- **T t** = [t] as in table\n\n## Key Vowels\n\n- **E e** = [ye] as in yes\n- **O o** = [o] as in more\n- **Y y** = [oo] as in boot\n\n## Study Tip\n\nLearn 3-5 letters per day with writing practice. Master all letters in one week."
        ),
        (
            "Spaced Repetition: The Science of Memory",
            "Use spaced repetition to memorize vocabulary efficiently.",
            "\U0001f9e0",
            "Vocabulary",
            "# Spaced Repetition\n\nBased on the Ebbinghaus forgetting curve, memory decays quickly at first, then slows down.\n\n## Optimal Review Intervals\n\n1. First review: After 15-20 minutes\n2. Second review: After 1 day\n3. Third review: After 3 days\n4. Fourth review: After 7 days\n5. Fifth review: After 30 days\n\n## How to Practice\n\n- Use flashcards for new words\n- Move correct cards to Mastered pile, wrong to Review pile\n- Spend 10 minutes daily on review cards\n- Always learn words with example sentences"
        ),
        (
            "The Bilingual Advantage",
            "Why learning both Chinese and English gives you a unique edge.",
            "\U0001f1e8\U0001f1f3",
            "Bilingual",
            "# The Bilingual Advantage\n\n## Cognitive Benefits\n\nBilinguals show stronger executive function:\n- Better attention control: can filter irrelevant info\n- Greater cognitive flexibility: switch between tasks easily\n- Delayed cognitive decline: 4-5 years later onset of dementia\n\n## Cultural Benefits\n\n- Access to two major world knowledge systems\n- Understand different thinking patterns\n- Competitive edge in global careers\n\n## Tips\n\n- Think in the target language, do not translate\n- Alternate between Chinese and English practice\n- Read parallel texts for comparison"
        ),
        (
            "English Pronunciation: Linking & Reduction",
            "Master connected speech for natural-sounding English.",
            "\U0001f3b5",
            "Pronunciation",
            "# Linking and Reduction\n\n## Linking\n\nNative speakers connect words together:\n- Consonant + Vowel: an apple sounds like 'a napple'\n- Vowel + Vowel: go on sounds like 'gowon'\n- Same consonant: good day sounds like 'gooday'\n\n## Reduction\n\nFunction words are often reduced:\n- and becomes 'n (rock 'n' roll)\n- to becomes te (going te school)\n- for becomes fer (wait fer me)\n\n## Practice\n\n1. Shadow native speaker recordings\n2. Record yourself and compare with the original\n3. Focus on rhythm, not just individual sounds"
        ),
    ]

    for title, summary, cover, tag, content in articles:
        pub(title, summary, cover, tag, content)

    print(f"\nDone: {len(articles)} articles published")
