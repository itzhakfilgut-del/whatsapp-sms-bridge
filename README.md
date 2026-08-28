# WhatsApp → SMS Bridge

Cloudflare Worker שמקבל Webhooks מ־GREEN-API ושולח הודעות WhatsApp מסומנות דרך SMS4FREE.

## מה הקוד עושה

- מקבל Webhook ב־`POST /webhooks/green-api`.
- מטפל רק בהודעות WhatsApp נכנסות מקבוצות.
- שולח ב־SMS רק הודעות שמתחילות ב־`**`.
- מסיר את שתי הכוכביות לפני השליחה.
- מונע שליחה כפולה באמצעות Cloudflare KV למשך 7 ימים.
- מפצל רשימות נמענים לקבוצות של עד 100 מספרים.
- שולח התראת SMS למנהל אם GREEN-API מדווח על `notAuthorized`, `blocked` או `yellowCard`.
- מגביל הודעת SMS ל־800 תווים.

## התקנה

1. העלה את התיקייה ל־GitHub.
2. התקן Node.js ואז הרץ:

   ```bash
   npm install
   ```

3. העתק את `wrangler.toml.example` ל־`wrangler.toml` והכנס את מזהה ה־KV שלך.
4. צור KV Namespace ב־Cloudflare וקשר אותו בשם `MESSAGE_DEDUPE`.
5. הגדר את הסודות ב־Cloudflare / Wrangler:

   ```bash
   npx wrangler secret put SMS4FREE_KEY
   npx wrangler secret put SMS4FREE_USER
   npx wrangler secret put SMS4FREE_PASS
   npx wrangler secret put SMS4FREE_SENDER
   npx wrangler secret put SMS_RECIPIENTS
   npx wrangler secret put ADMIN_ALERT_PHONE
   ```

6. לפריסה:

   ```bash
   npm run deploy
   ```

## בדיקה מקומית

העתק את `.dev.vars.example` ל־`.dev.vars` והכנס ערכים מקומיים. לאחר מכן:

```bash
npm run dev
```

בדיקת תחביר בלבד:

```bash
npm run check
```

## אבטחה

אין להעלות ל־GitHub את `wrangler.toml` אם הכנסת בו מידע רגיש, את `.dev.vars`, סיסמאות או מפתחות API. הקבצים האלה כבר מוחרגים ב־`.gitignore`.

> שים לב: בגרסה שסופקה אין בפועל בדיקה מול רשימת `ALLOWED_GROUP_IDS`; הקוד בודק שההודעה מגיעה מקבוצה ושמתחילה ב־`**`. אם רוצים להגביל לקבוצה מסוימת, מומלץ להוסיף בדיקת מזהה קבוצה לפני פריסה ציבורית.
