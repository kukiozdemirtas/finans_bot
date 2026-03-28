const https = require("https");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const PORT = process.env.PORT || 3000;

// ─── CLAUDE ANALİZ ───────────────────────────────────────────────
const SYSTEM_PROMPT = `Sen Türkiye odaklı bir finansal piyasa analistisin.
Kullanıcı sana bir haber veya gelişme yazacak.
Bu haberin şu varlık sınıflarına olası etkisini analiz et:
USD/TRY, EUR/TRY, Altın (TRY), BIST100, Bankacılık hisseleri, Gümüş, Bitcoin, Brent Petrol

SADECE aşağıdaki JSON formatında yanıt ver, başka hiçbir şey yazma:
{
  "sentiment": "POZİTİF" | "NEGATİF" | "KARMA" | "NÖTR",
  "summary": "2-3 cümle genel yorum (Türkçe)",
  "impacts": [
    { "asset": "USD/TRY", "direction": "UP" | "DOWN" | "NEUTRAL", "reason": "kısa mekanizma (1 cümle)" }
  ],
  "causation_note": "Korelasyon mu nedensellik mi? (1-2 cümle)"
}

Her varlık için impact yaz. NEUTRAL kullanmaktan çekinme. Mekanizmayı açıkla, fiyat tahmini yapma.`;

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
          const parsed = JSON.parse(data);
          const text = parsed.content?.[0]?.text || "";
          const result = JSON.parse(text.replace(/```json|```/g, "").trim());
          resolve(result);
        } catch (e) {
          reject(new Error("Claude yanıtı ayrıştırılamadı"));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── MESAJ FORMATLAMA ─────────────────────────────────────────────
function formatAnalysis(news, result) {
  const sentimentEmoji = {
    "POZİTİF": "📈",
    "NEGATİF": "📉",
    "KARMA": "↔️",
    "NÖTR": "➡️",
  }[result.sentiment] || "📊";

  const dirEmoji = { UP: "↑", DOWN: "↓", NEUTRAL: "→" };
  const dirLabel = { UP: "YÜKSELİŞ", DOWN: "DÜŞÜŞ", NEUTRAL: "NÖTR" };

  let msg = `${sentimentEmoji} *${result.sentiment}*\n`;
  msg += `📰 _${escapeMarkdown(news)}_\n\n`;
  msg += `*Genel Yorum*\n${escapeMarkdown(result.summary)}\n\n`;
  msg += `*Varlık Etkileri*\n`;

  for (const imp of result.impacts || []) {
    const e = dirEmoji[imp.direction] || "→";
    const l = dirLabel[imp.direction] || "NÖTR";
    msg += `${e} *${imp.asset}* — ${l}\n`;
    msg += `  _${escapeMarkdown(imp.reason)}_\n`;
  }

  msg += `\n*Korelasyon Notu*\n⚠️ _${escapeMarkdown(result.causation_note)}_\n\n`;
  msg += `─────────────────\n`;
  msg += `_⚠️ Bilgi amaçlıdır, yatırım tavsiyesi değildir._`;

  return msg;
}

function escapeMarkdown(text) {
  if (!text) return "";
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

// ─── TELEGRAM API ─────────────────────────────────────────────────
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
      res.on("end", () => resolve(JSON.parse(d)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function sendMessage(chatId, text, parseMode = "MarkdownV2") {
  return telegramRequest("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
  });
}

async function sendTyping(chatId) {
  return telegramRequest("sendChatAction", {
    chat_id: chatId,
    action: "typing",
  });
}

// ─── MESAJ İŞLEME ────────────────────────────────────────────────
async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = message.text?.trim();

  if (!text) return;

  // Komutlar
  if (text === "/start") {
    await sendMessage(
      chatId,
      `📊 *Finans Analiz Botu*\n\nMerhaba\\! Bir haber veya piyasa gelişmesi yazın, hangi varlıkları nasıl etkileyebileceğini analiz edeyim\\.\n\n*Örnek:*\n_TCMB faizi 250 baz puan artırdı_\n_Fed toplantısında faiz sabit kaldı_\n_Enflasyon beklentinin altında geldi_\n\nYazın, analiz edeyim\\! 🚀`,
      "MarkdownV2"
    );
    return;
  }

  if (text === "/yardim" || text === "/help") {
    await sendMessage(
      chatId,
      `ℹ️ *Nasıl Kullanılır*\n\nHerhangi bir finansal haber veya gelişmeyi direkt yazın\\.\n\nBot şu varlıkları analiz eder:\n• USD/TRY · EUR/TRY\n• Altın · Gümüş\n• BIST100 · Bankacılık\n• Bitcoin · Brent Petrol\n\nHer analiz için etki yönü ve mekanizma açıklaması alırsınız\\.`,
      "MarkdownV2"
    );
    return;
  }

  // Kısa mesajlar
  if (text.length < 10) {
    await sendMessage(chatId, `Lütfen analiz etmemi istediğiniz haberi biraz daha detaylı yazın\\.`, "MarkdownV2");
    return;
  }

  // Analiz
  await sendTyping(chatId);

  try {
    const result = await analyzeWithClaude(text);
    const formatted = formatAnalysis(text, result);
    await sendMessage(chatId, formatted);
  } catch (err) {
    console.error("Analiz hatası:", err.message);
    await sendMessage(
      chatId,
      `❌ Analiz sırasında bir hata oluştu\\. Lütfen tekrar deneyin\\.`,
      "MarkdownV2"
    );
  }
}

// ─── WEBHOOK SERVER ───────────────────────────────────────────────
const http = require("http");

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const update = JSON.parse(body);
        if (update.message) {
          await handleMessage(update.message);
        }
      } catch (e) {
        console.error("Webhook hatası:", e.message);
      }
      res.writeHead(200);
      res.end("OK");
    });
  } else {
    res.writeHead(200);
    res.end("Finans Bot çalışıyor ✓");
  }
});

server.listen(PORT, () => {
  console.log(`Bot ${PORT} portunda çalışıyor`);
});
