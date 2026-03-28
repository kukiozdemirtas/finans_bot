const https = require("https");
const http = require("http");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const PORT = process.env.PORT || 3000;

const SYSTEM_PROMPT = `Sen Türkiye odaklı bir finansal piyasa analistisin.
Kullanıcı sana bir haber veya gelişme yazacak.
Bu haberin şu varlık sınıflarına olası etkisini analiz et:
USD/TRY, EUR/TRY, Altın (TRY), BIST100, Bankacılık hisseleri, Gümüş, Bitcoin, Brent Petrol

SADECE aşağıdaki JSON formatında yanıt ver, başka hiçbir şey yazma:
{
  "sentiment": "POZİTİF veya NEGATİF veya KARMA veya NÖTR",
  "summary": "2-3 cümle genel yorum (Türkçe)",
  "impacts": [
    { "asset": "USD/TRY", "direction": "UP veya DOWN veya NEUTRAL", "reason": "kısa mekanizma (1 cümle)" }
  ],
  "causation_note": "Korelasyon mu nedensellik mi? (1-2 cümle)"
}

Her varlık için impact yaz. NEUTRAL kullanmaktan çekinme.`;

async function analyzeWithClaude(newsText) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: newsText }],
    });

    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          console.log("Claude raw response:", data.substring(0, 200));
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error("Claude API hatası: " + parsed.error.message));
            return;
          }
          const text = parsed.content?.[0]?.text || "";
          const result = JSON.parse(text.replace(/```json|```/g, "").trim());
          resolve(result);
        } catch (e) {
          console.error("Parse hatası:", e.message, "Data:", data.substring(0, 300));
          reject(new Error("Yanıt ayrıştırılamadı: " + e.message));
        }
      });
    });

    req.on("error", (e) => {
      console.error("Claude request hatası:", e.message);
      reject(e);
    });
    req.write(body);
    req.end();
  });
}

function formatAnalysis(news, result) {
  const sentimentEmoji = {
    "POZİTİF": "📈", "NEGATİF": "📉", "KARMA": "↔️", "NÖTR": "➡️"
  }[result.sentiment] || "📊";

  const dirEmoji = { UP: "↑", DOWN: "↓", NEUTRAL: "→" };
  const dirLabel = { UP: "YÜKSELİŞ", DOWN: "DÜŞÜŞ", NEUTRAL: "NÖTR" };

  let msg = `${sentimentEmoji} ${result.sentiment}\n`;
  msg += `📰 "${news}"\n\n`;
  msg += `GENEL YORUM\n${result.summary}\n\n`;
  msg += `VARLIK ETKİLERİ\n`;

  for (const imp of result.impacts || []) {
    const e = dirEmoji[imp.direction] || "→";
    const l = dirLabel[imp.direction] || "NÖTR";
    msg += `${e} ${imp.asset} — ${l}\n`;
    msg += `   ${imp.reason}\n`;
  }

  msg += `\nKORELASYON NOTU\n⚠️ ${result.causation_note}\n\n`;
  msg += `──────────────────\n`;
  msg += `⚠️ Bilgi amaçlıdır, yatırım tavsiyesi değildir.`;

  return msg;
}

function telegramRequest(method, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/${method}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        const result = JSON.parse(d);
        if (!result.ok) {
          console.error("Telegram API hatası:", JSON.stringify(result));
        }
        resolve(result);
      });
    });
    req.on("error", (e) => {
      console.error("Telegram request hatası:", e.message);
      reject(e);
    });
    req.write(body);
    req.end();
  });
}

async function sendMessage(chatId, text) {
  return telegramRequest("sendMessage", {
    chat_id: chatId,
    text: text,
  });
}

async function sendTyping(chatId) {
  return telegramRequest("sendChatAction", {
    chat_id: chatId,
    action: "typing",
  });
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = message.text?.trim();
  if (!text) return;

  console.log(`Mesaj geldi [${chatId}]: ${text.substring(0, 50)}`);

  if (text === "/start") {
    await sendMessage(chatId,
      `📊 Finans Analiz Botu\n\nMerhaba! Bir haber veya piyasa gelişmesi yazın, hangi varlıkları nasıl etkileyebileceğini analiz edeyim.\n\nÖrnek:\nTCMB faizi 250 baz puan artırdı\nFed toplantısında faiz sabit kaldı\n\nYazın, analiz edeyim! 🚀`
    );
    return;
  }

  if (text.length < 10) {
    await sendMessage(chatId, "Lütfen haberi biraz daha detaylı yazın.");
    return;
  }

  await sendTyping(chatId);

  try {
    console.log("Claude analizi başlıyor...");
    const result = await analyzeWithClaude(text);
    console.log("Claude analizi tamamlandı, mesaj gönderiliyor...");
    const formatted = formatAnalysis(text, result);
    await sendMessage(chatId, formatted);
    console.log("Mesaj gönderildi.");
  } catch (err) {
    console.error("Hata:", err.message);
    await sendMessage(chatId, `Analiz sırasında hata oluştu: ${err.message}`);
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const update = JSON.parse(body);
        console.log("Webhook update:", JSON.stringify(update).substring(0, 100));
        if (update.message) {
          await handleMessage(update.message);
        }
      } catch (e) {
        console.error("Webhook parse hatası:", e.message);
      }
      res.writeHead(200);
      res.end("OK");
    });
  } else {
    res.writeHead(200);
    res.end("Finans Bot çalışıyor");
  }
});

server.listen(PORT, () => {
  console.log(`Bot ${PORT} portunda çalışıyor`);
});
