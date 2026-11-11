import bridgeWorker from "./bridge.js";

const DEDUPE_TTL_SECONDS = 60 * 60 * 24 * 7;
const MAX_SMS_LENGTH = 800;
const SMS_BATCH_SIZE = 100;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
  env.ENABLE_BRIDGE_API === "true" &&
  (
    url.pathname.startsWith("/device/") ||
    url.pathname === "/admin/job" ||
    url.pathname === "/admin/jobs"
  )
) {
  return bridgeWorker.fetch(request, {
    ...env,
    DB: env.SMS_DB
  });
}

    if (request.method === "GET" && (url.pathname === "/admin/sms" || url.pathname === "/admin/sms/export.csv")) {
      try { return await smsMonitorRoute(request, env); }
      catch (error) { console.error("SMS DASHBOARD FAILED", String(error)); return new Response("Dashboard unavailable", {status:503}); }
    }

    try {
      /*
       * בדיקת נמענים לקבוצה
       */
      if (
        request.method === "GET" &&
        url.pathname === "/test-recipients"
      ) {
        const groupId =
          url.searchParams.get("groupId") || "";

        const recipients =
          await getSmsRecipients(env, groupId);

        return jsonResponse({
          ok: true,
          groupId,
          count: recipients.length,
          recipients
        });
      }

      /*
       * בדיקת Worker
       */
      if (request.method === "GET") {
        return jsonResponse({
          ok: true,
          message: "WhatsApp SMS bridge is running",
          endpoints: {
            greenApi: "/webhooks/green-api",
            testRecipients:
              "/test-recipients?groupId=YOUR_GROUP_ID"
          }
        });
      }

      /*
       * GREEN API WEBHOOK
       */
      if (
        request.method === "POST" &&
        url.pathname === "/webhooks/green-api"
      ) {
        return await handleGreenApiWebhook(
          request,
          env
        );
      }

      return new Response("Not found", {
        status: 404
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
          error: "Internal server error"
        },
        500
      );
    }
  }
};


/* =========================================================
   GREEN API
========================================================= */

