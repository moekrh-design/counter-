# Voice Pack (تسجيلات خارجية)

## الفكرة
إذا اخترت من لوحة المدير > الإعدادات > **مصدر الصوت = تسجيل خارجي (Voice Pack)**
سيحاول النظام تشغيل ملفات صوت مسجلة من هذا المجلد عند كل نداء.

إذا كانت الملفات غير موجودة أو تعذر تشغيلها، سيعود النظام تلقائيًا إلى **صوت النظام (TTS)**.

## المسارات المطلوبة
### العربية
- `public/voicepack/ar/words/number.mp3`  \- كلمة: "الرقم"
- `public/voicepack/ar/words/please_go_to.mp3` \- عبارة: "تفضل إلى" أو "توجه إلى"
- `public/voicepack/ar/words/counter.mp3` \- كلمة: "الكونتر" (أو "الشباك")
- الأرقام (رقم رقم):
  - `public/voicepack/ar/digits/0.mp3`
  - `public/voicepack/ar/digits/1.mp3`
  - ...
  - `public/voicepack/ar/digits/9.mp3`

#### (اختياري) الحروف السابقة للتذكرة (بادئة الخدمة)
إذا كان رقم التذكرة عندك يحتوي حرف قبل الرقم مثل: `A-012` أو `L-105`،
تقدر تضيف تسجيلات للحروف هنا:

- `public/voicepack/ar/letters/A.mp3`
- `public/voicepack/ar/letters/B.mp3`
- `public/voicepack/ar/letters/C.mp3`
- ...

ملاحظة: هذه الملفات **اختيارية**. إذا كان ملف الحرف غير موجود، النظام يتخطاه ويكمل نطق الرقم.

### English
- `public/voicepack/en/words/ticket.mp3` \- word: "Ticket"
- `public/voicepack/en/words/please_go_to.mp3` \- phrase: "please go to"
- `public/voicepack/en/words/counter.mp3` \- word: "counter"
- digits:
  - `public/voicepack/en/digits/0.mp3` .. `9.mp3`

#### (Optional) prefix letters
If your ticket includes a Latin prefix like `A-012`, you can add letter recordings:

- `public/voicepack/en/letters/A.mp3` .. etc.

These are optional; if a letter file is missing, it will be skipped.

## ملاحظات مهمة
- يفضّل MP3 بمعدل 128kbps أو أعلى.
- الأفضل أن تكون الملفات قصيرة وواضحة بدون موسيقى خلفية.
- يتم نطق الأرقام رقم-رقم (مثال: 105 = 1 ثم 0 ثم 5).
- إذا كان اسم التذكرة أو الكونتر لا يحتوي أرقام (مثال: "كونتر أ") فلن يعمل Voice Pack لهذا النداء وسيعود إلى TTS.
