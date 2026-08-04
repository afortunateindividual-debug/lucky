# -*- coding: utf-8 -*-
"""PolyLingua AI - Data rebuild script (knowledge + words + images)"""
import requests
import urllib3
import os
import json

urllib3.disable_warnings()
BASE = "https://lucky-production-e5cc.up.railway.app"
s = requests.Session()
s.verify = False

def login():
    r = s.post(f"{BASE}/api/login", json={"account":"13800008885","pwd":"123456"})
    d = r.json()
    ok = "token" in d
    if ok:
        s.headers["Authorization"] = f"Bearer {d['token']}"
    print(f"[{'OK' if ok else 'FAIL'}] Login: token={'***' if ok else 'N/A'}")
    return d.get("token") if ok else None

# ==================== PART 1: Knowledge Articles ====================
def publish_knowledge():
    print("\n=== Publishing Knowledge Articles ===")
    articles = [
        ("English Immersion: The Golden Rule",
         "How to immerse yourself in English for maximum learning effectiveness.",
         "🌊", "Methods",
         "# Immersive Learning\n\nImmersion means surrounding yourself with the target language through massive listening, speaking, reading, and writing input.\n\n## Core Principles\n1. Comprehensible input: Choose materials at your level\n2. High frequency: At least 30 minutes of input daily\n3. Multi-modal: Audio + video + text at the same time\n4. Active output: Shadowing, retelling, writing practice"),
        ("Russian Alphabet: Your First Step",
         "Start your Russian learning journey with the Cyrillic alphabet.",
         "🇷🇺", "Russian",
         "# The Cyrillic Alphabet\n\nRussian uses 33 Cyrillic letters divided into vowels and consonants.\n\n## Letters Similar to English\n- A = [a] as in father\n- K = [k] as in king\n- M = [m] as in mother\n- T = [t] as in table\n\n## Key Vowels\n- E = [ye] as in yes\n- O = [o] as in more\n- Y = [oo] as in boot"),
        ("Spaced Repetition: The Science of Memory",
         "Use spaced repetition to memorize vocabulary efficiently.",
         "🧠", "Vocabulary",
         "# Spaced Repetition\n\nBased on the Ebbinghaus forgetting curve, memory decays quickly at first, then slows down.\n\n## Optimal Review Intervals\n1. After 15-20 minutes\n2. After 1 day\n3. After 3 days\n4. After 7 days\n5. After 30 days\n\n## How to Practice\n- Use flashcards for new words\n- Spend 10 minutes daily on review cards\n- Always learn words with example sentences"),
        ("The Bilingual Advantage",
         "Why learning both Chinese and English gives you a unique edge.",
         "🀄", "Bilingual",
         "# The Bilingual Advantage\n\n## Cognitive Benefits\n- Better attention control\n- Greater cognitive flexibility\n- Delayed cognitive decline (4-5 years)\n\n## Cultural Benefits\n- Access to two major world knowledge systems\n- Understand different thinking patterns\n- Competitive edge in global careers"),
        ("English Pronunciation: Linking & Reduction",
         "Master connected speech for natural-sounding English.",
         "🎵", "Pronunciation",
         "# Linking and Reduction\n\n## Linking\n- Consonant+Vowel: an apple => a napple\n- Vowel+Vowel: go on => gowon\n- Same consonant: good day => gooday\n\n## Reduction\n- and => n (rock n roll)\n- to => te (going te school)\n- for => fer (wait fer me)"),
    ]
    for title, summary, cover, tag, content in articles:
        r = s.post(f"{BASE}/api/admin/knowledge", json={
            "title":title,"summary":summary,"cover":cover,"tag":tag,"content":content})
        d = r.json()
        ok = d.get("ok")
        print(f"[{'OK' if ok else 'FAIL'}] {title}" + (f": {d}" if not ok else ""))
    print(f"Published {len(articles)} articles")