async function handleGreenApiWebhook(
  request,
  env
) {
  let webhook;

  try {
    webhook = await request.json();
  } catch {
    return jsonResponse(
      {
        ok: false,
        error: "Invalid JSON"
      },
      400
    );
  }

  const typeWebhook = String(
    webhook?.typeWebhook ?? ""
  );

  /*
   * התראה על ניתוק WhatsApp
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
        webhook
      })
    );

    const disconnectedStates = [
      "notAuthorized",
      "blocked",
      "yellowCard"
    ];

    if (
      !disconnectedStates.includes(
        stateInstance
      )
    ) {
      return jsonResponse({
        ok: true,
        ignored: true,
        reason:
          `Instance state is ${stateInstance}`
      });
    }

    const alertId =
      `green-state:${stateInstance}`;

    const alreadyAlerted =
      await env.MESSAGE_DEDUPE.get(
        alertId
      );

    if (alreadyAlerted) {
      return jsonResponse({
        ok: true,
        ignored: true,
        duplicate: true,
        stateInstance
      });
    }

    const alertMessage =
      stateInstance === "yellowCard"
        ? "אזהרה: חשבון ה-WhatsApp של המערכת קיבל כרטיס צהוב. יש לבדוק מיד את GREEN-API ולהפסיק שליחות עד לבירור."
        : "חיבור ה-WhatsApp של המערכת התנתק. יש להיכנס ל-GREEN-API ולחבר מחדש את המספר.";

    try {

      const smsResult =
        await sendAdminAlertSms(
          alertMessage,
          env
        );

      await env.MESSAGE_DEDUPE.put(
        alertId,
        "SENT",
        {
          expirationTtl:
            60 * 60 * 6
        }
      );

      console.log(
        "WHATSAPP DISCONNECT ALERT SENT:",
        JSON.stringify({
          stateInstance,
          smsStatus:
            smsResult.status
        })
      );

      return jsonResponse({
        ok: true,
        alertSent: true,
        stateInstance
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
            : String(error)
      });
    }
  }


  /*
   * סוגי הודעות שאנחנו מקבלים
   */
  const allowedWebhookTypes = [
    "incomingMessageReceived",
    "outgoingMessageReceived",
    "outgoingAPIMessageReceived"
  ];

  /*
   * אם זה לא webhook של הודעה אמיתית,
   * רושמים לוג נפרד ולא מציגים אותו
   * כאילו התקבלה הודעה ריקה.
   */
  if (
    !allowedWebhookTypes.includes(typeWebhook)
  ) {
    console.log(
      "GREEN API NON-MESSAGE WEBHOOK:",
      JSON.stringify({
        typeWebhook,
        stateInstance:
          webhook?.stateInstance ?? "",
        idMessage:
          webhook?.idMessage ?? ""
      })
    );

    return ignored(
      `Unsupported webhook type: ${typeWebhook}`
    );
  }


  /*
   * הודעת WhatsApp רגילה
   */
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

  const text =
    extractWhatsappText(webhook).trim();

  const firstWord =
    text
      .split(/\s+/)
      .filter(Boolean)[0] ?? "";

  const typeMessage = String(
    webhook?.messageData?.typeMessage ?? ""
  );

  /*
   * הלוג הזה נכתב רק אחרי שווידאנו
   * שזה באמת webhook של הודעה.
   */
  console.log(
    "GREEN API MESSAGE:",
    JSON.stringify({
      typeWebhook,
      typeMessage,
      messageId,
      chatId,
      sender,
      senderName,
      firstWord,
      hasText:
        Boolean(text),
      textLength:
        text.length
    })
  );


  /*
   * רק קבוצות WhatsApp
   */

  if (!chatId.endsWith("@g.us")) {
    return ignored(
      "Message is not from a group"
    );
  }


  /*
   * רק הודעה שמתחילה ב-**
   */
  if (!text.startsWith("**")) {
    return ignored(
      "Message does not start with **"
    );
  }


  const smsText =
    text.slice(2).trim();

  if (!smsText) {
    return ignored(
      "SMS text is empty"
    );
  }


  if (!messageId) {

    console.error(
      "MISSING GREEN API MESSAGE ID"
    );

    return jsonResponse(
      {
        ok: false,
        error: "Missing message ID"
      },
      400
    );
  }


  /* =======================================================
     DEDUPE
  ======================================================= */

  const dedupeKey =
    `wa-in:${messageId}`;

  const existingStatus =
    await env.MESSAGE_DEDUPE.get(
      dedupeKey
    );

  if (existingStatus) {

    console.log(
      "DUPLICATE WHATSAPP MESSAGE IGNORED:",
      JSON.stringify({
        messageId,
        existingStatus
      })
    );

    return jsonResponse({
      ok: true,
      ignored: true,
      duplicate: true,
      messageId,
      existingStatus
    });
  }


  await env.MESSAGE_DEDUPE.put(
    dedupeKey,
    "PROCESSING",
    {
      expirationTtl:
        DEDUPE_TTL_SECONDS
    }
  );


  const cleanSmsText =
    smsText.slice(
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
      smsLength:
        cleanSmsText.length
    })
  );


  try {

    const smsResult =
      await sendSms4Free(
        cleanSmsText,
        env,
        chatId
      );

    await smsLogSafely(env, { messageId, chatId, sender, message: cleanSmsText,
      recipientCount: smsResult.totalRecipients || 0, route: "SMS4FREE", status: "SENT" });

    await env.MESSAGE_DEDUPE.put(
      dedupeKey,
      "SENT",
      {
        expirationTtl:
          DEDUPE_TTL_SECONDS
      }
    );

    console.log(
      "SMS SENT SUCCESSFULLY:",
      JSON.stringify({
        messageId,

        totalRecipients:
          smsResult.totalRecipients,

        senderCount:
          smsResult.senderCount,

        batchCount:
          smsResult.batchCount
      })
    );

    return jsonResponse({
      ok: true,
      sent: true,
      messageId,
      smsResult
    });

  } catch (error) {

    /*
     * אם השליחה נכשלה,
     * מאפשרים ניסיון חוזר.
     */
    // Do not delete dedupe marker after an uncertain provider failure:
    // earlier batches may already have been accepted.
    try { await env.MESSAGE_DEDUPE.put(dedupeKey, "REVIEW_REQUIRED", {expirationTtl: DEDUPE_TTL_SECONDS}); }
    catch (kvError) { console.error("DEDUPE STATUS UPDATE FAILED", String(kvError)); }

    await smsLogSafely(env, {messageId, chatId, sender, message: cleanSmsText,
      recipientCount: 0, route: "SMS4FREE", status: "REVIEW_REQUIRED", error: String(error)});

    console.error(
      "SMS SEND FAILED:",
      error instanceof Error
        ? error.message
        : String(error)
    );

    return jsonResponse({
      ok: false,
      sent: false,
      messageId,
      error:
        error instanceof Error
          ? error.message
          : String(error)
    });
  }
}


