/*
* קבוצות WhatsApp מורשות.
*
* כדי להוסיף קבוצה נוספת:
* 1. הוסף פסיק אחרי המזהה הקיים.
* 2. הוסף את מזהה הקבוצה החדשה בשורה חדשה.
*
* לדוגמה:
* const ALLOWED_GROUP_IDS = [
*   "120363430798820443@g.us",
*   "120363000000000000@g.us",
* ];
*/

const DEDUPE_TTL_SECONDS = 60 * 60 * 24 * 7; // שמירת מזהה הודעה לשבוע
const MAX_SMS_LENGTH = 800;

/*
* מספר הנמענים המרבי בכל בקשה ל־SMS4FREE.
*
* כאשר יש יותר נמענים, המערכת מפצלת אותם
* אוטומטית למספר בקשות.
*/
const SMS_BATCH_SIZE = 100;

export default {
async fetch(request, env) {
const url = new URL(request.url);

try {
/*
* בדיקה פשוטה שה־Worker עובד.
*/
if (request.method === "GET") {
return jsonResponse({
ok: true,
message: "WhatsApp SMS bridge is running",
endpoints: {
greenApi: "/webhooks/green-api",
},
});
}

/*
* WhatsApp → GREEN-API → Cloudflare → SMS4FREE
*/
if (
request.method === "POST" &&
url.pathname === "/webhooks/green-api"
) {
return await handleGreenApiWebhook(request, env);
}

return new Response("Not found", {
status: 404,
});
} catch (error) {
console.error(
"UNHANDLED ERROR:",
error instanceof Error
? error.stack || error.message
: String(error)
);

return jsonResponse(
{
ok: false,
error: "Internal server error",
},
500
);
}
},
};

