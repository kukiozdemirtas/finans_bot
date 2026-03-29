const https = require("https");
const http = require("http");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const PORT = process.env.PORT || 3000;

const SYSTEM_PROMPT = `Türkiye odaklı finansal piyasa analistisin. Kullanıcı bir haber veya gelişme yazar. Önce web'de ara, güncel bağlamı bul, sonra şu 8 varlığı analiz et: USD/TRY, EUR/TRY, Altın(TRY), BIST100, Bankacılık, Gümüş, Bitcoin, Brent.

Kurallar:
- Web'de bulduğun güncel bilgiyi kullan, eğitim verisine değil gerçek haberlere dayan
- Bir varlıktaki hareket diğerini mekanik olarak etkilemiyorsa NEUTRAL kullan
- Korelasyon kalıplarını nedensellik olarak sunma
- Haberin doğrudan etkisiyle ikincil/varsayımsal etkileri ayır, varsayımsa "Varsayım:" yaz
- Sürpriz mi beklenen mi belirt
- Spekülatif fiyat tahmini yapma

Web araması yaptıktan SONRA SADECE JSON döndür. Hiçbir açıklama, giriş veya kapanış yazma. Direkt { ile başla:
{
  "sentiment": "POZİTİF|NEGATİF|KARMA|NÖTR",
  "surprise": "SÜRPRIZ|BEKLENİYORDU|BELİRSİZ",
  "summary": "güncel bağlamla özet ve piyasa beklentisiyle farkı (2 cümle)",
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
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" }
        }
      ],
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search"
        }
      ],
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
        "anthropic-beta": "prompt-caching-2024-07-31",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          console.log("Claude raw response:", data.substring(0, 400));
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error("Claude API hatası: " + parsed.error.message));
            return;
          }
          // Cache kullanım bilgisini logla
          const usage = parsed.usage || {};
          console.log(`Cache: write=${usage.cache_creation_input_tokens||0}, read=${usage.cache_read_input_tokens||0}`);

          const textBlocks = (parsed.content || []).filter(b => b.type === "text");
          let result = null;
          for (let i = textBlocks.length - 1; i >= 0; i--) {
            const raw = textBlocks[i].text;
            const match = raw.match(/\{[\s\S]*\}/);
            if (match) {
              try { result = JSON.parse(match[0]); break; } catch(e) { continue; }
            }
          }
          if (!result) throw new Error("JSON blogu bulunamadi");
          resolve(result);
        } catch (e) {
          console.error("Parse hatası:", e.message, "Data:", data.substring(0, 600));
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
  msg += `🌐 Güncel web verisiyle analiz edildi.\n`;
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

async function sendLongMessage(chatId, text) {
  const MAX = 4000;
  if (text.length <= MAX) {
    return telegramRequest("sendMessage", { chat_id: chatId, text: text });
  }
  const parts = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX) {
      parts.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", MAX);
    if (splitAt === -1) splitAt = MAX;
    parts.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trim();
  }
  for (const part of parts) {
    await telegramRequest("sendMessage", { chat_id: chatId, text: part });
  }
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
      `📊 Finans Analiz Botu\n\nMerhaba! Bir haber yazın, güncel web verisiyle 8 varlık için analiz edeyim.\n\nÖrnek:\nBTC değer kaybediyor\nTCMB faizi 250 baz puan artırdı\nFed şahin ton kullandı`
    );
    return;
  }

  if (text.length < 5) {
    await sendMessage(chatId, "Lütfen haberi biraz daha detaylı yazın.");
    return;
  }

  await sendTyping(chatId);

  try {
    console.log("Claude analizi başlıyor (web search + cache aktif)...");
    const result = await analyzeWithClaude(text);
    console.log("Analiz tamamlandı, gönderiliyor...");
    const formatted = formatAnalysis(text, result);
    await sendLongMessage(chatId, formatted);
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