/* =========================================================
   שליחת SMS לפי Sender של כל אדם
========================================================= */

async function sendSms4Free(
  message,
  env,
  chatId
) {

  const requiredSecrets = [
    "SMS4FREE_KEY",
    "SMS4FREE_USER",
    "SMS4FREE_PASS",
    "SMS4FREE_SENDER"
  ];

  for (
    const secretName
    of requiredSecrets
  ) {

    if (!env[secretName]) {
      throw new Error(
        `Missing Cloudflare secret: ${secretName}`
      );
    }
  }


  /*
   * מקבלים מהגיליון:
   *
   * [
   *   {
   *     phone: "97250...",
   *     sender: "YudAlef4"
   *   },
   *   ...
   * ]
   */
  const recipients =
    await getSmsRecipients(
      env,
      chatId
    );


  if (recipients.length === 0) {

    return {
      status: 1,
      message:
        "No recipients for this group",

      totalRecipients: 0,
      senderCount: 0,
      batchCount: 0,
      senders: []
    };
  }


  /*
   * מקבצים אנשים לפי Sender.
   *
   * אם לאדם אין שם שולח בעמודה G,
   * משתמשים ב-SMS4FREE_SENDER
   * כברירת מחדל.
   */
  const recipientsBySender =
    new Map();


  for (const recipient of recipients) {

    const phone =
      normalizePhoneNumber(
        recipient.phone
      );

    if (!phone) {
      continue;
    }

    const smsSender =
      String(
        recipient.sender || ""
      ).trim() ||
      String(
        env.SMS4FREE_SENDER
      ).trim();


    if (
      !recipientsBySender.has(
        smsSender
      )
    ) {
      recipientsBySender.set(
        smsSender,
        []
      );
    }

    recipientsBySender
      .get(smsSender)
      .push(phone);
  }


  /*
   * מסירים כפילויות
   * בתוך כל Sender.
   */
  for (
    const [
      smsSender,
      phones
    ]
    of recipientsBySender.entries()
  ) {

    recipientsBySender.set(
      smsSender,
      [...new Set(phones)]
    );
  }


  const senderResults = [];

  let totalRecipients = 0;
  let totalBatches = 0;


  /*
   * שולחים Sender אחר Sender
   */
  for (
    const [
      smsSender,
      phones
    ]
    of recipientsBySender.entries()
  ) {

    const batches =
      chunkArray(
        phones,
        SMS_BATCH_SIZE
      );

    const batchResults = [];


    console.log(
      "PROCESSING SMS SENDER:",
      JSON.stringify({
        sender: smsSender,
        recipientCount:
          phones.length,
        batchCount:
          batches.length
      })
    );


    for (
      let batchIndex = 0;
      batchIndex < batches.length;
      batchIndex++
    ) {

      const batch =
        batches[batchIndex];

      console.log(
        "SENDING SMS BATCH:",
        JSON.stringify({
          sender:
            smsSender,

          batchNumber:
            batchIndex + 1,

          totalBatches:
            batches.length,

          recipientCount:
            batch.length
        })
      );


      const result =
        await sendSms4FreeRequest({
          message,

          recipients:
            batch,

          sender:
            smsSender,

          env,

          batchNumber:
            batchIndex + 1
        });


      batchResults.push({
        batchNumber:
          batchIndex + 1,

        recipientCount:
          batch.length,

        status:
          result.status,

        message:
          result.message
      });

      totalBatches++;
    }


    totalRecipients +=
      phones.length;


    senderResults.push({
      sender:
        smsSender,

      recipientCount:
        phones.length,

      batchCount:
        batches.length,

      batches:
        batchResults
    });
  }


  return {
    status: 1,

    message:
      "All SMS batches sent successfully",

    totalRecipients,

    senderCount:
      senderResults.length,

    batchCount:
      totalBatches,

    senders:
      senderResults
  };
}


/* =========================================================
   בקשת SMS4FREE
========================================================= */

