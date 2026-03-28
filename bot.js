const https = require("https");
const http = require("http");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const PORT = process.env.PORT || 3000;

const SYSTEM_PROMPT = `Türkiye odaklı finansal piyasa analistisin. Haber gelince şu 8 varlığı analiz et: USD/TRY, EUR/TRY, Altın(TRY), BIST100, Bankacılık, Gümüş, Bitcoin, Brent.

Kurallar: Neden bilinmiyorsa "Varsayım:" ekle. Sürpriz mi beklenen mi belirt. Spekülatif fiyat verme.

SADECE JSON döndür, başka hiçbir şey yazma:
{
  "sentiment": "POZİTİF|NEGATİF|KARMA|NÖTR",
  "surprise": "SÜRPRIZ|BEKLENİYORDU|BELİRSİZ",
  "summary": "özet ve piyasa beklentisiyle farkı (2 cümle)",
  "impacts": [
    {
      "asset": "USD/TRY",
      "direction": "UP|DOWN|NEUTRAL",
      "strength": "GÜÇLÜ|ORTA|ZAYIF",
      "analysis": "Kısa(saatler): ... | Orta(haftalar): ... | Ne zamana kadar: ... | Yatırımcı: ... | Korele: ..."
    }
  ],
  "chain": "zincirleme etki özeti (1-2 cümle)",
  "causation": "nedensellik mi korelasyon mu (1 cümle)"
}`;

async function analyzeWithClaude(newsText) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 3000,
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
          console.log("Claude raw response:", data.substring(0, 300));
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error("Claude API hatası: " + parsed.error.message));
            return;
          }
          const text = parsed.content?.[0]?.text || "";
          const result = JSON.parse(text.replace(/```json|```/g, "").trim());
          resolve(result);
        } catch (e) {
          console.error("Parse hatası:", e.message, "Data:", data.substring(0, 500));
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

  const surpriseEmoji = {
    "SÜRPRIZ": "⚡", "BEKLENİYORDU": "📌", "BELİRSİZ": "❓"
  }[result.surprise] || "❓";

  const dirEmoji = { UP: "↑", DOWN: "↓", NEUTRAL: "→" };
  const dirLabel = { UP: "YÜKSELİŞ", DOWN: "DÜŞÜŞ", NEUTRAL: "NÖTR" };
  const strengthLabel = { "GÜÇLÜ": "●●●", "ORTA": "●●○", "ZAYIF": "●○○" };

  let msg = `${sentimentEmoji} ${result.sentiment}  ${surpriseEmoji} ${result.surprise}\n`;
  msg += `📰 "${news}"\n\n`;
  msg += `GENEL YORUM\n${result.summary}\n\n`;
  msg += `━━━━━━━━━━━━━━━━━━\n`;
  msg += `VARLIK ETKİLERİ\n\n`;

  for (const imp of result.impacts || []) {
    const e = dirEmoji[imp.direction] || "→";
    const l = dirLabel[imp.direction] || "NÖTR";
    const s = strengthLabel[imp.strength] || "●○○";
    msg += `${e} ${imp.asset} — ${l} ${s}\n`;
    if (imp.analysis) msg += `${imp.analysis}\n`;
    msg += `\n`;
  }

  if (result.chain) {
    msg += `━━━━━━━━━━━━━━━━━━\n`;
    msg += `ZİNCİRLEME ETKİ\n${result.chain}\n\n`;
  }

  msg += `━━━━━━━━━━━━━━━━━━\n`;
  msg += `KORELASYON NOTU\n⚠️ ${result.causation}\n\n`;
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
  return telegramRequest("sendMessage", { chat_id: chatId, text: text });
}

async function sendTyping(chatId) {
  return telegramRequest("sendChatAction", { chat_id: chatId, action: "typing" });
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = message.text?.trim();
  if (!text) return;

  console.log(`Mesaj geldi [${chatId}]: ${text.substring(0, 50)}`);

  if (text === "/start") {
    await sendMessage(chatId,
      `📊 Finans Analiz Botu\n\nMerhaba! Bir haber yazın, 8 varlık sınıfı için analiz edeyim.\n\nÖrnek:\nTCMB faizi 250 baz puan artırdı\nFed faiz kararında şahin ton kullandı\nEnflasyon beklentinin altında geldi`
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
    console.log("Analiz tamamlandı, gönderiliyor...");
    const formatted = formatAnalysis(text, result);
    await sendMessage(chatId, formatted);
    console.log("Mesaj gönderildi.");
  } catch (err) {
    console.error("Hata:", err.message);
    await sendMessage(chatId, `Analiz hatası: ${err.message}`);
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const update = JSON.parse(body);
        console.log("Webhook:", JSON.stringify(update).substring(0, 100));
        if (update.message) await handleMessage(update.message);
      } catch (e) {
        console.error("Webhook hatası:", e.message);
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
