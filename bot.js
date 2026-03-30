const https = require("https");
const http = require("http");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CHAT_ID = process.env.CHAT_ID || "1551586121";
const CHAT_ID_2 = process.env.CHAT_ID_2 || "8587386856";
const CHAT_ID_3 = process.env.CHAT_ID_3 || "1197856801";
const ALL_CHATS = [CHAT_ID, CHAT_ID_2, CHAT_ID_3];

// ─── CACHE ────────────────────────────────────────────────────────
const briefingCache = {};
function getCacheKey(type) { return new Date().toDateString() + '_' + type; }
function getFromCache(type) {
  const entry = briefingCache[getCacheKey(type)];
  if (!entry) return null;
  const h = new Date().getHours();
  const expiry = { morning:10, opening:16, wallst:19, closing:24, weekend:24 };
  return h < (expiry[type] || 24) ? entry : null;
}
function saveToCache(type, text) {
  briefingCache[getCacheKey(type)] = text;
  console.log('Cache kaydedildi:', type);
}

const PORT = process.env.PORT || 3000;

// ─── PROMPTS ──────────────────────────────────────────────────────

const BRIEFING_SYSTEM = `Sen Türkiye odaklı deneyimli bir finansal piyasa analistisin.
Web'den güncel veri çekerek aşağıdaki 6 başlık altında kısa ve net bir piyasa brifing hazırla.
Her başlık altında mevcut seviyeler, yön ve kısa yorum olsun.
Türkiye yatırımcısı perspektifinden yaz.
Korelasyon kalıplarını nedensellik olarak sunma.
Cite tag, kaynak tag veya HTML kullanma.
HABER GÜNCELLİĞİ KURALI:
- Sadece son 48 saatin haberlerini "güncel" olarak kabul et
- 48 saatten eski haberler varsa "ESKİ BAĞLAM (tarih):" olarak işaretle
- "Bugün", "şu an", "güncel" ifadelerini sadece son 48 saat için kullan
- Web aramasında tarihi her zaman kontrol et, eski haberi yeni gibi sunma

Brifing metnini yazdıktan sonra EN SONA bu satırı ekle (başka hiçbir şey ekleme):
PRICES_JSON:{"updated_at":"HH:MM","prices":[{"asset":"Altın","change_pct":0},{"asset":"Gümüş","change_pct":0},{"asset":"USD/TRY","change_pct":0},{"asset":"EUR/TRY","change_pct":0},{"asset":"BIST100","change_pct":0},{"asset":"Bitcoin","change_pct":0},{"asset":"Ethereum","change_pct":0},{"asset":"Brent Petrol","change_pct":0},{"asset":"S&P 500","change_pct":0},{"asset":"Nasdaq","change_pct":0},{"asset":"Para Piyasası Fonu","change_pct":0.11},{"asset":"TL Mevduat","change_pct":0.12}]}
0 olan değerleri web'den bulduğun gerçek değerlerle değiştir. HH:MM yerine şu anki saati yaz.

FORMAT (tam olarak bu başlıkları kullan):
💱 KUR & PARA POLİTİKASI
[USD/TRY, EUR/TRY seviyeleri, TCMB durumu, kısa yorum]

🥇 EMTİA
[Altın, Gümüş, Brent seviyeleri, trend ve neden]

📈 BORSA
[BIST100, S&P500, DAX durumu, öne çıkan sektör/hisse]

₿ KRİPTO
[BTC, ETH hareketi, genel risk iştahı]

🌍 JEOPOLİTİK & MAKRO RİSK
[Gündemdeki jeopolitik gelişme, makro risk faktörü]

⚠️ BUGÜN DİKKAT
[O gün açıklanacak önemli veri, karar veya toplantı]

Sonuna şunu ekle:
─────────────────
⚠️ Bilgi amaçlıdır, yatırım tavsiyesi değildir.`;