# ==================== PART 2: Import Words ====================
# Russian dictionary: word -> ru_meaning
RU = {
    # Animals
    "dog": "собака", "cat": "кошка", "bird": "птица", "fish": "рыба",
    "horse": "лошадь", "cow": "корова", "pig": "свинья", "sheep": "овца",
    "goat": "коза", "duck": "утка", "chicken": "курица", "bear": "медведь",
    "lion": "лев", "tiger": "тигр", "elephant": "слон", "monkey": "обезьяна",
    "rabbit": "кролик", "fox": "лиса", "wolf": "волк", "deer": "олень",
    "frog": "лягушка", "snake": "змея", "mouse": "мышь", "ant": "муравей",
    "spider": "паук", "butterfly": "бабочка", "parrot": "попугай", "swan": "лебедь",
    # Food
    "apple": "яблоко", "banana": "банан", "orange": "апельсин",
    "grape": "виноград", "watermelon": "арбуз", "strawberry": "клубника",
    "cherry": "вишня", "peach": "персик", "lemon": "лимон", "mango": "манго",
    "bread": "хлеб", "rice": "рис", "noodle": "лапша", "egg": "яйцо",
    "milk": "молоко", "cheese": "сыр", "meat": "мясо", "chicken_food": "курица",
    "beef": "говядина", "pork": "свинина", "cake": "торт", "cookie": "печенье",
    "candy": "конфета", "chocolate": "шоколад", "ice_cream": "мороженое",
    "honey": "мёд", "jam": "варенье", "sugar": "сахар", "salt": "соль",
    "soup": "суп", "salad": "салат", "sandwich": "бутерброд", "pizza": "пицца",
    "juice": "сок", "tea": "чай", "coffee": "кофе", "water": "вода",
    # Objects
    "book": "книга", "pen": "ручка", "pencil": "карандаш", "desk": "письменный стол",
    "chair": "стул", "table": "стол", "bed": "кровать", "door": "дверь",
    "window": "окно", "wall": "стена", "floor": "пол", "roof": "к��ыша",
    "bag": "сумка", "box": "коробка", "cup": "чашка", "plate": "тарелка",
    "bowl": "миска", "bottle": "бутылка", "phone": "телефон", "computer": "компьютер",
    "watch": "часы", "key": "ключ", "mirror": "зеркало", "lamp": "лампа",
    "clock": "часы", "camera": "камера", "umbrella": "зонтик", "hat": "шляпа",
    "shoe": "туфля", "sock": "носок", "coat": "пальто", "dress": "платье",
    "shirt": "рубашка", "pants": "штаны", "bicycle": "велосипед",
    "airplane": "самолёт", "car": "машина", "bus": "автобус", "train": "поезд",
    "boat": "лодка", "ball": "мяч", "doll": "кукла", "robot": "робот",
    "flower": "цветок", "tree": "дерево", "leaf": "лист", "grass": "трава",
    "sun": "солнце", "moon": "луна", "star": "звезда", "cloud": "облако",
    "rain": "дождь", "snow": "снег", "wind": "ветер", "mountain": "гора",
    "river": "река", "ocean": "океан", "island": "остров", "rock": "камень",
    # People/body
    "eye": "глаз", "ear": "ухо", "nose": "нос", "mouth": "рот",
    "hand": "рука", "foot": "нога", "head": "голова", "face": "лицо",
    "hair": "волосы", "arm": "рука", "leg": "нога", "finger": "палец",
    "boy": "мальчик", "girl": "девочка", "man": "мужчина", "woman": "женщина",
    "baby": "младенец", "friend": "друг", "family": "семья",
    "mother": "мама", "father": "папа", "brother": "брат", "sister": "сестра",
    "teacher": "учитель", "doctor": "врач", "nurse": "медсестра", "student": "студент",
    # Colors
    "red": "красный", "blue": "синий", "green": "зелёный", "yellow": "жёлтый",
    "white": "белый", "black": "чёрный", "pink": "розовый", "purple": "фиолетовый",
    "orange_color": "оранжевый", "brown": "коричневый", "gray": "серый", "gold": "золотой",
    # Verbs
    "run": "бегать", "walk": "ходить", "jump": "прыгать", "swim": "плавать",
    "fly": "летать", "eat": "есть", "drink": "пить", "sleep": "спать",
    "write": "писать", "read": "читать", "draw": "рисовать", "sing": "петь",
    "dance": "танцевать", "play": "играть", "work": "работать", "study": "учиться",
    "cook": "готовить", "clean": "убирать", "wash": "мыть", "open": "открывать",
    "close": "закрывать", "buy": "покупать", "sell": "продавать",
    # Adjectives
    "big": "большой", "small": "маленький", "tall": "высокий", "short": "короткий",
    "long": "длинный", "fast": "быстрый", "slow": "медленный", "hot": "горячий",
    "cold": "холодный", "warm": "тёплый", "happy": "счастливый", "sad": "грустный",
    "angry": "злой", "brave": "храбрый", "kind": "добрый", "strong": "сильный",
    "weak": "слабый", "hungry": "голодный", "thirsty": "жаждущий", "tired": "уставший",
    "beautiful": "красивый", "ugly": "уродливый", "rich": "богатый", "poor": "бедный",
    "old": "старый", "young": "молодой", "new": "новый",
    # Nature/additional
    "sky": "небо", "sea": "море", "lake": "озеро", "forest": "лес",
    "garden": "сад", "park": "парк", "bridge": "мост", "road": "дорога",
    "street": "улица", "city": "город", "village": "деревня", "country": "страна",
    "world": "мир", "fire": "огонь", "paper": "бумага", "music": "музыка",
    "movie": "фильм", "game": "игра",     "story": "история", "dream": "мечта",
    "zoo": "зоопарк", "sunflower": "подсолнух", "island": "остров",
    "otter": "выдра", "whistle": "свисток", "xylophone": "ксилофон",
    "zipper": "молния", "volleyball": "волейбол", "war": "война",
    "weed": "сорняк", "mushroom": "гриб", "lollipop": "леденец",
    "coin": "монета", "bowl": "миска", "king": "король",
}

