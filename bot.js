const https = require("https");
const http = require("http");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const PORT = process.env.PORT || 3000;

const SYSTEM_PROMPT = `Sen Türkiye odaklı deneyimli bir finansal piyasa analistisin.
Kullanıcı sana bir haber veya piyasa gelişmesi yazacak.
Bu haberin şu varlık sınıflarına etkisini derinlemesine analiz et:
USD/TRY, EUR/TRY, Altın (TRY), BIST100, Bankacılık hisseleri, Gümüş, Bitcoin, Brent Petrol

ÖNEMLİ KURALLAR:
- Haberde neden belirtilmemişse, varsayımını açıkça "Varsayım:" diye işaretle
- Sürpriz mi yoksa beklenen bir gelişme mi olduğunu mutlaka belirt
- Her etkiyi kısa vade (saatler-günler) ve orta vade (haftalar) olarak ayır
- Etki şiddetini belirt: güçlü / orta / zayıf
- Zincirleme etkileri göster (örn. altın düşüyorsa gümüş, madencilik hisseleri)

SADECE aşağıdaki JSON formatında yanıt ver, başka hiçbir şey yazma:
{
  "sentiment": "POZİTİF veya NEGATİF veya KARMA veya NÖTR",
  "surprise_factor": "SÜRPRIZ veya BEKLENİYORDU veya BELİRSİZ",
  "summary": "Haberin özeti, neden önemli olduğu ve piyasanın önceki beklentisiyle farkı (2-3 cümle)",
  "impacts": [
    {
      "asset": "USD/TRY",
      "direction": "UP veya DOWN veya NEUTRAL",
      "strength": "GÜÇLÜ veya ORTA veya ZAYIF",
      "short_term": "Saatler-günler içinde beklenen hareket ve nedeni (1 cümle)",
      "mid_term": "Haftalar içinde beklenen seyir (1 cümle)",
      "until_when": "Bu etki ne zamana kadar sürer, hangi gelişme yönü değiştirir (1 cümle)",
      "investor_behavior": "Bu haberde yatırımcıların büyük ihtimalle ne yapacağı: alır / satar / bekler / pozisyon azaltır (1-2 cümle)",
      "correlated_assets": "Bu varlıktan etkilenecek diğer assetler (varsa, 1 cümle)"
    }
  ],
  "chain_effects": "Zincirleme etki özeti — bir varlıktaki hareketin diğerlerine nasıl yansıyacağı (2-3 cümle)",
  "causation_note": "Bu ilişki gerçek nedensellik mi korelasyon mu, sınırları neler (1-2 cümle)"
}

Her varlık için impact yaz. NEUTRAL kullanmaktan çekinme. Spekülatif fiyat tahmini yapma, mekanizmayı açıkla.`;

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

  const surpriseEmoji = {
    "SÜRPRIZ": "⚡", "BEKLENİYORDU": "📌", "BELİRSİZ": "❓"
  }[result.surprise_factor] || "❓";

  const dirEmoji = { UP: "↑", DOWN: "↓", NEUTRAL: "→" };
  const dirLabel = { UP: "YÜKSELİŞ", DOWN: "DÜŞÜŞ", NEUTRAL: "NÖTR" };
  const strengthLabel = { "GÜÇLÜ": "●●●", "ORTA": "●●○", "ZAYIF": "●○○" };

  let msg = `${sentimentEmoji} ${result.sentiment}  ${surpriseEmoji} ${result.surprise_factor}\n`;
  msg += `📰 "${news}"\n\n`;
  msg += `GENEL YORUM\n${result.summary}\n\n`;
  msg += `━━━━━━━━━━━━━━━━━━\n`;
  msg += `VARLIK ETKİLERİ\n\n`;

  for (const imp of result.impacts || []) {
    const e = dirEmoji[imp.direction] || "→";
    const l = dirLabel[imp.direction] || "NÖTR";
    const s = strengthLabel[imp.strength] || "●○○";
    msg += `${e} ${imp.asset} — ${l} ${s}\n`;
    if (imp.short_term) msg += `  Kısa: ${imp.short_term}\n`;
    if (imp.mid_term)   msg += `  Orta: ${imp.mid_term}\n`;
    if (imp.until_when) msg += `  Ne zamana kadar: ${imp.until_when}\n`;
    if (imp.investor_behavior) msg += `  Yatırımcı: ${imp.investor_behavior}\n`;
    if (imp.correlated_assets) msg += `  Korele: ${imp.correlated_assets}\n`;
    msg += `\n`;
  }

  if (result.chain_effects) {
    msg += `━━━━━━━━━━━━━━━━━━\n`;
    msg += `ZİNCİRLEME ETKİ\n${result.chain_effects}\n\n`;
  }

  msg += `━━━━━━━━━━━━━━━━━━\n`;
  msg += `KORELASYON NOTU\n⚠️ ${result.causation_note}\n\n`;
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