async function sendSms4FreeRequest({
  message,
  recipients,
  sender,
  env,
  batchNumber
}) {

  const response =
    await fetch(
      "https://api.sms4free.co.il/ApiSMS/v2/SendSMS",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({

          key:
            env.SMS4FREE_KEY,

          user:
            env.SMS4FREE_USER,

          pass:
            env.SMS4FREE_PASS,

          sender:
            sender,

          recipient:
            recipients.join(";"),

          msg:
            message
        })
      }
    );


  const rawText =
    await response.text();


  let result;

  try {

    result =
      JSON.parse(rawText);

  } catch {

    throw new Error(
      JSON.stringify({
        batchNumber,
        sender,
        httpStatus:
          response.status,

        rawResponse:
          rawText.slice(
            0,
            500
          )
      })
    );
  }


  if (
    !response.ok ||
    Number(result?.status) <= 0
  ) {

    throw new Error(
      JSON.stringify({

        batchNumber,

        sender,

        recipientCount:
          recipients.length,

        httpStatus:
          response.status,

        smsResult:
          result
      })
    );
  }


  return result;
}


/* =========================================================
   התראת מנהל
========================================================= */

async function sendAdminAlertSms(
  message,
  env
) {

  const requiredSecrets = [
    "SMS4FREE_KEY",
    "SMS4FREE_USER",
    "SMS4FREE_PASS",
    "SMS4FREE_SENDER",
    "ADMIN_ALERT_PHONE"
  ];


  for (
    const secretName
    of requiredSecrets
  ) {

    if (!env[secretName]) {

      throw new Error(
        `Missing Cloudflare secret: ${secretName}`
      );
    }
  }


  const adminPhone =
    normalizePhoneNumber(
      env.ADMIN_ALERT_PHONE
    );


  if (!adminPhone) {

    throw new Error(
      "Invalid ADMIN_ALERT_PHONE"
    );
  }


  const response =
    await fetch(
      "https://api.sms4free.co.il/ApiSMS/v2/SendSMS",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({

          key:
            env.SMS4FREE_KEY,

          user:
            env.SMS4FREE_USER,

          pass:
            env.SMS4FREE_PASS,

          sender:
            env.SMS4FREE_SENDER,

          recipient:
            adminPhone,

          msg:
            message
        })
      }
    );


  const rawText =
    await response.text();


  let result;


  try {

    result =
      JSON.parse(rawText);

  } catch {

    throw new Error(
      JSON.stringify({
        httpStatus:
          response.status,

        rawResponse:
          rawText.slice(
            0,
            500
          )
      })
    );
  }


  if (
    !response.ok ||
    Number(result?.status) <= 0
  ) {

    throw new Error(
      JSON.stringify({
        httpStatus:
          response.status,

        smsResult:
          result
      })
    );
  }


  return result;
}


/* =========================================================
   קבלת נמענים מ-Google Apps Script
========================================================= */

async function getSmsRecipients(
  env,
  groupId
) {

  if (
    env.RECIPIENTS_API_URL &&
    env.RECIPIENTS_API_SECRET
  ) {

    try {

      const response =
        await fetch(
          env.RECIPIENTS_API_URL,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            body: JSON.stringify({
              secret:
                env.RECIPIENTS_API_SECRET,

              groupId
            })
          }
        );


      if (!response.ok) {

        throw new Error(
          `Recipients API returned HTTP ${response.status}`
        );
      }


      const data =
        await response.json();


      if (
        data?.ok === true &&
        Array.isArray(
          data.recipients
        )
      ) {

        /*
         * פורמט חדש:
         *
         * {
         *   phone: "...",
         *   sender: "..."
         * }
         */
        const recipients =
          data.recipients
            .map(item => {

              /*
               * תמיכה גם בפורמט החדש
               */
              if (
                item &&
                typeof item === "object"
              ) {

                return {
                  phone:
                    normalizePhoneNumber(
                      item.phone
                    ),

                  sender:
                    String(
                      item.sender || ""
                    ).trim()
                };
              }


              /*
               * תמיכה לאחור:
               * אם משום מה API ישן
               * עדיין מחזיר רק מספרים.
               */
              return {
                phone:
                  normalizePhoneNumber(
                    item
                  ),

                sender:
                  ""
              };
            })

            .filter(
              item =>
                Boolean(item.phone)
            );


        console.log(
          "RECIPIENTS LOADED FROM GOOGLE SHEETS:",
          JSON.stringify({
            count:
              recipients.length,

            groupId
          })
        );


        return recipients;
      }


      throw new Error(
        "Recipients API returned invalid response"
      );

    } catch (error) {

      console.error(
        "GOOGLE SHEETS RECIPIENTS FAILED:",
        error instanceof Error
          ? error.message
          : String(error)
      );
    }
  }


  // Never fall back to an unscoped, global recipient list for a scoped WhatsApp group.
  if (env.RECIPIENTS_API_URL && env.RECIPIENTS_API_SECRET) {
    throw new Error("Recipients API unavailable: group-specific recipients cannot be verified");
  }

  /*
   * FALLBACK ישן:
   * SMS_RECIPIENTS
   *
   * במקרה הזה כולם יקבלו
   * SMS4FREE_SENDER.
   */
  const fallbackRecipients = [
    ...new Set(
      String(
        env.SMS_RECIPIENTS ?? ""
      )
        .split(/[,;\n\r]+/)
        .map(
          normalizePhoneNumber
        )
        .filter(Boolean)
    )
  ]
    .map(phone => ({
      phone,
      sender: ""
    }));


  console.log(
    "USING FALLBACK SMS_RECIPIENTS:",
    fallbackRecipients.length
  );


  return fallbackRecipients;
}