# Word definitions: list of (word, phonetic, meaning, category, example1, example2)
WORDS = [
    # ---- NOUNS (animals) ----
    ("dog", "/dɔːɡ/", "狗", "名词",
     "The dog is playing in the park.", "My dog loves to chase balls."),
    ("cat", "/kæt/", "猫", "名词",
     "The cat is sleeping on the sofa.", "She has a cute orange cat."),
    ("bird", "/bɜːrd/", "鸟", "名词",
     "A bird is singing in the tree.", "We saw a colorful bird at the zoo."),
    ("fish", "/fɪʃ/", "鱼", "名词",
     "I caught a big fish in the river.", "Fish swim very fast in the water."),
    ("horse", "/hɔːrs/", "马", "名词",
     "She loves to ride her horse every morning.", "The horse ran across the field."),
    ("cow", "/kaʊ/", "牛", "名词",
     "The cow is eating grass in the field.", "We get milk from cows every day."),
    ("pig", "/pɪɡ/", "猪", "名词",
     "The pig is rolling in the mud.", "Farmers raise pigs for meat."),
    ("sheep", "/ʃiːp/", "羊", "名词",
     "The sheep are grazing on the hill.", "Sheep provide wool for making clothes."),
    ("goat", "/ɡoʊt/", "山羊", "名词",
     "The goat climbed up the rocky mountain.", "Goats can eat almost anything."),
    ("duck", "/dʌk/", "鸭子", "名词",
     "The duck is swimming in the pond.", "A mother duck leads her ducklings to water."),
    ("chicken", "/ˈtʃɪkɪn/", "鸡", "名词",
     "The chicken laid three eggs today.", "We have six chickens on our farm."),
    ("bear", "/ber/", "熊", "名词",
     "A brown bear was spotted in the forest.", "Bears hibernate during the winter."),
    ("lion", "/ˈlaɪən/", "狮子", "名词",
     "The lion is the king of the jungle.", "A lion can run very fast to catch prey."),
    ("tiger", "/ˈtaɪɡər/", "老虎", "名词",
     "A tiger has orange and black stripes.", "Tigers live alone in the wild."),
    ("elephant", "/ˈelɪfənt/", "大象", "名词",
     "The elephant is the largest land animal.", "Elephants use their trunks to drink water."),
    ("monkey", "/ˈmʌŋki/", "猴子", "名词",
     "The monkey is swinging from tree to tree.", "Monkeys love to eat bananas."),
    ("rabbit", "/ˈræbɪt/", "兔子", "名词",
     "The rabbit has long ears and a fluffy tail.", "Rabbits dig holes in the ground."),
    ("fox", "/fɑːks/", "狐狸", "名词",
     "The fox is a very clever animal.", "A red fox ran across the snowy field."),
    ("wolf", "/wʊlf/", "狼", "名词",
     "A wolf howled at the full moon.", "Wolves hunt together in packs."),
    ("deer", "/dɪr/", "鹿", "名词",
     "A deer was drinking water by the lake.", "Deer can run very fast to escape danger."),
    ("frog", "/frɔːɡ/", "青蛙", "名词",
     "A frog jumped into the pond.", "Frogs catch insects with their long tongues."),
    ("snake", "/sneɪk/", "蛇", "名词",
     "A snake slithered through the grass.", "Some snakes are poisonous and dangerous."),
    ("mouse", "/maʊs/", "老鼠", "名词",
     "A little mouse ran across the kitchen floor.", "Mice like to eat cheese and bread."),
    ("ant", "/ænt/", "蚂蚁", "名词",
     "An ant is carrying a piece of bread.", "Ants work together in large colonies."),
    ("spider", "/ˈspaɪdər/", "蜘蛛", "名词",
     "A spider is spinning a beautiful web.", "Most spiders are not dangerous to humans."),
    ("butterfly", "/ˈbʌtərflaɪ/", "蝴蝶", "名词",
     "A beautiful butterfly landed on the flower.", "Butterflies have colorful wings."),
    ("parrot", "/ˈpærət/", "鹦鹉", "名词",
     "The parrot can repeat what people say.", "A colorful parrot sat on the branch."),
    ("swan", "/swɑːn/", "天鹅", "名词",
     "A beautiful white swan swam on the lake.", "Swans are known for their graceful movements."),
]