/*
* קבלת הודעה מ־GREEN-API ושליחתה ב־SMS.
*/
async function handleGreenApiWebhook(request, env) {
let webhook;

try {
webhook = await request.json();
} catch {
return jsonResponse(
{
ok: false,
error: "Invalid JSON",
},
400
);
}

const typeWebhook = String(
webhook?.typeWebhook ?? ""
);

const logText = extractWhatsappText(webhook).trim();

const firstWord =
logText.split(/\s+/).filter(Boolean)[0] ?? "";

console.log(
"GREEN API MESSAGE:",
JSON.stringify({
chatId: webhook?.senderData?.chatId ?? "",
sender:
webhook?.senderData?.senderName ??
webhook?.senderData?.senderContactName ??
webhook?.senderData?.sender ??
"",
firstWord,
})
);

/*
* GREEN-API דיווח שהחיבור לחשבון WhatsApp השתנה.
*/
if (typeWebhook === "stateInstanceChanged") {
const stateInstance = String(
webhook?.stateInstance ??
webhook?.instanceData?.stateInstance ??
""
);

console.log(
"GREEN API INSTANCE STATE:",
JSON.stringify({
stateInstance,
webhook,
})
);

const disconnectedStates = [
"notAuthorized",
"blocked",
"yellowCard",
];

if (!disconnectedStates.includes(stateInstance)) {
return jsonResponse({
ok: true,
ignored: true,
reason: `Instance state is ${stateInstance}`,
});
}

const alertId = `green-state:${stateInstance}`;

/*
* מונע הצפה של התראות חוזרות.
* תישלח לכל היותר התראה אחת בכל שש שעות לכל מצב.
*/
const alreadyAlerted =
await env.MESSAGE_DEDUPE.get(alertId);

if (alreadyAlerted) {
return jsonResponse({
ok: true,
ignored: true,
duplicate: true,
stateInstance,
});
}

const alertMessage =
stateInstance === "yellowCard"
? "אזהרה: חשבון ה-WhatsApp של המערכת קיבל כרטיס צהוב. יש לבדוק מיד את GREEN-API ולהפסיק שליחות עד לבירור."
: "חיבור ה-WhatsApp של המערכת התנתק. יש להיכנס ל-GREEN-API ולחבר מחדש את המספר.";

try {
const smsResult = await sendAdminAlertSms(
  alertMessage,
  env,
);

await env.MESSAGE_DEDUPE.put(
alertId,
"SENT",
{
expirationTtl: 60 * 60 * 6,
}
);

console.log(
"WHATSAPP DISCONNECT ALERT SENT:",
JSON.stringify({
stateInstance,
smsStatus: smsResult.status,
})
);

return jsonResponse({
ok: true,
alertSent: true,
stateInstance,
});
} catch (error) {
console.error(
"WHATSAPP DISCONNECT ALERT FAILED:",
error instanceof Error
? error.message
: String(error)
);

return jsonResponse({
ok: false,
alertSent: false,
stateInstance,
error:
error instanceof Error
? error.message
: String(error),
});
}
}

const messageId = String(
webhook?.idMessage ?? ""
);

const chatId = String(
webhook?.senderData?.chatId ?? ""
);

const sender = String(
webhook?.senderData?.sender ?? ""
);

const senderName =
String(
webhook?.senderData?.senderName ?? ""
).trim() ||
String(
webhook?.senderData?.senderContactName ?? ""
).trim() ||
"לא ידוע";

const text = extractWhatsappText(webhook).trim();

/*
* מקבלים רק הודעות נכנסות.
* הודעות מהטלפון או מה־API לא יפעילו SMS.
*/
if (typeWebhook !== "incomingMessageReceived") {
return ignored(
"Not an incoming WhatsApp message"
);
}

/*
* מתעלמים מכל הודעה שאינה מקבוצת WhatsApp.
*/
if (!chatId.endsWith("@g.us")) {
return ignored("Message is not from a group");
}

/*
* מתעלמים מהודעה שאינה מתחילה בשתי כוכביות.
*/
if (!text.startsWith("**")) {
return ignored(
"Message does not start with **"
);
}

const smsText = text.slice(2).trim();

if (!smsText) {
return ignored("SMS text is empty");
}

if (!messageId) {
console.error(
"MISSING GREEN API MESSAGE ID"
);

return jsonResponse(
{
ok: false,
error: "Missing message ID",
},
400
);
}

/*
* מניעת כפילות.
*
* בשלב הראשון מסמנים PROCESSING.
* רק אחרי הצלחת כל שליחות ה־SMS מסמנים SENT.
*
* אם GREEN-API שולח שוב את אותו Webhook,
* לא תישלח הודעה נוספת.
*/
const dedupeKey = `wa-in:${messageId}`;

const existingStatus =
await env.MESSAGE_DEDUPE.get(dedupeKey);

if (existingStatus) {
console.log(
"DUPLICATE WHATSAPP MESSAGE IGNORED:",
JSON.stringify({
messageId,
existingStatus,
})
);

return jsonResponse({
ok: true,
ignored: true,
duplicate: true,
messageId,
existingStatus,
});
}

await env.MESSAGE_DEDUPE.put(
dedupeKey,
"PROCESSING",
{
expirationTtl: DEDUPE_TTL_SECONDS,
}
);

const cleanSmsText = smsText.slice(
0,
MAX_SMS_LENGTH
);

console.log(
"SENDING SMS:",
JSON.stringify({
messageId,
chatId,
sender,
senderName,
smsText: cleanSmsText,
})
);

try {
const smsResult = await sendSms4Free(
cleanSmsText,
env,
chatId
);

await env.MESSAGE_DEDUPE.put(
dedupeKey,
"SENT",
{
expirationTtl: DEDUPE_TTL_SECONDS,
}
);

console.log(
"SMS SENT SUCCESSFULLY:",
JSON.stringify({
messageId,
totalRecipients:
smsResult.totalRecipients,
batchCount: smsResult.batchCount,
})
);

return jsonResponse({
ok: true,
sent: true,
messageId,
smsResult,
});
} catch (error) {
/*
* במקרה של כישלון מוחקים את נעילת הכפילות,
* כדי שאפשר יהיה לנסות שוב ידנית.
*/
await env.MESSAGE_DEDUPE.delete(dedupeKey);

console.error(
"SMS SEND FAILED:",
error instanceof Error
? error.message
: String(error)
);

/*
* מחזירים 200 ל־GREEN-API כדי שלא תיווצר
* לולאת ניסיונות אוטומטית ושליחות כפולות.
*/
return jsonResponse({
ok: false,
sent: false,
messageId,
error:
error instanceof Error
? error.message
: String(error),
});
}
}