/* =========================================================
   WhatsApp text
========================================================= */

function extractWhatsappText(
  webhook
) {

  return String(

    webhook
      ?.messageData
      ?.textMessageData
      ?.textMessage ??

    webhook
      ?.messageData
      ?.extendedTextMessageData
      ?.text ??

    webhook
      ?.messageData
      ?.quotedMessage
      ?.textMessage ??

    ""
  );
}


/* =========================================================
   טלפון
========================================================= */

function normalizePhoneNumber(
  value
) {

  return String(
    value ?? ""
  )
    .trim()

    .replace(
      /[^\d+]/g,
      ""
    )

    .replace(
      /^9720/,
      "972"
    )

    .replace(
      /^0/,
      "972"
    )

    .replace(
      /^\+/,
      ""
    );
}


/* =========================================================
   חלוקה לבאצ'ים
========================================================= */

function chunkArray(
  items,
  chunkSize
) {

  const chunks = [];


  for (
    let index = 0;
    index < items.length;
    index += chunkSize
  ) {

    chunks.push(
      items.slice(
        index,
        index + chunkSize
      )
    );
  }


  return chunks;
}


/* =========================================================
   ignored
========================================================= */

function ignored(reason) {

  return jsonResponse({
    ok: true,
    ignored: true,
    reason
  });
}


/* =========================================================
   JSON
========================================================= */

function jsonResponse(
  data,
  status = 200
) {

  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-store"
      }
    }
  );
}
/* SMS MONITOR ADD-ON */

function smsUnitCount(message) {
  const len = [...String(message || '')].length;
  return len <= 0 ? 0 : len <= 134 ? 1 : 1 + Math.ceil((len - 134) / 67);
}

async function smsLogSafely(env, data) {
  if (!env.SMS_DB) {
    console.warn('SMS_DB binding is missing: tracking disabled, legacy SMS unchanged');
    return;
  }
  try {
    await env.SMS_DB.prepare(`
      INSERT INTO sms_messages
      (message_id,group_id,whatsapp_sender,message_text,char_count,
       recipient_count,segments_per_recipient,billable_units,route,status,estimated_cost_ils,error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(message_id) DO UPDATE SET
        recipient_count=excluded.recipient_count,
        billable_units=excluded.billable_units,
        route=excluded.route,
        status=excluded.status,
        estimated_cost_ils=excluded.estimated_cost_ils,
        error=excluded.error
    `).bind(
      data.messageId, data.chatId || '', data.sender || '', data.message || '',
      [...String(data.message || '')].length,
      data.recipientCount || 0,
      smsUnitCount(data.message),
      data.route === 'SMS4FREE' && data.status === 'SENT' ? (data.recipientCount || 0) * smsUnitCount(data.message) : 0,
      data.route || 'SMS4FREE', data.status || 'UNKNOWN',
      Number(((data.route === 'SMS4FREE' && data.status === 'SENT' ? (data.recipientCount || 0) * smsUnitCount(data.message) : 0) * Number(env.SMS_UNIT_PRICE_ILS || '0.041')).toFixed(4)),
      (data.error || '').slice(0, 350)
    ).run();
  } catch (err) {
    // Monitor failures must NEVER affect existing delivery or cause a retry.
    console.error('SMS MONITOR WRITE FAILED:', String(err));
  }
}