# Add food nouns
FOOD_NOUNS = [
    ("apple", "/ˈæpəl/", "苹果", "名词",
     "I eat an apple every day for breakfast.", "The apple is red and very sweet."),
    ("banana", "/bəˈnænə/", "香蕉", "名词",
     "Monkeys love to eat bananas.", "A banana is a great source of energy."),
    ("orange", "/ˈɔːrɪndʒ/", "橘子", "名词",
     "She squeezed fresh orange juice this morning.", "The orange is round and full of vitamin C."),
    ("grape", "/ɡreɪp/", "葡萄", "名词",
     "We picked fresh grapes from the vineyard.", "Grapes can be made into wine or juice."),
    ("watermelon", "/ˈwɔːtərmelən/", "西瓜", "名词",
     "We ate a big watermelon at the summer picnic.", "Watermelon is very refreshing on a hot day."),
    ("strawberry", "/ˈstrɔːberi/", "草莓", "名词",
     "She picked strawberries from the garden.", "Strawberries are red, sweet, and delicious."),
    ("cherry", "/ˈtʃeri/", "樱桃", "名词",
     "Cherry blossoms bloom in spring.", "I love the sweet taste of fresh cherries."),
    ("peach", "/piːtʃ/", "桃子", "名词",
     "The peach is soft, sweet, and juicy.", "Peaches grow best in warm climates."),
    ("lemon", "/ˈlemən/", "柠檬", "名词",
     "She added lemon to her tea for more flavor.", "Lemons have a very sour taste."),
    ("mango", "/ˈmæŋɡoʊ/", "芒果", "名词",
     "Mango is my favorite tropical fruit.", "The ripe mango is golden yellow inside."),
    ("bread", "/bred/", "面包", "名词",
     "I bought fresh bread from the bakery.", "She made a sandwich with whole wheat bread."),
    ("rice", "/raɪs/", "米饭", "名词",
     "We eat rice almost every day.", "Rice is a staple food in many countries."),
    ("egg", "/eɡ/", "鸡蛋", "名词",
     "I had two boiled eggs for breakfast.", "The hen laid a fresh egg this morning."),
    ("milk", "/mɪlk/", "牛奶", "名词",
     "Children should drink milk every day.", "I like to drink a glass of warm milk."),
    ("cheese", "/tʃiːz/", "奶酪", "名词",
     "This pizza has extra cheese on top.", "Mice like to nibble on cheese."),
    ("cake", "/keɪk/", "蛋糕", "名词",
     "She baked a chocolate cake for the party.", "The birthday cake had ten candles on it."),
    ("cookie", "/ˈkʊki/", "饼干", "名词",
     "The kids ate all the chocolate cookies.", "Can I have another cookie, please?"),
    ("honey", "/ˈhʌni/", "蜂蜜", "名词",
     "Bees make honey from flower nectar.", "I like to put honey in my tea."),
    ("sugar", "/ˈʃʊɡər/", "糖", "名词",
     "Please add some sugar to the coffee.", "Too much sugar is not good for your health."),
    ("salt", "/sɔːlt/", "盐", "名词",
     "Please pass me the salt for the soup.", "The ocean water tastes very salty."),
    ("soup", "/suːp/", "汤", "名词",
     "My grandmother makes delicious chicken soup.", "The hot soup warmed us on a cold day."),
    ("salad", "/ˈsæləd/", "沙拉", "名词",
     "I ordered a fresh salad for lunch.", "She made a colorful salad with vegetables."),
    ("pizza", "/ˈpiːtsə/", "披萨", "名词",
     "We ordered pizza for dinner last night.", "My favorite pizza has pepperoni and mushrooms."),
    ("juice", "/dʒuːs/", "果汁", "名词",
     "Would you like some orange juice?", "Fresh juice is healthier than soda."),
    ("tea", "/tiː/", "茶", "名词",
     "She drinks green tea every afternoon.", "Would you like a cup of tea with honey?"),
    ("coffee", "/ˈkɔːfi/", "咖啡", "名词",
     "I need a cup of coffee to wake up.", "The coffee shop opens at 7 in the morning."),
    ("water", "/ˈwɔːtər/", "水", "名词",
     "Please drink more water every day.", "The clean water in the river sparkled in sunlight."),
]