/*
* שליחת SMS באמצעות SMS4FREE.
*
* ניתן להכניס ב־SMS_RECIPIENTS מספרים המופרדים
* בפסיקים, בנקודה־פסיק או בשורות נפרדות.
*
* לדוגמה:
* 0501234567,0521234567,0531234567
*
* או:
* 0501234567
* 0521234567
* 0531234567
*/
async function sendSms4Free(message, env, chatId) {
const requiredSecrets = [
"SMS4FREE_KEY",
"SMS4FREE_USER",
"SMS4FREE_PASS",
"SMS4FREE_SENDER",
];

for (const secretName of requiredSecrets) {
if (!env[secretName]) {
throw new Error(
`Missing Cloudflare secret: ${secretName}`
);
}
}

/*
* פיצול רשימת הנמענים.
*
* ניתן להפריד באמצעות:
* - פסיק
* - נקודה־פסיק
* - ירידת שורה
*
* Set מסיר מספרים כפולים.
*/
const recipients = await getSmsRecipients(env, chatId);

if (recipients.length === 0) {
  return {
    status: 1,
    message: "No recipients for this group",
    totalRecipients: 0,
    batchCount: 0,
    batches: [],
  };
}

/*
* מפצלים את הנמענים לקבוצות.
*/
const batches = chunkArray(
recipients,
SMS_BATCH_SIZE
);

const batchResults = [];

/*
* שולחים כל קבוצה בנפרד.
*
* השליחה מתבצעת לפי הסדר, ולא במקביל,
* כדי להפחית עומס על שירות ה־SMS.
*/
for (
let batchIndex = 0;
batchIndex < batches.length;
batchIndex++
) {
const batch = batches[batchIndex];

console.log(
"SENDING SMS BATCH:",
JSON.stringify({
batchNumber: batchIndex + 1,
totalBatches: batches.length,
recipientCount: batch.length,
})
);

const result = await sendSms4FreeRequest({
message,
recipients: batch,
env,
batchNumber: batchIndex + 1,
});

batchResults.push({
batchNumber: batchIndex + 1,
recipientCount: batch.length,
status: result.status,
message: result.message,
});
}

return {
status: 1,
message:
"All SMS batches sent successfully",
totalRecipients: recipients.length,
batchCount: batches.length,
batches: batchResults,
};
}

/*
* שליחת בקשה אחת ל־SMS4FREE.
*/
async function sendSms4FreeRequest({
message,
recipients,
env,
batchNumber,
}) {
const response = await fetch(
"https://api.sms4free.co.il/ApiSMS/v2/SendSMS",
{
method: "POST",
headers: {
"Content-Type": "application/json",
},
body: JSON.stringify({
key: env.SMS4FREE_KEY,
user: env.SMS4FREE_USER,
pass: env.SMS4FREE_PASS,
sender: env.SMS4FREE_SENDER,
recipient: recipients.join(";"),
msg: message,
}),
}
);

const rawText = await response.text();

let result;

try {
result = JSON.parse(rawText);
} catch {
throw new Error(
JSON.stringify({
batchNumber,
httpStatus: response.status,
rawResponse: rawText.slice(0, 500),
})
);
}

/*
* ב־SMS4FREE סטטוס חיובי מסמן הצלחה.
*/
if (
!response.ok ||
Number(result?.status) <= 0
) {
throw new Error(
JSON.stringify({
batchNumber,
recipientCount: recipients.length,
httpStatus: response.status,
smsResult: result,
})
);
}

return result;
}