const ANALYSIS_SYSTEM = `Türkiye odaklı finansal piyasa analistisin. Kullanıcı bir haber yazar.
Önce web'den güncel makro bağlamı çek (DXY, altın, Brent, BIST100 seviyeleri), sonra haberin 8 varlığa etkisini analiz et:
USD/TRY, EUR/TRY, Altın(TRY), BIST100, Bankacılık, Gümüş, Bitcoin, Brent

Kurallar:
- Güncel makro rejimi bilerek analiz yap (dolar güçlü mü zayıf mı, risk-on mu risk-off mu)
- Korelasyon kalıplarını nedensellik olarak sunma
- Beklenen korelasyon tersine dönüyorsa bunu açıkça belirt
- Türkiye aktarım zincirini kur: DXY → USD/TRY → ithalat maliyeti → enflasyon → BIST baskısı
- Varsayım yapıyorsan "Varsayım:" yaz
- Cite tag, kaynak tag veya HTML kullanma
- Spekülatif fiyat tahmini yapma
HABER GÜNCELLİĞİ KURALI:
- Sadece son 48 saatin haberlerini "güncel" olarak kabul et
- 48 saatten eski haberler varsa "ESKİ BAĞLAM (tarih):" olarak işaretle
- "Bugün", "şu an", "güncel" ifadelerini sadece son 48 saat için kullan
- Web aramasında tarihi her zaman kontrol et, eski haberi yeni gibi sunma

Web aramasından SONRA SADECE JSON döndür, direkt { ile başla:
{
  "sentiment": "POZİTİF|NEGATİF|KARMA|NÖTR",
  "surprise": "SÜRPRIZ|BEKLENİYORDU|BELİRSİZ",
  "macro_context": "Güncel makro rejim özeti: DXY seviyesi, altın trendi, risk iştahı durumu (1-2 cümle)",
  "summary": "Haberin özeti ve mevcut makro bağlamla ilişkisi (2 cümle)",
  "impacts": [
    {
      "asset": "USD/TRY",
      "direction": "UP|DOWN|NEUTRAL",
      "strength": "GÜÇLÜ|ORTA|ZAYIF",
      "analysis": "Kısa(saatler): ... | Orta(haftalar): ... | Ne zamana kadar: ... | Yatırımcı: ..."
    }
  ],
  "chain": "Türkiye aktarım zinciri: bu haber USD/TRY → enflasyon → BIST üzerinde nasıl ilerler (1-2 cümle)",
  "causation": "Nedensellik mi korelasyon mu, sınırları neler (1 cümle)"
}`;

// ─── CLAUDE API ────────────────────────────────────────────────────