# Object nouns
OBJECT_NOUNS = [
    ("book", "/bʊk/", "书", "名词",
     "I am reading a very interesting book.", "She borrowed a book from the library."),
    ("pen", "/pen/", "笔", "名词",
     "Can I borrow your pen for a moment?", "She wrote the letter with a blue pen."),
    ("pencil", "/ˈpensəl/", "铅笔", "名词",
     "He sharpened his pencil before the exam.", "Children learn to write with pencils."),
    ("desk", "/desk/", "书桌", "名词",
     "She sat at her desk to do homework.", "The teacher stood behind her desk."),
    ("chair", "/tʃer/", "椅子", "名词",
     "Please pull up a chair and sit down.", "The wooden chair was very comfortable."),
    ("table", "/ˈteɪbəl/", "桌子", "名词",
     "We placed the food on the table.", "The big table can seat eight people."),
    ("bed", "/bed/", "床", "名词",
     "It is time to go to bed now.", "She made her bed every morning."),
    ("door", "/dɔːr/", "门", "名词",
     "Please close the door when you leave.", "Someone is knocking at the front door."),
    ("window", "/ˈwɪndoʊ/", "窗户", "名词",
     "She opened the window to let in fresh air.", "The sun shines through the window every morning."),
    ("bag", "/bæɡ/", "包", "名词",
     "She put her books in her school bag.", "He carried a heavy bag up the stairs."),
    ("cup", "/kʌp/", "杯子", "名词",
     "She drank a cup of hot chocolate.", "Please wash the cup after you finish."),
    ("plate", "/pleɪt/", "盘���", "名词",
     "She put the sandwich on a plate.", "The dinner plates were very colorful."),
    ("bottle", "/ˈbɑːtəl/", "瓶子", "名词",
     "He opened a bottle of cold water.", "Please recycle the empty plastic bottle."),
    ("phone", "/foʊn/", "手机", "名词",
     "She checked her phone for new messages.", "My phone battery is almost dead."),
    ("clock", "/klɑːk/", "钟", "名词",
     "The clock on the wall shows 3 o'clock.", "I set my alarm clock for 7 in the morning."),
    ("umbrella", "/ʌmˈbrelə/", "雨伞", "名词",
     "Take an umbrella because it might rain.", "She opened her blue umbrella in the rain."),
    ("hat", "/hæt/", "帽子", "名词",
     "He wore a hat to protect himself from the sun.", "She bought a new winter hat."),
    ("shoe", "/ʃuː/", "鞋子", "名词",
     "He tied his shoes before going out.", "She bought a new pair of running shoes."),
    ("coat", "/koʊt/", "外套", "名词",
     "Wear a warm coat because it is cold outside.", "She hung her coat in the closet."),
    ("dress", "/dres/", "连衣裙", "名词",
     "She wore a beautiful red dress to the party.", "The little girl twirled in her new dress."),
    ("bicycle", "/ˈbaɪsɪkəl/", "自行车", "名词",
     "He rides his bicycle to school every day.", "My bicycle has a flat tire and needs repair."),
    ("ball", "/bɔːl/", "球", "名词",
     "The kids are playing ball in the park.", "He threw the ball to his dog."),
    ("flower", "/ˈflaʊər/", "花", "名词",
     "The garden is full of colorful flowers.", "She gave her mother a flower on Mother's Day."),
    ("tree", "/triː/", "树", "名词",
     "The big tree provides shade in summer.", "Birds build their nests in tall trees."),
    ("star", "/stɑːr/", "星星", "名词",
     "We can see many stars in the night sky.", "The North Star helps travelers find direction."),
    ("sun", "/sʌn/", "太阳", "名词",
     "The sun rises in the east every morning.", "Don't look directly at the sun."),
    ("moon", "/muːn/", "月亮", "名词",
     "The full moon was bright and beautiful.", "We watched the moon rise over the mountains."),
    ("river", "/ˈrɪvər/", "河流", "名词",
     "The river flows through the city center.", "We went fishing by the river last weekend."),
]

# Verbs
VERBS = [
    ("run", "/rʌn/", "跑步", "动词",
     "He can run very fast.", "I run for 30 minutes every morning."),
    ("walk", "/wɔːk/", "走路", "动词",
     "We walk to school together every day.", "She likes to walk in the park after dinner."),
    ("jump", "/dʒʌmp/", "跳", "动词",
     "The children jump with joy in the playground.", "Can you jump over this small puddle?"),
    ("swim", "/swɪm/", "游泳", "动词",
     "She can swim across the entire pool.", "We swim in the lake every summer."),
    ("fly", "/flaɪ/", "飞", "动词",
     "Birds fly high in the sky.", "The airplane will fly to New York tomorrow."),
    ("eat", "/iːt/", "吃", "动词",
     "We eat lunch at 12 o'clock.", "She likes to eat fresh vegetables."),
    ("drink", "/drɪŋk/", "喝", "动词",
     "Please drink a glass of water.", "He drinks coffee every morning."),
    ("sleep", "/sliːp/", "睡觉", "动词",
     "I sleep for eight hours every night.", "The baby is sleeping peacefully."),
    ("write", "/raɪt/", "写", "动词",
     "She writes in her journal every evening.", "Please write your name on the paper."),
    ("read", "/riːd/", "读", "动词",
     "He reads a new book every week.", "I like to read stories before bed."),
    ("draw", "/drɔː/", "画", "动词",
     "She can draw beautiful pictures.", "The children draw with colored pencils."),
    ("sing", "/sɪŋ/", "唱", "动词",
     "She loves to sing in the shower.", "The birds sing early in the morning."),
    ("dance", "/dæns/", "跳舞", "动词",
     "They dance together at the party.", "She has learned to dance since she was five."),
    ("play", "/pleɪ/", "玩", "动词",
     "The children play in the garden after school.", "He plays the piano very well."),
    ("cook", "/kʊk/", "烹饪", "动词",
     "My mother cooks delicious meals every day.", "I want to learn how to cook Chinese food."),
    ("clean", "/kliːn/", "打扫", "动词",
     "We clean the house every Saturday.", "Please clean your room before going out."),
    ("open", "/ˈoʊpən/", "打开", "动词",
     "Can you open the window please?", "The shop opens at 9 in the morning."),
    ("close", "/kloʊz/", "关闭", "动词",
     "Please close the door quietly.", "The library closes at 6 p.m."),
    ("buy", "/baɪ/", "买", "动词",
     "I need to buy some groceries today.", "She bought a new dress for the party."),
    ("study", "/ˈstʌdi/", "学习", "动词",
     "I study English online every day.", "She studies very hard for the exam."),
]