/*
* שליחת התראת SMS למנהל במקרה של ניתוק,
* חסימה או כרטיס צהוב.
*/
async function sendAdminAlertSms(message, env) {
const requiredSecrets = [
"SMS4FREE_KEY",
"SMS4FREE_USER",
"SMS4FREE_PASS",
"SMS4FREE_SENDER",
"ADMIN_ALERT_PHONE",
];

for (const secretName of requiredSecrets) {
if (!env[secretName]) {
throw new Error(
`Missing Cloudflare secret: ${secretName}`
);
}
}

const adminPhone = normalizePhoneNumber(
env.ADMIN_ALERT_PHONE
);

if (!adminPhone) {
throw new Error(
"Invalid ADMIN_ALERT_PHONE"
);
}

const response = await fetch(
"https://api.sms4free.co.il/ApiSMS/v2/SendSMS",
{
method: "POST",
headers: {
"Content-Type": "application/json",
},
body: JSON.stringify({
key: env.SMS4FREE_KEY,
user: env.SMS4FREE_USER,
pass: env.SMS4FREE_PASS,
sender: env.SMS4FREE_SENDER,
recipient: adminPhone,
msg: message,
}),
}
);

const rawText = await response.text();

let result;

try {
result = JSON.parse(rawText);
} catch {
throw new Error(
JSON.stringify({
httpStatus: response.status,
rawResponse: rawText.slice(0, 500),
})
);
}

if (
!response.ok ||
Number(result?.status) <= 0
) {
throw new Error(
JSON.stringify({
httpStatus: response.status,
smsResult: result,
})
);
}

return result;
}

async function getSmsRecipients(env, groupId) {
  // אם הוגדר Google Sheets API — מנסים לקרוא ממנו
  if (env.RECIPIENTS_API_URL && env.RECIPIENTS_API_SECRET) {
    try {
      const response = await fetch(env.RECIPIENTS_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          secret: env.RECIPIENTS_API_SECRET,
          groupId: groupId,
        }),

      if (!response.ok) {
        throw new Error(
          `Recipients API returned HTTP ${response.status}`
        );
      }

      const data = await response.json();

      if (
        data?.ok === true &&
        Array.isArray(data.recipients)
      ) {
        const recipients = [
          ...new Set(
            data.recipients
              .map(normalizePhoneNumber)
              .filter(Boolean)
          ),
        ];

        console.log(
          "RECIPIENTS LOADED FROM GOOGLE SHEETS:",
          recipients.length
        );

        return recipients;
      }
    } catch (error) {
      console.error(
        "GOOGLE SHEETS RECIPIENTS FAILED:",
        error instanceof Error
          ? error.message
          : String(error)
      );
    }
  }

  /*
   * גיבוי:
   * אם Google Sheets לא זמין,
   * משתמשים ברשימה הישנה מ־Cloudflare.
   */
  const fallbackRecipients = [
    ...new Set(
      String(env.SMS_RECIPIENTS ?? "")
        .split(/[,;\n\r]+/)
        .map(normalizePhoneNumber)
        .filter(Boolean)
    ),
  ];

  console.log(
    "USING FALLBACK SMS_RECIPIENTS:",
    fallbackRecipients.length
  );

  return fallbackRecipients;
}

/*
* חילוץ טקסט מהודעת WhatsApp.
*/
function extractWhatsappText(webhook) {
return String(
webhook?.messageData?.textMessageData
?.textMessage ??
webhook?.messageData
?.extendedTextMessageData?.text ??
webhook?.messageData?.quotedMessage
?.textMessage ??
""
);
}

/*
* נרמול מספר טלפון ישראלי.
*
* דוגמאות:
* 050-123-4567   → 972501234567
* 0501234567     → 972501234567
* +972501234567  → 972501234567
* 9720501234567  → 972501234567
*/
function normalizePhoneNumber(value) {
return String(value ?? "")
.trim()
.replace(/[^\d+]/g, "")
.replace(/^9720/, "972")
.replace(/^0/, "972")
.replace(/^\+/, "");
}

/*
* חלוקת מערך לקבוצות בגודל קבוע.
*/
function chunkArray(items, chunkSize) {
const chunks = [];

for (
let index = 0;
index < items.length;
index += chunkSize
) {
chunks.push(
items.slice(index, index + chunkSize)
);
}

return chunks;
}

function ignored(reason) {
return jsonResponse({
ok: true,
ignored: true,
reason,
});
}

function jsonResponse(data, status = 200) {
return new Response(JSON.stringify(data), {
status,
headers: {
"Content-Type":
"application/json; charset=utf-8",
"Cache-Control": "no-store",
},
});
}