async function callClaude(systemPrompt, userMessage, useWebSearch = true) {
  return new Promise((resolve, reject) => {
    const payload = {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 3000,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userMessage }],
    };
    if (useWebSearch) {
      payload.tools = [{ type: "web_search_20250305", name: "web_search" }];
    }

    const body = JSON.stringify(payload);
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
          const parsed = JSON.parse(data);
          if (parsed.error) { reject(new Error(parsed.error.message)); return; }
          const usage = parsed.usage || {};
          console.log(`Cache: write=${usage.cache_creation_input_tokens||0}, read=${usage.cache_read_input_tokens||0}`);
          const textBlocks = (parsed.content || []).filter(b => b.type === "text");
          resolve(textBlocks.map(b => b.text).join("\n"));
        } catch (e) {
          console.error("Parse hatası:", e.message, data.substring(0, 300));
          reject(new Error("API yanıtı ayrıştırılamadı"));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── BRİFİNG ──────────────────────────────────────────────────────

const BRIEFING_CONTEXTS = {
  morning:  "Şu anki saat sabah 07:30 Türkiye saati. Gece boyunca ve Asya seansında yaşanan gelişmeleri, altın/kripto/Brent hareketlerini ve günün ekonomik takvimini analiz et.",
  opening:  "Şu anki saat 10:30 Türkiye saati. BIST100 açılıştan bu yana nasıl seyrediyor, Avrupa piyasaları açıldı mı, USD/TRY açılış seviyesi ne, sabah TCMB/KAP duyurusu var mı?",
  wallst:   "Şu anki saat 16:00 Türkiye saati. Wall Street vadeli işlemleri nasıl, BIST kapanışa yaklaşırken ne görüyoruz, Brent ve altın öğleden sonra ne yaptı, ABD'den veri veya Fed konuşması var mı?",
  closing:  "Şu anki saat 19:30 Türkiye saati. BIST bugün nasıl kapandı, Wall Street ilk saatini nasıl geçiriyor, günün kazananı ve kaybedeni ne oldu, yarına hangi riskler taşınıyor?",
};

async function sendBriefing(type) {
  const context = BRIEFING_CONTEXTS[type];
  const label = { morning:"☀️ SABAH", opening:"⚡ AÇILIŞ", wallst:"🌆 WALL STREET", closing:"🌙 KAPANIŞ" }[type];

  // Cache kontrolü — aynı gün aynı tür varsa cache'ten gönder
  const cached = getFromCache(type);
  if (cached) {
    console.log('Cache hit:', type);
    for (const cid of ALL_CHATS) await sendLongMessage(cid, cached + '\n\n📦 Cache\'ten geldi.');
    return;
  }

  console.log(label + ' brifing hazırlanıyor...');
  try {
    for (const cid of ALL_CHATS) await sendMessage(cid, label + ' BRİFİNG hazırlanıyor... 🔍');
    const text = await callClaude(BRIEFING_SYSTEM, context, true);
    const timeStr = new Date().toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'});

    // Fiyat verisini çıkar ve kaydet
    const priceMatch = text.match(/PRICES_JSON:(\{[\s\S]*?\})/);
    if (priceMatch) {
      try {
        const priceData = JSON.parse(priceMatch[1].trim());
        setPrices(priceData);
        console.log('Fiyat store güncellendi:', priceData.updated_at);
      } catch(e) { console.error('Fiyat parse hatası:', e.message); }
    } else {
      console.log('PRICES_JSON bloğu bulunamadı.');
    }

    // PRICES_JSON satırını mesajdan kaldır
    const cleanText = text.replace(/PRICES_JSON:\{[\s\S]*?\}/g, '').trim();
    const fullMsg = label + ' BRİFİNG ' + timeStr + '\n\n' + cleanText;

    saveToCache(type, fullMsg);
    for (const cid of ALL_CHATS) await sendLongMessage(cid, fullMsg);
    console.log(label + ' brifing gönderildi.');
  } catch (err) {
    console.error(label + ' brifing hatası:', err.message);
    await sendMessage(CHAT_ID, label + ' brifing hazırlanamadı: ' + err.message);
  }
}

// ─── HABER ANALİZİ ────────────────────────────────────────────────

function formatAnalysis(news, result) {
  const sentimentEmoji = { "POZİTİF":"📈","NEGATİF":"📉","KARMA":"↔️","NÖTR":"➡️" }[result.sentiment] || "📊";
  const surpriseEmoji  = { "SÜRPRIZ":"⚡","BEKLENİYORDU":"📌","BELİRSİZ":"❓" }[result.surprise] || "❓";
  const dirEmoji  = { UP:"↑", DOWN:"↓", NEUTRAL:"→" };
  const dirLabel  = { UP:"YÜKSELİŞ", DOWN:"DÜŞÜŞ", NEUTRAL:"NÖTR" };
  const strLabel  = { "GÜÇLÜ":"●●●","ORTA":"●●○","ZAYIF":"●○○" };

  let msg = `${sentimentEmoji} ${result.sentiment}  ${surpriseEmoji} ${result.surprise}\n`;
  msg += `📰 "${news}"\n\n`;
  if (result.macro_context) msg += `🌐 MAKRO BAĞLAM\n${result.macro_context}\n\n`;
  msg += `GENEL YORUM\n${result.summary}\n\n`;
  msg += `━━━━━━━━━━━━━━━━━━\nVARLIK ETKİLERİ\n\n`;

  for (const imp of result.impacts || []) {
    const e = dirEmoji[imp.direction] || "→";
    const l = dirLabel[imp.direction] || "NÖTR";
    const s = strLabel[imp.strength] || "●○○";
    msg += `${e} ${imp.asset} — ${l} ${s}\n${imp.analysis || ""}\n\n`;
  }

  if (result.chain) msg += `━━━━━━━━━━━━━━━━━━\n🔗 TÜRKİYE AKTARİM ZİNCİRİ\n${result.chain}\n\n`;
  msg += `━━━━━━━━━━━━━━━━━━\n⚠️ KORELASYON NOTU\n${result.causation}\n\n`;
  msg += `🌐 Güncel web verisiyle analiz edildi.\n`;
  msg += `⚠️ Bilgi amaçlıdır, yatırım tavsiyesi değildir.`;
  return msg;
}

async function analyzeNews(chatId, newsText) {
  await sendTyping(chatId);
  try {
    const raw = await callClaude(ANALYSIS_SYSTEM, newsText, true);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("JSON bulunamadı");
    const result = JSON.parse(match[0]);
    await sendLongMessage(chatId, formatAnalysis(newsText, result));
  } catch (err) {
    console.error("Analiz hatası:", err.message);
    await sendMessage(chatId, `Analiz hatası: ${err.message}`);
  }
}

// ─── TELEGRAM ─────────────────────────────────────────────────────

function telegramRequest(method, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/${method}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    const req = https.request(options, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        const r = JSON.parse(d);
        if (!r.ok) console.error("Telegram hatası:", JSON.stringify(r));
        resolve(r);
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function sendMessage(chatId, text) {
  return telegramRequest("sendMessage", { chat_id: chatId, text });
}

async function sendLongMessage(chatId, text) {
  const MAX = 4000;
  if (text.length <= MAX) return sendMessage(chatId, text);
  const parts = [];
  let rem = text;
  while (rem.length > 0) {
    if (rem.length <= MAX) { parts.push(rem); break; }
    let at = rem.lastIndexOf("\n", MAX);
    if (at === -1) at = MAX;
    parts.push(rem.substring(0, at));
    rem = rem.substring(at).trim();
  }
  for (const p of parts) await sendMessage(chatId, p);
}

async function sendTyping(chatId) {
  return telegramRequest("sendChatAction", { chat_id: chatId, action: "typing" });
}

// ─── MESAJ İŞLEME ────────────────────────────────────────────────

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = message.text?.trim();
  if (!text) return;
  console.log(`Mesaj geldi [${chatId}]: ${text.substring(0, 60)}`);

  if (text === "/start") {
    await sendMessage(chatId,
      `📊 Finans Analiz Botu\n\nKomutlar:\n/kuki — Güncel piyasa brifing\n/portfoy — Claude portföy kararı ve gerekçesi\n\nYa da direkt haber yazın:\nTCMB faizi artırdı\nFed şahin ton kullandı\nAltında düşüş devam ediyor`
    );
    return;
  }

  if (text === "/kuki") {
    if (isWeekend()) {
      await sendWeekendBriefing();
    } else {
      const h = new Date().getHours();
      let type = "closing";
      if (h >= 5  && h < 9)  type = "morning";
      else if (h >= 9  && h < 13) type = "opening";
      else if (h >= 13 && h < 18) type = "wallst";
      await sendBriefing(type);
    }
    return;
  }

  if (text === "/portfoy") {
    await sendTyping(chatId);
    try {
      await sendMessage(chatId, "📊 Portföy kararı getiriliyor...");
      const result = await getPortfolioDecision();
      await sendLongMessage(chatId, formatPortfolioMessage(result));
    } catch(err) {
      await sendMessage(chatId, "Portföy hatası: " + err.message);
    }
    return;
  }

  if (text.length < 5) {
    await sendMessage(chatId, "Lütfen haberi daha detaylı yazın.");
    return;
  }

  await analyzeNews(chatId, text);
}

// ─── ZAMANLAYICI ──────────────────────────────────────────────────


const WEEKEND_SYSTEM = `Türkiye odaklı finansal piyasa analistisin. Hafta sonu - borsalar kapalı.
Web'den güncel veri çekerek şu başlıklar altında özet hazırla:

BTC KRİPTO HAFTALIK
[BTC, ETH haftalık performans ve güncel durum]

ALTIN EMTİA HAFTALIK
[Altın, Gümüş, Brent haftalık hareket]

JEOPOLITIK & MAKRO RİSK
[Hafta sonu öne çıkan gelişmeler]

PAZARTESİ AÇILIŞINA HAZIRLIK
[Pazartesi açılışında dikkat edilmesi gereken veri, risk veya karar]

Cite tag, kaynak tag veya HTML kullanma.
Sonuna ekle: Bilgi amaçlıdır, yatırım tavsiyesi değildir.
HABER GÜNCELLİĞİ KURALI:
- Sadece son 48 saatin haberlerini "güncel" olarak kabul et
- 48 saatten eski haberler varsa "ESKİ BAĞLAM (tarih):" olarak işaretle
- "Bugün", "şu an", "güncel" ifadelerini sadece son 48 saat için kullan
- Web aramasında tarihi her zaman kontrol et, eski haberi yeni gibi sunma`;

function isWeekend() {
  const day = new Date().getDay();
  return day === 0 || day === 6;
}

async function sendWeekendBriefing() {
  console.log('Hafta sonu brifing gönderiliyor...');
  try {
    for (const cid of ALL_CHATS) await sendMessage(cid, 'HAFTA SONU BRİFİNG hazırlanıyor...');
    const text = await callClaude(WEEKEND_SYSTEM, 'Hafta sonu piyasa özeti: kripto, emtia ve pazartesi açılışına hazırlık.', true);
    const timeStr = new Date().toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'}); for (const cid of ALL_CHATS) await sendLongMessage(cid, 'HAFTA SONU BRİFİNG ' + timeStr + ' ' + text);
  } catch (err) {
    console.error('Hafta sonu brifing hatası:', err.message);
  }
}

function scheduleBriefings() {
  // TR saati = UTC+3
  const schedule = [
    { hour: 4, min: 30, type: "morning"  }, // 07:30 TR
    { hour: 7, min: 30, type: "opening"  }, // 10:30 TR
    { hour: 13, min: 0, type: "wallst"   }, // 16:00 TR
    { hour: 16, min: 30, type: "closing" }, // 19:30 TR
  ];

  setInterval(() => {
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    const s = now.getSeconds();
    if (s !== 0) return; // Sadece saat başlarında kontrol
    for (const slot of schedule) {
      if (h === slot.hour && m === slot.min) {
        sendBriefing(slot.type);
      }
    }
  }, 1000);

  console.log("Zamanlayıcı aktif: 07:30 / 10:30 / 16:00 / 19:30 TR saati");
}


// PORTFOLIO ENDPOINT
const PORTFOLIO_SYSTEM = `Sen bir portföy simülasyonunda yatırım kararları alan yapay zekasın. Başlangıç: 1.000.000 TL. Tamamen simülasyon.
Güncel küresel piyasa koşullarını web'den araştır. Sonra 1.000.000 TL'yi dağıt:
Altın, Gümüş, USD/TRY, BIST100, Bitcoin, Ethereum, Brent Petrol, Fon, S&P 500, Nasdaq, DXY, ABD Tahvil, Para Piyasası Fonu, TL Mevduat, Nakit

SADECE JSON döndür:
{
  "macro_context": "DXY seviyesi, risk rejimi, öne çıkan tema (1-2 cümle)",
  "reasoning": "Genel strateji ve neden bu dağılımı seçtiğini açıkla (2 cümle)",
  "key_risk": "En büyük risk: bu kararı tersine çevirecek gelişme nedir (1 cümle)",
  "positions": [
    { "asset": "Altın", "allocation_pct": 35, "reason": "Neden bu yüzde, mekanizma (1 cümle)" }
  ]
}
Toplam allocation_pct tam 100 olmalı. Sadece pozisyon aldığın varlıkları yaz, 0% olanları atlayabilirsin.
HABER GÜNCELLİĞİ KURALI:
- Sadece son 48 saatin haberlerini "güncel" olarak kabul et
- 48 saatten eski haberler varsa "ESKİ BAĞLAM (tarih):" olarak işaretle
- "Bugün", "şu an", "güncel" ifadelerini sadece son 48 saat için kullan
- Web aramasında tarihi her zaman kontrol et, eski haberi yeni gibi sunma`;

let portfolioCache = null;
let portfolioCacheTime = 0;
const PORTFOLIO_CACHE_MS = 24 * 60 * 60 * 1000; // 24 saat

async function getPortfolioDecision() {
  const now = Date.now();
  if (portfolioCache && (now - portfolioCacheTime) < PORTFOLIO_CACHE_MS) {
    console.log('Portfolio cache hit');
    return portfolioCache;
  }
  const raw = await callClaude(PORTFOLIO_SYSTEM, 'Güncel piyasalara göre portföy dağılımı belirle.', true);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('JSON bulunamadı');
  const result = JSON.parse(match[0]);
  portfolioCache = result;
  portfolioCacheTime = now;
  console.log('Portfolio kararı alındı:', result.reasoning);
  return result;
}

function formatPortfolioMessage(result) {
  const timeStr = new Date().toLocaleTimeString('tr-TR', {hour:'2-digit', minute:'2-digit'});
  let msg = '📊 CLAUDE PORTFÖY KARARI ' + timeStr + '\n';
  msg += '━━━━━━━━━━━━━━━━━━\n';
  msg += '🌐 MAKRO\n' + (result.macro_context || '') + '\n\n';
  msg += '💡 STRATEJİ\n' + (result.reasoning || '') + '\n\n';
  msg += '━━━━━━━━━━━━━━━━━━\n';
  msg += 'POZİSYONLAR\n\n';

  const sorted = [...(result.positions || [])].sort((a,b) => b.allocation_pct - a.allocation_pct);
  for (const pos of sorted) {
    const bar = '█'.repeat(Math.round(pos.allocation_pct / 5)) + '░'.repeat(20 - Math.round(pos.allocation_pct / 5));
    msg += pos.asset + ' — %' + pos.allocation_pct + '\n';
    msg += bar.substring(0, 20) + '\n';
    if (pos.reason) msg += '   ' + pos.reason + '\n';
    msg += '\n';
  }

  if (result.key_risk) {
    msg += '━━━━━━━━━━━━━━━━━━\n';
    msg += '⚠️ ANA RİSK\n' + result.key_risk + '\n\n';
  }

  msg += '⚠️ Simülasyon amaçlıdır, yatırım tavsiyesi değildir.';
  return msg;
}


// PRICE ENDPOINT


// Price store — populated by morning briefing, read by dashboard
let priceStore = null;

function setPrices(prices) {
  priceStore = prices;
  console.log('Fiyat store güncellendi:', new Date().toLocaleTimeString('tr-TR'));
}

async function getPrices() {
  if (priceStore) return priceStore;
  throw new Error('Henüz fiyat verisi yok. Sabah brifingini bekleyin veya /kuki yazın.');
}

// ─── WEBHOOK SERVER ───────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Prices API
  if (req.method === 'GET' && req.url === '/prices') {
    getPrices()
      .then(result => {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ok: true, ...result}));
      })
      .catch(err => {
        res.writeHead(500, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ok: false, error: err.message}));
      });
    return;
  }

  // Portfolio API
  if (req.method === 'GET' && req.url === '/portfolio') {
    getPortfolioDecision()
      .then(result => {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ok: true, ...result}));
      })
      .catch(err => {
        res.writeHead(500, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ok: false, error: err.message}));
      });
    return;
  }

  // Telegram webhook
  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const update = JSON.parse(body);
        if (update.message) await handleMessage(update.message);
      } catch (e) { console.error("Webhook hatası:", e.message); }
      res.writeHead(200); res.end("OK");
    });
    return;
  }

  res.writeHead(200); res.end("Finans Bot çalışıyor");
});

server.listen(PORT, () => {
  console.log(`Bot ${PORT} portunda çalışıyor`);
  scheduleBriefings();
});