# Adjectives
ADJECTIVES = [
    ("big", "/bɪɡ/", "大的", "形容词",
     "That is a very big elephant.", "We live in a big house near the park."),
    ("small", "/smɔːl/", "小的", "形容词",
     "The kitten is very small and cute.", "She wrote in a small notebook."),
    ("tall", "/tɔːl/", "高的", "形容词",
     "He is the tallest boy in our class.", "The tall building has 50 floors."),
    ("short", "/ʃɔːrt/", "短的", "形容词",
     "She has short brown hair.", "The movie was very short but interesting."),
    ("long", "/lɔːŋ/", "长的", "形容词",
     "She has long beautiful hair.", "It was a long journey to the mountains."),
    ("fast", "/fæst/", "快的", "形容词",
     "The cheetah is the fastest animal on land.", "This train is very fast and comfortable."),
    ("slow", "/sloʊ/", "慢的", "形容词",
     "The turtle is very slow but steady.", "Please speak more slowly so I can understand."),
    ("hot", "/hɑːt/", "热的", "形容词",
     "The soup is too hot to eat right now.", "It gets very hot in summer here."),
    ("cold", "/koʊld/", "冷的", "形容词",
     "The water in the lake is very cold.", "You should wear a coat on cold days."),
    ("happy", "/ˈhæpi/", "快乐的", "形容词",
     "She is very happy with her new job.", "The children look so happy playing together."),
    ("sad", "/sæd/", "难过的", "形容词",
     "He felt sad when his friend moved away.", "The sad movie made everyone cry."),
    ("angry", "/ˈæŋɡri/", "生气的", "形容词",
     "Don't be angry about such small things.", "She was angry when she lost her keys."),
    ("brave", "/breɪv/", "勇敢的", "形容词",
     "The brave firefighter saved the family.", "You were very brave to speak in public."),
    ("kind", "/kaɪnd/", "善良的", "形容词",
     "She is a very kind and helpful person.", "It was kind of you to help the old lady."),
    ("strong", "/strɔːŋ/", "强壮的", "形容词",
     "He is strong enough to lift the big box.", "A strong wind blew the leaves off the tree."),
    ("beautiful", "/ˈbjuːtɪfəl/", "美丽的", "形容词",
     "The sunset was absolutely beautiful.", "She bought a beautiful painting at the market."),
    ("old", "/oʊld/", "老的", "形容词",
     "The old castle is 500 years old.", "My grandmother tells wonderful old stories."),
    ("young", "/jʌŋ/", "年轻的", "形容词",
     "She is still young and full of energy.", "The young trees need water every day."),
    ("new", "/nuː/", "新的", "形容词",
     "I got a new phone for my birthday.", "She moved to a new city last month."),
    ("hungry", "/ˈhʌŋɡri/", "饥饿的", "形容词",
     "I am very hungry after the long walk.", "The hungry cat meowed for food."),
    ("tired", "/ˈtaɪərd/", "疲惫的", "形容词",
     "She was tired after working all day.", "If you feel tired, take a short break."),
    ("red", "/red/", "红色的", "形容词",
     "She wore a bright red dress.", "The red rose is a symbol of love."),
    ("blue", "/bluː/", "蓝色的", "形容词",
     "The sky is clear and blue today.", "He painted the wall a beautiful blue."),
    ("green", "/ɡriːn/", "绿色的", "形容词",
     "The grass is very green after the rain.", "She bought a green bag at the store."),
]