function smsEsc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function smsMonitorUnauthorized() {
  return new Response('Authentication required', {
    status: 401,
    headers: {'WWW-Authenticate': 'Basic realm="SMS Monitor", charset="UTF-8"', 'Cache-Control':'no-store'}
  });
}

function smsMonitorAuth(request, env) {
  const expectedUser = String(env.SMS_ADMIN_USER || '');
  const expectedPass = String(env.SMS_ADMIN_PASSWORD || '');
  if (!expectedUser || !expectedPass) return false;
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  try {
    const decoded = atob(header.slice(6));
    const index = decoded.indexOf(':');
    return index !== -1 && decoded.slice(0,index) === expectedUser && decoded.slice(index+1) === expectedPass;
  } catch {return false;}
}

async function smsMonitorRoute(request, env) {
  if (!smsMonitorAuth(request, env)) return smsMonitorUnauthorized();
  if (!env.SMS_DB) return new Response('Missing SMS_DB binding', {status:503});
  const url = new URL(request.url);
  const dateFrom = url.searchParams.get('from') || '';
  const dateTo = url.searchParams.get('to') || '';
  const route = url.searchParams.get('route') || '';
  const page = Math.max(1, Math.min(100000, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1));
  const filters = [];
  const args = [];
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {filters.push('created_at >= ?');args.push(dateFrom+'T00:00:00Z');}
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {filters.push('created_at < ?'); const d = new Date(dateTo+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+1); args.push(d.toISOString());}
  if (['SMS4FREE','PHONE'].includes(route)) {filters.push('route = ?');args.push(route);}
  const where = filters.length ? 'WHERE '+filters.join(' AND ') : '';
  const summary = await env.SMS_DB.prepare(`SELECT COUNT(*) AS messages, COALESCE(SUM(recipient_count),0) AS recipients, COALESCE(SUM(billable_units),0) AS units, COALESCE(SUM(estimated_cost_ils),0) AS cost, SUM(CASE WHEN route='PHONE' THEN 1 ELSE 0 END) AS phone_messages, SUM(CASE WHEN route='SMS4FREE' THEN 1 ELSE 0 END) AS provider_messages FROM sms_messages ${where}`).bind(...args).first();
  const rows = (await env.SMS_DB.prepare(`SELECT created_at,message_id,whatsapp_sender,group_id,message_text,char_count,recipient_count,segments_per_recipient,billable_units,route,status,estimated_cost_ils,error FROM sms_messages ${where} ORDER BY created_at DESC LIMIT 50 OFFSET ?`).bind(...args,(page-1)*50).all()).results || [];
  const p = new URLSearchParams(url.searchParams);
  if (url.pathname === '/admin/sms/export.csv') {
    const all = (await env.SMS_DB.prepare(`SELECT created_at,message_id,whatsapp_sender,group_id,message_text,char_count,recipient_count,billable_units,route,status,estimated_cost_ils FROM sms_messages ${where} ORDER BY created_at DESC LIMIT 5000`).bind(...args).all()).results || [];
    const keys=['created_at','message_id','whatsapp_sender','group_id','message_text','char_count','recipient_count','billable_units','route','status','estimated_cost_ils'];
    const safeCell = value => { let cell = String(value ?? ''); if (/^[\s]*[=+@-]/.test(cell) && !/^-?\d+(\.\d+)?$/.test(cell)) cell = '\'' + cell; return '"' + cell.replace(/"/g, '""') + '"'; };
    const csv = '\uFEFF'+[keys.join(','),...all.map(row=>keys.map(key=>safeCell(row[key])).join(','))].join('\r\n');
    return new Response(csv,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="sms-monitor.csv"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }
  const total = Number(summary?.messages || 0);
  const money = value => Number(value || 0).toLocaleString('he-IL',{minimumFractionDigits:2,maximumFractionDigits:2});
  const number = value => Number(value || 0).toLocaleString('he-IL');
  const linkPage = n => {p.set('page',String(n));return '/admin/sms?'+p.toString();};
  const table = rows.map(row=>`<tr><td>${smsEsc(new Date(row.created_at).toLocaleString('he-IL',{timeZone:'Asia/Jerusalem'}))}<div class="muted">${smsEsc(new Intl.DateTimeFormat('he-IL-u-ca-hebrew',{day:'numeric',month:'long',year:'numeric',timeZone:'Asia/Jerusalem'}).format(new Date(row.created_at)))}</div></td><td><span title="${smsEsc(row.message_id)}">${smsEsc(row.whatsapp_sender)}</span></td><td class="msg">${smsEsc(row.message_text)}</td><td>${number(row.char_count)}</td><td>${number(row.recipient_count)}</td><td>${number(row.billable_units)}</td><td>${smsEsc(row.route)}</td><td>${smsEsc(row.status)}</td><td>₪${money(row.estimated_cost_ils)}</td></tr>`).join('');
  const downloadParams = new URLSearchParams(url.searchParams); downloadParams.delete('page');
  const html = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>מעקב SMS</title><style>body{font-family:system-ui,Arial;background:#f6f8fb;color:#142139;margin:0;padding:24px}main{max-width:1380px;margin:auto}h1{margin:0 0 8px}.muted{color:#607087}section{background:white;border:1px solid #dfe5ed;border-radius:14px;padding:18px;margin:18px 0}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}.card{background:#f6f9fc;padding:17px;border-radius:12px}.card b{font-size:26px;display:block;margin-top:8px}.filters{display:flex;flex-wrap:wrap;gap:12px;align-items:end}label{font-weight:600;font-size:13px}input,select{padding:9px;border:1px solid #ccd5e0;border-radius:7px;display:block;margin-top:5px}button,.button{background:#1459a4;color:white;padding:10px 15px;border-radius:8px;border:0;text-decoration:none;display:inline-block;cursor:pointer}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:right;padding:11px;border-bottom:1px solid #edf1f4;vertical-align:top}th{white-space:nowrap;background:#f6f8fb}.scroll{overflow:auto}.msg{min-width:260px;max-width:440px;white-space:pre-wrap;overflow-wrap:anywhere}.footer{display:flex;gap:15px;align-items:center}a{color:#1459a4}</style></head><body><main><h1>מעקב הודעות SMS</h1><p class="muted">נתוני שליחה שנרשמו מאז הפעלת המעקב. עלות משוערת לפי ${smsEsc(env.SMS_UNIT_PRICE_ILS || '0.041')} ₪ ליחידת חיוב, כולל מע״מ. תאריכים מוצגים בשעון ישראל; סינון לפי יום UTC.</p><section><form class="filters" method="get"><label>מתאריך<input type="date" name="from" value="${smsEsc(dateFrom)}"></label><label>עד תאריך<input type="date" name="to" value="${smsEsc(dateTo)}"></label><label>מסלול<select name="route"><option value="">הכול</option><option value="SMS4FREE" ${route==='SMS4FREE'?'selected':''}>SMS4FREE</option><option value="PHONE" ${route==='PHONE'?'selected':''}>טלפון אישי</option></select></label><button>סנן</button><a class="button" href="/admin/sms/export.csv?${smsEsc(downloadParams.toString())}">ייצוא CSV</a></form></section><div class="cards"><div class="card">הודעות מקור<b>${number(summary?.messages)}</b></div><div class="card">נמענים (שליחות)<b>${number(summary?.recipients)}</b></div><div class="card">יחידות לחיוב<b>${number(summary?.units)}</b></div><div class="card">עלות משוערת<b>₪${money(summary?.cost)}</b></div><div class="card">נשלחו ב־SMS4FREE<b>${number(summary?.provider_messages)}</b></div><div class="card">נשלחו בטלפון אישי<b>${number(summary?.phone_messages)}</b></div></div><section class="scroll"><table><thead><tr><th>תאריך ושעה</th><th>שולח</th><th>תוכן ההודעה</th><th>תווים</th><th>נמענים</th><th>יחידות</th><th>מסלול</th><th>מצב</th><th>עלות משוערת</th></tr></thead><tbody>${table||'<tr><td colspan="9">אין הודעות בטווח הנבחר.</td></tr>'}</tbody></table></section><div class="footer">עמוד ${page} מתוך ${Math.max(1,Math.ceil(total/50))} ${page>1?`<a href="${smsEsc(linkPage(page-1))}">הקודם</a>`:''} ${page*50<total?`<a href="${smsEsc(linkPage(page+1))}">הבא</a>`:''}</div><p class="muted">אבטחה: העמוד מוגן בסיסמה; מומלץ להגביל גם באמצעות Cloudflare Access. לא נרשמות כאן הודעות היסטוריות.</p></main></body></html>`;
  return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"}});
}