# Nature / Other
OTHER_WORDS = [
    ("sky", "/skaɪ/", "天空", "名词",
     "The sky is full of stars tonight.", "Birds fly high across the blue sky."),
    ("sea", "/siː/", "海", "名词",
     "We spent the day swimming in the sea.", "The sea was calm and peaceful at sunset."),
    ("garden", "/ˈɡɑːrdən/", "花园", "名词",
     "She grows beautiful flowers in her garden.", "We had tea in the garden this afternoon."),
    ("bridge", "/brɪdʒ/", "桥", "名词",
     "We walked across the old stone bridge.", "The bridge connects the two sides of the river."),
    ("road", "/roʊd/", "路", "名词",
     "The road to the village is very narrow.", "Be careful when you cross the busy road."),
    ("city", "/ˈsɪti/", "城市", "名词",
     "New York is a very big city.", "She moved from a small town to the city."),
    ("music", "/ˈmjuːzɪk/", "音乐", "名词",
     "She listens to music while studying.", "Classical music helps me relax and focus."),
    ("game", "/ɡeɪm/", "游戏", "名词",
     "The children are playing a video game.", "This board game is fun for the whole family."),
    ("story", "/ˈstɔːri/", "故事", "名词",
     "Grandma told us an interesting story.", "This story has a very happy ending."),
    ("dream", "/driːm/", "梦想", "名词",
     "She had a strange dream last night.", "Never give up on your dreams."),
    ("boy", "/bɔɪ/", "男孩", "名词",
     "The little boy is playing with his toys.", "A boy and a girl are walking to school."),
    ("girl", "/ɡɜːrl/", "女孩", "名词",
     "The girl is reading a book under the tree.", "She is a very smart and friendly girl."),
    ("friend", "/frend/", "朋友", "名词",
     "My best friend lives next door.", "A true friend will always help you."),
    ("family", "/ˈfæmɪli/", "家庭", "名词",
     "We have dinner together as a family every night.", "Family is the most important thing in life."),
    ("teacher", "/ˈtiːtʃər/", "老师", "名词",
     "Our English teacher is very patient and kind.", "The teacher explained the lesson very clearly."),
    ("doctor", "/ˈdɑːktər/", "医生", "名词",
     "You should see a doctor if you feel sick.", "The doctor checked my temperature and pulse."),
    ("fire", "/ˈfaɪər/", "火", "名词",
     "We sat around the fire and told stories.", "Fire can be very dangerous if not careful."),
    ("paper", "/ˈpeɪpər/", "纸", "名词",
     "She wrote a note on a piece of paper.", "Please recycle paper to save trees."),
    ("eye", "/aɪ/", "眼睛", "名词",
     "She has beautiful blue eyes.", "He closed his eyes and took a deep breath."),
    ("hand", "/hænd/", "手", "名词",
     "She held the baby's hand gently.", "Please wash your hands before eating."),
    ("mountain", "/ˈmaʊntən/", "山", "名词",
     "We climbed to the top of the mountain.", "The mountain is covered with snow in winter."),
    ("rain", "/reɪn/", "雨", "名词",
     "It looks like it will rain this afternoon.", "The rain made the flowers grow faster."),
    ("snow", "/snoʊ/", "雪", "名词",
     "Children love to play in the snow.", "The snow fell softly all night long."),
    ("car", "/kɑːr/", "汽车", "名词",
     "She drives her car to work every day.", "My father bought a new red car."),
    ("robot", "/ˈroʊbɑːt/", "机器人", "名词",
     "The robot can speak three languages.", "Children were excited to see the robot dance."),
    ("doll", "/dɑːl/", "娃娃", "名词",
     "The little girl hugged her favorite doll.", "She has a collection of dolls from around the world."),
    ("king", "/kɪŋ/", "国王", "名词",
     "The king ruled the country wisely.", "In the story, the brave knight saved the king."),
    ("lollipop", "/ˈlɑːlipɑːp/", "棒棒糖", "名词",
     "The child happily licked her lollipop.", "I bought a big rainbow lollipop at the store."),
    ("coin", "/kɔɪn/", "硬币", "名词",
     "She found a gold coin on the street.", "He saved every coin in his piggy bank."),
    ("zoo", "/zuː/", "动物园", "名词",
     "We took the children to the zoo yesterday.", "The zoo has lions, tigers, and elephants."),
    ("sunflower", "/ˈsʌnˌflaʊər/", "向日葵", "名词",
     "The field was full of bright yellow sunflowers.", "Sunflowers always turn toward the sun."),
    ("student", "/ˈstuːdənt/", "学生", "名词",
     "She is a hardworking student at the university.", "The teacher answered the student's question."),
    ("island", "/ˈaɪlənd/", "岛屿", "名词",
     "We spent our vacation on a tropical island.", "The island is surrounded by clear blue water."),
    ("otter", "/ˈɑːtər/", "水獭", "名词",
     "The otter floated on its back in the river.", "Otters are playful animals that love water."),
    ("whistle", "/ˈwɪsəl/", "哨子", "名词",
     "The referee blew his whistle to stop the game.", "She can whistle a beautiful tune."),
    ("xylophone", "/ˈzaɪləfoʊn/", "木琴", "名词",
     "The child played a simple song on the xylophone.", "A xylophone makes bright, cheerful sounds."),
    ("zipper", "/ˈzɪpər/", "拉链", "名词",
     "The zipper on my jacket is stuck.", "She pulled the zipper up to close her bag."),
    ("volleyball", "/ˈvɑːlibɔːl/", "排球", "名词",
     "They play volleyball on the beach every weekend.", "Volleyball is a popular sport worldwide."),
    ("war", "/wɔːr/", "战争", "名词",
     "The memorial honors soldiers who died in the war.", "Peace is always better than war."),
    ("weed", "/wiːd/", "杂草", "名词",
     "She pulled the weeds out of the garden.", "Weeds grow quickly after rain."),
]

# Combine all
ALL_WORDS = WORDS + FOOD_NOUNS + OBJECT_NOUNS + VERBS + ADJECTIVES + OTHER_WORDS

def import_words():
    print(f"\n=== Importing {len(ALL_WORDS)} Words ===")
    batch = []
    for w in ALL_WORDS:
        word = w[0]
        ru = RU.get(word, "")
        batch.append({
            "word": word,
            "phonetic": w[1],
            "meaning": w[2],
            "ru_meaning": ru,
            "category": w[3],
            "example": w[4],
            "example2": w[5],
            "image": "📝",
            "level": "",
            "lang": "en"
        })

    r = s.post(f"{BASE}/api/admin/words", json={"words": batch})
    d = r.json()
    print(f"[{'OK' if d.get('ok') else 'FAIL'}] Added: {d.get('added',0)}, Updated: {d.get('updated',0)}")

# ==================== PART 3: Map Images ====================
# Image filename -> word mapping (inferred from filenames)
IMG_MAP = {
    "A_red_shiny_apple_on_a_wooden__2026-08-02T12-19-47.png": "apple",
    "A_cute_fluffy_orange_tabby_cat_2026-08-02T12-19-16.png": "cat",
    "A_cute_dog_golden_retriever_pu_2026-08-02T12-19-37.png": "dog",
    "A_brown_goat_standing_on_a_gre_2026-08-02T12-20-59.png": "goat",
    "A_gray_elephant_standing_in_Af_2026-08-02T12-19-47.png": "elephant",
    "A_beautiful_white_swan_on_a_la_2026-08-02T12-20-59.png": "swan",
    "A_colorful_bird_parrot_with_vi_2026-08-02T12-19-47.png": "parrot",
    "A_small_black_ant_carrying_a_c_2026-08-02T12-19-47.png": "ant",
    "A_yellow_rubber_duck_floating__2026-08-02T12-24-13.png": "duck",
    "A_red_and_orange_sunset_over_t_2026-08-02T12-21-36.png": "sun",
    "A_bicycle_parked_by_a_tree_in__2026-08-02T12-20-23.png": "bicycle",
    "A_blue_umbrella_open_in_the_ra_2026-08-02T12-20-23.png": "umbrella",
    "A_glass_jar_of_honey_with_a_wo_2026-08-02T12-21-00.png": "honey",
    "A_colorful_lollipop_candy__swe_2026-08-02T12-21-36.png": "lollipop",
    "A_mushroom_in_a_forest__red_ca_2026-08-02T12-21-36.png": "mushroom",
    "A_silver_coin_treasure_pile__s_2026-08-02T12-24-15.png": "coin",
    "A_white_ceramic_bowl_with_colo_2026-08-02T12-20-59.png": "bowl",
    "A_vase_with_colorful_flowers___2026-08-02T12-21-36.png": "flower",
    "A_white_rabbit_with_long_ears__2026-08-02T12-20-23.png": "rabbit",
    "A_yellow_lemon_slice_with_wate_2026-08-02T12-20-23.png": "lemon",
    "Fresh_red_strawberries_in_a_ba_2026-08-02T12-20-23.png": "strawberry",
    "An_oak_tree_with_strong_trunk__2026-08-02T12-24-15.png": "tree",
    "A_world_map_globe_on_a_desk__v_2026-08-02T12-24-54.png": "world",
    "A_zoo_entrance_with_animal_sta_2026-08-02T12-24-13.png": "zoo",
    "Yellow_sunflower_field_in_summ_2026-08-02T12-25-27.png": "sunflower",
    "Young_child_student_reading_a__2026-08-02T12-25-27.png": "student",
    "Tropical_island_paradise_with__2026-08-02T12-24-13.png": "island",
    "An_otter_floating_on_its_back__2026-08-02T12-21-00.png": "otter",
    "A_paper_airplane_flying_throug_2026-08-02T12-24-55.png": "paper",
    "A_whistle_metal_sports_referee_2026-08-02T12-25-27.png": "whistle",
    "A_wooden_xylophone_instrument__2026-08-02T12-25-27.png": "xylophone",
    "A_zipper_close_up_detail__meta_2026-08-02T12-24-55.png": "zipper",
    "Volleyball_net_on_a_sandy_beac_2026-08-02T12-25-27.png": "volleyball",
    "A_war_scene_memorial_statue__s_2026-08-02T12-24-55.png": "war",
    "Green_weeds_growing_between_co_2026-08-02T12-24-55.png": "weed",
}

def update_images():
    print(f"\n=== Updating {len(IMG_MAP)} Word Images ===")
    img_dir = "E:/xueyuyan-deploy/public/word-images/"
    base_url = f"{BASE}/word-images/"

    for fname, word in IMG_MAP.items():
        fpath = os.path.join(img_dir, fname)
        if not os.path.exists(fpath):
            print(f"[SKIP] Missing file: {fname}")
            continue
        img_url = base_url + fname
        r = s.post(f"{BASE}/api/admin/words", json={"words": [{
            "word": word,
            "image": img_url
        }]})
        d = r.json()
        ok = d.get("ok")
        print(f"[{'OK' if ok else 'FAIL'}] {word} -> {fname[:30]}...")

if __name__ == "__main__":
    token = login()
    if not token:
        print("Login failed!")
        exit(1)

    publish_knowledge()
    import_words()
    update_images()

    print("\n=== ALL DONE ===")
    print(f"Total words: {len(ALL_WORDS)}")
    print(f"Total images mapped: {len(IMG_MAP)}")
