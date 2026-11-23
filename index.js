require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { GoogleGenAI, Type, MediaResolution, ThinkingLevel } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ========================================================================
// User-Agent Rotation — evita fingerprinting por provedores
// ========================================================================

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

const app = express();
app.use(cors());
app.use(express.json());
const upload = multer({ dest: '/tmp/' });

// ========================================================================
// Chaves do Gemini com rodízio
// ========================================================================
// As chaves ficam SÓ nas variáveis de ambiente da Vercel, nunca no código:
//   GEMINI_API_KEYS = chave1,chave2,chave3   (várias, separadas por vírgula)
//   GEMINI_API_KEY  = chave                  (a antiga; entra no fim da lista)
// Quando uma chave atinge o limite (cota), o pedido vai na hora para a próxima.
// GEMINI_MODELS (opcional) = modelos em ordem de preferência, do mais leve ao reserva.

const API_KEYS = [...new Set(
  [process.env.GEMINI_API_KEYS, process.env.GEMINI_API_KEY]
    .filter(Boolean).join(',')
    .split(/[\s,;]+/).map(k => k.trim()).filter(Boolean)
)];
// gemini-2.5-flash-lite foi desativado pelo Google (404). Reservas atuais: outro "lite" e um flash.
const MODELS = (process.env.GEMINI_MODELS || 'gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.6-flash')
  .split(/[\s,;]+/).map(m => m.trim()).filter(Boolean);
const MODEL = MODELS[0];
const geminiClients = API_KEYS.map(apiKey => new GoogleGenAI({ apiKey }));
console.log(`[Gemini] ${geminiClients.length} chave(s) configurada(s); modelos: ${MODELS.join(' → ')}`);

const blockedUntil = new Map(); // "índice da chave#modelo" → até quando está bloqueada
let currentKey = 0;             // continua na chave que funcionou por último

// Vídeos enviados pela File API pertencem à chave que enviou. Se o pedido trocar de
// chave, o vídeo é enviado de novo com a chave nova (guardamos o vídeo para isso).
const uploadedMedia = new Map(); // uri → { buffer, mimeType, type, byKey: Map(índice → Promise<uri>) }

function classifyGeminiError(err) {
  const msg = String(err?.message || err || '');
  const status = err?.status || err?.code;
  const retry = msg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  const retryMs = retry ? Math.ceil(Number(retry[1]) * 1000) : 0;
  if (status === 429 || /RESOURCE_EXHAUSTED|\b429\b|quota|cota/i.test(msg)) {
    const daily = /PerDay|per day|por dia/i.test(msg);
    return { kind: 'quota', daily, blockMs: retryMs || (daily ? 6 * 3600e3 : 60e3) };
  }
  if ([401, 403].includes(status) || /API_KEY_INVALID|API key not valid|PERMISSION_DENIED|API_KEY_SERVICE_BLOCKED|billing/i.test(msg)) {
    return { kind: 'key', blockMs: 3600e3 };
  }
  if (status === 503 || /UNAVAILABLE|\b503\b|overloaded|high demand|alta demanda/i.test(msg)) {
    return { kind: 'overloaded', blockMs: 0 };
  }
  if (status === 404 || /not found|is not supported|não é compatível/i.test(msg)) {
    return { kind: 'model', blockMs: 3600e3 };
  }
  return { kind: 'other', blockMs: 0 };
}

// Converte o schema do SDK (Type.OBJECT...) para JSON Schema padrão, mantendo a ordem
// dos campos (propertyOrdering). Testado em 23/11/2026: com "responseSchema" o
// gemini-3.5-flash-lite responde 503 "alta demanda" em todo pedido com vídeo; com
// "responseJsonSchema" o MESMO pedido responde em ~6s, com as quantidades certas.
function toJsonSchema(sch) {
  if (!sch || typeof sch !== 'object') return sch;
  const out = {};
  if (sch.type) out.type = String(sch.type).toLowerCase();
  if (sch.description) out.description = sch.description;
  if (sch.items) out.items = toJsonSchema(sch.items);
  if (sch.properties) {
    const order = sch.propertyOrdering || Object.keys(sch.properties);
    const keys = [...order, ...Object.keys(sch.properties).filter(k => !order.includes(k))];
    out.properties = {};
    for (const k of keys) if (sch.properties[k]) out.properties[k] = toJsonSchema(sch.properties[k]);
  }
  return out;
}

// Modelos Gemini 3 não aceitam thinkingBudget: 0 — usam "nível de raciocínio".
function adaptConfigForModel(config, model) {
  if (config && config.responseSchema) {
    const { responseSchema, ...rest } = config;
    config = { ...rest, responseJsonSchema: toJsonSchema(responseSchema) };
  }
  if (!config || !config.thinkingConfig || !/gemini-3|-latest$/.test(model)) return config;
  const budget = config.thinkingConfig.thinkingBudget;
  if (budget === undefined) return config;
  const L = ThinkingLevel || { MINIMAL: 'MINIMAL', LOW: 'LOW', MEDIUM: 'MEDIUM' };
  // MINIMAL só é aceito pelos modelos "lite"; nos outros o mínimo é LOW.
  const minimal = /lite/.test(model) ? L.MINIMAL : L.LOW;
  const thinkingLevel = budget === 0 ? minimal : budget <= 1024 ? L.LOW : L.MEDIUM;
  return { ...config, thinkingConfig: { thinkingLevel } };
}

async function partsForKey(contents, ki) {
  return Promise.all(contents.map(async c => ({
    ...c,
    parts: await Promise.all((c.parts || []).map(async part => {
      const uri = part.fileData && part.fileData.fileUri;
      const media = uri && uploadedMedia.get(uri);
      if (!media) return part;
      if (!media.byKey.has(ki)) {
        console.log(`[Gemini] ⬆️  Enviando o vídeo de novo para a chave ${ki + 1}`);
        media.byKey.set(ki, uploadFileWithClient(geminiClients[ki], media.buffer, media.mimeType, media.type).then(r => r.uri));
      }
      return { fileData: { fileUri: await media.byKey.get(ki), mimeType: part.fileData.mimeType } };
    }))
  })));
}

/**
 * Faz o pedido ao Gemini tentando cada chave (e depois cada modelo reserva).
 * Limite/cota ou chave inválida → bloqueia aquela chave por um tempo e passa à próxima.
 */
async function generateWithRotation(request) {
  if (geminiClients.length === 0) throw new Error('Nenhuma chave do Gemini configurada (GEMINI_API_KEYS)');
  let lastErr = null;
  let onlyQuota = true;
  for (const model of MODELS) {
    for (let n = 0; n < geminiClients.length; n++) {
      const ki = (currentKey + n) % geminiClients.length;
      const slot = `${ki}#${model}`;
      if ((blockedUntil.get(slot) || 0) > Date.now()) continue;
      let c = null;
      // "Alta demanda" (503) é do MODELO, não da chave: espera um pouco e tenta de novo
      // na mesma chave (trocar de chave obrigaria a reenviar o vídeo, ~20s cada vez).
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const contents = await partsForKey(request.contents, ki);
          const response = await geminiClients[ki].models.generateContent({
            ...request, model, contents, config: adaptConfigForModel(request.config, model)
          });
          if (ki !== currentKey) console.log(`[Gemini] 🔁 Agora usando a chave ${ki + 1}`);
          if (model !== MODELS[0]) console.log(`[Gemini] 🔁 Respondido pelo modelo reserva ${model}`);
          currentKey = ki;
          return response;
        } catch (err) {
          c = classifyGeminiError(err);
          lastErr = err;
          if (c.kind === 'other') throw err;
          console.warn(`[Gemini] ⚠️  Chave ${ki + 1} / ${model}: ${c.kind}${c.daily ? ' (limite diário)' : ''} — ${String(err.message || '').slice(0, 160)}`);
          if (c.kind !== 'overloaded' || attempt === 3) break;
          await new Promise(r => setTimeout(r, attempt * 3000));
        }
      }
      if (c.kind !== 'quota') onlyQuota = false;
      if (c.blockMs) blockedUntil.set(slot, Date.now() + c.blockMs);
      // Modelo fora do ar ou sobrecarregado: as outras chaves teriam o mesmo problema → próximo modelo.
      if (c.kind === 'model' || c.kind === 'overloaded') break;
    }
  }
  const err = lastErr || new Error('Todas as chaves do Gemini estão no limite agora');
  err.allKeysBlocked = true;
  if (onlyQuota) err.isDailyQuota = true;
  throw err;
}

// Mesma "cara" do cliente do SDK, para o resto do código não mudar.
const ai = { models: { generateContent: generateWithRotation } };

// ========================================================================
// Configuração Otimizada
// ========================================================================

const SYSTEM_INSTRUCTION = `Você é um extrator rápido e preciso de receitas de vídeos culinários.

## FONTES DE INFORMAÇÃO
O conteúdo pode vir de MÚLTIPLAS fontes: áudio/narração do vídeo, texto visual sobreposto no vídeo, e/ou a legenda/descrição do post (fornecida como texto separado). Considere TODAS as fontes disponíveis para extrair a receita.

## REGRAS ABSOLUTAS CONTRA ALUCINAÇÃO (NUNCA VIOLE)
1. NUNCA invente, crie, suponha ou "complete" ingredientes, quantidades ou passos que NÃO foram explicitamente ditos, mostrados ou escritos na legenda.
2. Se você não tem certeza sobre um ingrediente ou quantidade, use "A gosto" ou "Quantidade não especificada" — NUNCA invente um valor.
3. Se o vídeo E a legenda NÃO contiverem uma receita (ex: apenas música sem narração, texto culinário ou legenda com receita), retorne apenas o campo "erro".
4. Seja conciso e direto no modo de preparo. Não adicione textos enrolados, vá direto ao ponto (isso acelera a extração).
5. O título DEVE ser extraído do vídeo ou da legenda. Se não mencionado, descreva de forma direta (ex: "Bolo de Chocolate").
6. Para ingredientes, quantidades e modo de preparo: extraia SOMENTE o que é explicitamente dito, mostrado ou escrito na legenda. Para calorias (kcal), você PODE estimar com base em valores nutricionais padrão — mas NUNCA invente ingredientes ou passos.
7. Escreva o modo de preparo com ortografia, gramática e concordância corretas no português, mesmo que a pessoa no vídeo fale com gírias, erros ou de forma informal.
8. Se o vídeo contém MÚLTIPLAS receitas (compilação), extraia apenas a PRIMEIRA receita completa identificada (com ingredientes e modo de preparo). Ignore as demais receitas do vídeo.
9. A lista de ingredientes NUNCA pode ficar vazia se algum ingrediente for usado no vídeo. Em vídeos longos, a pessoa costuma citar os ingredientes aos poucos, enquanto cozinha, sem fazer uma lista no começo. Nesse caso, junte na lista TODOS os ingredientes que ela cita ou usa em qualquer momento do vídeo (inclusive os que aparecem só no modo de preparo), com a quantidade que ela disser. Se não disser a quantidade, use "A gosto" ou "Quantidade não especificada". Isso não é inventar: é listar o que foi dito ou mostrado.`;

const RECIPE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    erro: { type: Type.STRING, description: "Preencha apenas se não houver receita no conteúdo. Deixe vazio ou omita se for sucesso." },
    falas_ingredientes: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Copie, palavra por palavra, cada frase falada (ou escrita na tela) que cite um ingrediente ou uma quantidade, na ordem do vídeo. Ex: 'quatro ovos', 'meia xícara de óleo', 'meia colher de sal, colher de sopa', 'tem quatrocentos gramas de polvilho'. Use estas frases para preencher os ingredientes com quantidade."
    },
    titulo: { type: Type.STRING },
    rendimento: { type: Type.STRING },
    calorias_totais: { type: Type.STRING },
    ingredientes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          secao: { type: Type.STRING, description: "Nome da seção, ex: 'Massa' ou 'Principal'" },
          itens: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                descricao: { type: Type.STRING },
                kcal: { type: Type.STRING }
              }
            }
          }
        }
      }
    },
    modo_preparo: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          secao: { type: Type.STRING },
          passos: {
            type: Type.ARRAY,
            items: { type: Type.STRING }
          }
        }
      }
    }
  },
  // A IA escreve o modo de preparo ANTES da lista de ingredientes. Assim ela monta a
  // lista já tendo escrito cada passo (com as quantidades ditas no vídeo) e não esquece
  // ingrediente nem quantidade. A tela mostra igual, a ordem do JSON não muda nada lá.
  // As "falas" vêm primeiro: a IA anota o que foi dito sobre cada ingrediente e quantidade
  // e só depois escreve o modo de preparo e a lista. Tudo no MESMO pedido (a chave do
  // Gemini tem limite de pedidos por dia, então não dá para gastar pedidos extras).
  propertyOrdering: ['erro', 'titulo', 'rendimento', 'falas_ingredientes', 'modo_preparo', 'ingredientes', 'calorias_totais']
};

const INGREDIENTS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    ingredientes: RECIPE_SCHEMA.properties.ingredientes,
    calorias_totais: { type: Type.STRING }
  },
  propertyOrdering: ['ingredientes', 'calorias_totais']
};

// Vídeo a partir deste tamanho (em segundos) é "longo": a tela avisa que pode demorar mais.
const LONG_VIDEO_SECONDS = 600;

// Lê a duração (em segundos) direto do arquivo MP4 (caixa "mvhd").
// Usado quando o vídeo veio de um provedor que não informa a duração.
function mp4DurationSeconds(buffer) {
  try {
    const i = buffer.indexOf('mvhd');
    if (i < 0) return 0;
    const version = buffer[i + 4];
    const timescale = version === 1 ? buffer.readUInt32BE(i + 24) : buffer.readUInt32BE(i + 16);
    const duration = version === 1 ? Number(buffer.readBigUInt64BE(i + 28)) : buffer.readUInt32BE(i + 20);
    return timescale ? duration / timescale : 0;
  } catch (e) {
    return 0;
  }
}

// Um ingrediente "tem quantidade" se traz número, fração, medida ou "a gosto".
const QTY_RE = /\d|½|¼|¾|⅓|⅔|\bmei[ao]\b|\bum\b|\buma\b|\bdois\b|\bduas\b|\btrês\b|\bquatro\b|\bcinco\b|\bseis\b|\bsete\b|\boito\b|\bnove\b|\bdez\b|\bdúzia|x[íi]cara|colher|pitada|copo|lata|pacote|caixa|dente|\bfio\b|gota|punhado|ma[çc]o|tablete|\bgramas?\b|\bkg\b|\bml\b|litro|a gosto|quantidade não/i;

// Quantos ingredientes vieram SEM quantidade (ex: "Ovos" em vez de "4 ovos").
function ingredientsWithoutQuantity(recipe) {
  const items = (recipe?.ingredientes || []).flatMap(sec => (sec && sec.itens) || []);
  return { total: items.length, missing: items.filter(it => !QTY_RE.test(it.descricao || '')).length };
}

// "2865" → "2865 kcal" (a tela mostrava o total sem a unidade).
function withKcal(v) {
  if (v === undefined || v === null) return v;
  const str = String(v).trim();
  return /^[~≈]?\s*[\d.,]+$/.test(str) ? `${str} kcal` : str;
}

function normalizeRecipe(recipe) {
  if (!recipe) return recipe;
  delete recipe.falas_ingredientes; // só serve para a IA; a tela não usa
  if (recipe.calorias_totais) recipe.calorias_totais = withKcal(recipe.calorias_totais);
  for (const sec of recipe.ingredientes || []) {
    for (const it of (sec && sec.itens) || []) if (it.kcal) it.kcal = withKcal(it.kcal);
  }
  return recipe;
}

function countIngredients(recipe) {
  return (recipe?.ingredientes || []).reduce((n, sec) => n + ((sec && sec.itens) ? sec.itens.length : 0), 0);
}

// ========================================================================
// Retry com Backoff — protege contra 503/429 do Gemini
// ========================================================================

async function callGeminiWithRetry(requestFn, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await requestFn();
    } catch (err) {
      const status = err?.status || err?.httpStatusCode || err?.code;
      const isRetryable = [503, 429, 'UNAVAILABLE', 'RESOURCE_EXHAUSTED'].includes(status)
        || (err.message && (err.message.includes('503') || err.message.includes('429') || err.message.includes('high demand') || err.message.includes('overloaded')));

      // Todas as chaves no limite: esperar alguns segundos não resolve.
      if (err.isDailyQuota) throw err;

      if (isRetryable && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        console.warn(`[Gemini] ⚠️  Tentativa ${attempt}/${maxRetries} falhou (${status || err.message}). Retentando em ${delay/1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

// ========================================================================
// Cache em Memória por URL
// ========================================================================

const recipeCache = new Map();
const CACHE_MAX_SIZE = 500;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

function getCacheKey(url) {
  return url.replace(/[?#].*/, '').replace(/\/$/, '').trim().toLowerCase();
}

function getCachedRecipe(url) {
  const key = getCacheKey(url);
  const entry = recipeCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    recipeCache.delete(key);
    return null;
  }
  console.log('[Cache] ✅ HIT — retornando receita do cache');
  return entry.data;
}

function setCachedRecipe(url, data) {
  const key = getCacheKey(url);
  if (recipeCache.size >= CACHE_MAX_SIZE) {
    const oldest = recipeCache.keys().next().value;
    recipeCache.delete(oldest);
  }
  recipeCache.set(key, { data, timestamp: Date.now() });
  console.log(`[Cache] 💾 Armazenado (${recipeCache.size}/${CACHE_MAX_SIZE})`);
}

// ========================================================================
// Gemini File API — Upload eficiente para arquivos grandes
// ========================================================================

/**
 * Usa a File API do Gemini para upload de arquivos grandes.
 * Muito mais eficiente que inline base64 para vídeos (binário vs base64 = 33% menos dados).
 */
async function uploadToGeminiFileAPI(rawBuffer, mimeType, type) {
  // Envia com a chave atual; se depois o pedido trocar de chave, partsForKey reenvia.
  const ki = currentKey;
  const ref = await uploadFileWithClient(geminiClients[ki], rawBuffer, mimeType, type);
  uploadedMedia.set(ref.uri, { buffer: rawBuffer, mimeType, type, byKey: new Map([[ki, Promise.resolve(ref.uri)]]) });
  if (uploadedMedia.size > 20) uploadedMedia.delete(uploadedMedia.keys().next().value);
  return ref;
}

async function uploadFileWithClient(client, rawBuffer, mimeType, type) {
  const ext = type === 'audio' ? 'mp3' : 'mp4';
  const tmpPath = path.join('/tmp', `gemini_upload_${Date.now()}.${ext}`);

  try {
    fs.writeFileSync(tmpPath, rawBuffer);

    const sizeMB = (rawBuffer.length / (1024 * 1024)).toFixed(1);
    console.log(`[File API] ⬆️  Uploading ${sizeMB}MB ${type} to Gemini...`);

    const uploadStart = Date.now();
    const uploadResult = await client.files.upload({
      file: tmpPath,
      config: { mimeType, displayName: `tiktok_${type}_${Date.now()}` }
    });

    const uploadElapsed = ((Date.now() - uploadStart) / 1000).toFixed(1);
    console.log(`[File API] ✅ Upload concluído em ${uploadElapsed}s (${uploadResult.name})`);

    // Aguardar processamento do arquivo se necessário
    let file = uploadResult;
    // Vídeos longos levam mais tempo para o Gemini preparar. Espera até 2 minutos,
    // conferindo a cada 1s (antes eram só ~15s, pouco para vídeos de 10+ minutos).
    const waitStart = Date.now();
    while (file.state === 'PROCESSING') {
      if (Date.now() - waitStart > 120000) throw new Error('File API: timeout aguardando processamento');
      await new Promise(r => setTimeout(r, 1000));
      file = await client.files.get({ name: file.name });
    }
    console.log(`[File API] ✅ Arquivo pronto (${((Date.now() - waitStart) / 1000).toFixed(1)}s de processamento)`);

    if (file.state === 'FAILED') {
      throw new Error('File API: processamento do arquivo falhou');
    }

    return { uri: file.uri, mimeType: file.mimeType || mimeType };
  } finally {
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (e) {}
    }
  }
}

/**
 * Transcreve a FALA do vídeo em texto. Em vídeo longo a IA, olhando o vídeo direto,
 * às vezes escreve só "Ovos" em vez de "4 ovos". Num texto escrito a quantidade
 * fica clara, e dele a lista de ingredientes sai com as quantidades certas.
 */
async function transcribeSpeech(mediaPart) {
  const t0 = Date.now();
  const response = await callGeminiWithRetry(() => ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [
      mediaPart,
      { text: 'Transcreva em português, palavra por palavra, TUDO o que é falado neste vídeo, do começo ao fim, sem resumir e sem pular nada. Escreva os números como a pessoa falou (ex: "meia xícara", "4 ovos", "450 gramas"). Se aparecer na tela algum texto com ingrediente ou quantidade, coloque-o entre colchetes no ponto em que aparece. Responda só com a transcrição.' }
    ] }],
    config: {
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
      thinkingConfig: { thinkingBudget: 0 },
      temperature: 0,
      maxOutputTokens: 16000
    }
  }));
  const text = (response.text || '').trim();
  console.log(`[Transcrição] 📝 ${text.length} caracteres em ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return text;
}

// ========================================================================
// Resolução de URLs encurtadas (vm.tiktok.com, vt.tiktok.com)
// ========================================================================

async function resolveShortUrl(url) {
  if (/^https?:\/\/(vm|vt)\.tiktok\.com\//i.test(url)) {
    console.log('[URL] 🔗 Link encurtado detectado — resolvendo redirect...');
    try {
      const response = await axios.get(url, {
        maxRedirects: 10,
        timeout: 10000,
        headers: { 'User-Agent': getRandomUserAgent() },
        validateStatus: () => true,
      });
      const finalUrl = response.request?.res?.responseUrl || response.request?.responseURL || url;
      console.log(`[URL] ✅ Resolvido para: ${finalUrl}`);
      return finalUrl;
    } catch (err) {
      console.warn(`[URL] ⚠️  Falha ao resolver link encurtado (${err.message}) — tentando URL original`);
      return url;
    }
  }
  return url;
}

// ========================================================================
// TikTok Audio/Video Download (Audio-First Strategy)
// ========================================================================

/**
 * TikWM GET — provedor principal.
 * Busca só os dados do vídeo (link, autor, legenda). O download do vídeo é feito
 * à parte, para a legenda poder ser lida enquanto o vídeo ainda está baixando.
 */
async function fetchTikWMMeta(url) {
  console.log('[TikWM] Buscando metadata...');
  const ua = getRandomUserAgent();

  const response = await axios.get('https://www.tikwm.com/api/', {
    params: { url, hd: 0 },
    timeout: 10000,
    headers: { 'User-Agent': ua }
  });

  if (response.data.code !== 0 || !response.data.data) {
    throw new Error(`TikWM retornou código ${response.data.code}: ${response.data.msg}`);
  }

  const data = response.data.data;

  // ── SEMPRE baixar o VÍDEO ──
  // O campo "music" do TikWM retorna apenas a trilha sonora/música de fundo,
  // NÃO a narração do criador. A fala real está no track de áudio do vídeo.
  if (!data.play) {
    throw new Error('TikWM: nenhuma URL de vídeo encontrada');
  }

  return {
    videoUrl: data.play,
    ua,
    author: data.author?.unique_id || null,
    title: data.title || null,
    description: data.title || '',
    duration: Number(data.duration) || 0, // segundos
    size: Number(data.size) || 0          // bytes
  };
}

// Guarda por 2 minutos os dados do vídeo buscados pela rota /api/recipe/info,
// para a rota principal não precisar perguntar de novo ao TikWM (economiza ~1s).
const metaCache = new Map();
const META_TTL_MS = 2 * 60 * 1000;

// Guarda a PROMESSA: se a tela pedir a duração (/info) e a receita (/url) ao mesmo
// tempo, as duas usam a mesma consulta ao TikWM (ele só aceita ~1 pedido por segundo).
async function getTikWMMeta(url) {
  const key = getCacheKey(url);
  const entry = metaCache.get(key);
  if (entry && Date.now() - entry.timestamp < META_TTL_MS) {
    console.log('[TikWM] ✅ Dados do vídeo reaproveitados');
    return entry.promise;
  }
  const promise = fetchTikWMMeta(url);
  if (metaCache.size > 200) metaCache.delete(metaCache.keys().next().value);
  metaCache.set(key, { promise, timestamp: Date.now() });
  promise.catch(() => metaCache.delete(key)); // falhou: não guarda
  return promise;
}

// Tempo limite do download proporcional ao tamanho: vídeos longos têm 50MB+ e
// não cabiam nos 30s fixos de antes.
function downloadTimeoutMs(sizeBytes) {
  const sizeMB = (sizeBytes || 0) / (1024 * 1024);
  return Math.min(150000, Math.max(30000, 30000 + sizeMB * 1500));
}

async function downloadTikWMVideo(meta) {
  console.log('[Video] ⬇️  Baixando vídeo SD...');
  const startTime = Date.now();

  const videoResponse = await axios({
    url: meta.videoUrl,
    method: 'GET',
    responseType: 'arraybuffer',
    timeout: downloadTimeoutMs(meta.size),
    headers: { 'User-Agent': meta.ua }
  });

  const sizeMB = (videoResponse.data.byteLength / (1024 * 1024)).toFixed(1);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Video] ✅ Download completo: ${sizeMB}MB em ${elapsed}s`);

  return {
    buffer: Buffer.from(videoResponse.data),
    mimeType: 'video/mp4',
    type: 'video',
    author: meta.author,
    title: meta.title,
    description: meta.description,
    duration: meta.duration
  };
}

/**
 * TikWM POST variant (fallback provider)
 */
async function downloadViaTikWMPost(url) {
  console.log('[TikWM-POST] Tentando...');
  const ua = getRandomUserAgent();
  const response = await axios({
    method: 'post',
    url: 'https://www.tikwm.com/api/',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': ua,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Origin': 'https://www.tikwm.com',
      'Referer': 'https://www.tikwm.com/'
    },
    data: `url=${encodeURIComponent(url)}&count=12&cursor=0&web=1&hd=0`,
    timeout: 15000
  });

  if (response.data.code !== 0 || !response.data.data) {
    throw new Error(`TikWM-POST retornou código ${response.data.code}: ${response.data.msg}`);
  }

  const data = response.data.data;
  const author = data.author?.unique_id || null;
  const title = data.title || null;

  // SEMPRE baixar o VÍDEO — o campo "music" é a trilha sonora, não a narração
  const videoUrl = data.play;
  if (!videoUrl) throw new Error('TikWM-POST: Sem URL de vídeo');

  console.log('[TikWM-POST] ⬇️  Baixando vídeo...');
  const videoResponse = await axios({
    url: videoUrl,
    method: 'GET',
    responseType: 'arraybuffer',
    timeout: 120000,
    headers: { 'User-Agent': ua }
  });

  return {
    buffer: Buffer.from(videoResponse.data),
    mimeType: 'video/mp4',
    type: 'video',
    author,
    title,
    description: data.title || ''
  };
}

/**
 * TTSave fallback (video only — no audio support)
 */
async function downloadViaTTSave(url) {
  console.log('[TTSave] Tentando...');
  const ua = getRandomUserAgent();
  const response = await axios.post('https://ttsave.app/download',
    { id: url, locale: 'en', tt: 'ttsave' },
    {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': ua
      },
      timeout: 15000
    }
  );

  const htmlData = typeof response.data === 'string' ? response.data : '';

  const downloadMatch = htmlData.match(/href="(https:\/\/[^"]*tiktokcdn[^"]*)"/) ||
    htmlData.match(/id="btn_without_watermark"[^>]*href="([^"]*)"/) ||
    htmlData.match(/href="(https:\/\/[^"]*\.mp4[^"]*)"/);

  if (!downloadMatch || !downloadMatch[1]) {
    throw new Error('TTSave: não encontrou link de download no HTML retornado');
  }

  const authorMatch = htmlData.match(/@([a-zA-Z0-9_.]+)/);
  const author = authorMatch ? authorMatch[1] : null;

  console.log('[TTSave] ⬇️  Baixando vídeo...');
  const videoResponse = await axios({
    url: downloadMatch[1],
    method: 'GET',
    responseType: 'arraybuffer',
    timeout: 120000,
    headers: { 'User-Agent': ua }
  });

  return {
    buffer: Buffer.from(videoResponse.data),
    mimeType: 'video/mp4',
    type: 'video',
    author: author ? `@${author}` : null,
    title: null,
    description: ''
  };
}

/**
 * TikCDN/SSSTik — provedor alternativo adicional
 */
async function downloadViaTikCDN(url) {
  console.log('[TikCDN] Tentando via tikcdn.io...');
  const ua = getRandomUserAgent();

  // Passo 1: obter o formulário do SSSTik
  const formResponse = await axios.post('https://ssstik.io/abc?url=dl', 
    `id=${encodeURIComponent(url)}&locale=en&tt=ssstik`,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': ua,
        'Origin': 'https://ssstik.io',
        'Referer': 'https://ssstik.io/'
      },
      timeout: 15000
    }
  );

  const html = typeof formResponse.data === 'string' ? formResponse.data : '';

  // Extrair link de download sem watermark
  const downloadMatch = html.match(/href="(https:\/\/[^"]*(?:tikcdn|ssstik)[^"]*)"/) ||
    html.match(/href="(https:\/\/[^"]*\.mp4[^"]*)"/);

  if (!downloadMatch || !downloadMatch[1]) {
    throw new Error('TikCDN: não encontrou link de download');
  }

  // Extrair autor se disponível
  const authorMatch = html.match(/@([a-zA-Z0-9_.]+)/);
  const author = authorMatch ? authorMatch[1] : null;

  // Extrair descrição se disponível
  const descMatch = html.match(/class="maintext"[^>]*>([^<]+)</);
  const description = descMatch ? descMatch[1].trim() : '';

  console.log('[TikCDN] ⬇️  Baixando vídeo...');
  const videoResponse = await axios({
    url: downloadMatch[1],
    method: 'GET',
    responseType: 'arraybuffer',
    timeout: 120000,
    headers: { 'User-Agent': ua, 'Referer': 'https://ssstik.io/' }
  });

  return {
    buffer: Buffer.from(videoResponse.data),
    mimeType: 'video/mp4',
    type: 'video',
    author: author ? `@${author}` : null,
    title: null,
    description
  };
}

/**
 * Download com fallback em paralelo: usado quando o TikWM GET falha.
 * Todos os provedores alternativos são tentados ao mesmo tempo e vence o primeiro
 * que entregar o vídeo — assim um provedor fora do ar não trava os outros.
 * Se todos falharem, lança erro com detalhes de cada falha.
 */
async function downloadWithFallbacks(url) {
  const providers = [
    { name: 'TikWM-POST', fn: downloadViaTikWMPost },
    { name: 'TikCDN', fn: downloadViaTikCDN },
    { name: 'TTSave', fn: downloadViaTTSave },
  ];

  console.log('[Fallback] 🚀 Tentando ' + providers.length + ' provedores em paralelo...');
  const errors = [];

  try {
    return await Promise.any(providers.map(provider =>
      provider.fn(url).then(
        result => {
          console.log(`[Fallback] ✅ Sucesso com ${provider.name} (${(result.buffer.length / (1024*1024)).toFixed(1)}MB)`);
          return result;
        },
        err => {
          const errMsg = err.message || String(err);
          console.error(`[Fallback] ❌ Falha em ${provider.name}: ${errMsg}`);
          errors.push(`${provider.name}: ${errMsg}`);
          throw err;
        }
      )
    ));
  } catch (e) {
    // Promise.any só rejeita quando todos falharam — os erros já estão em "errors"
  }

  // Categorizar o erro para mensagens mais úteis ao usuário
  const allErrors = errors.join('\n');
  const isRateLimit = /429|rate.?limit|too many|blocked|forbidden|403/i.test(allErrors);
  const downloadError = new Error(`Nenhum provedor conseguiu baixar o vídeo.\nDetalhes:\n${allErrors}`);
  downloadError.isRateLimit = isRateLimit;
  throw downloadError;
}

// ========================================================================
// Rota rápida pela legenda
// ========================================================================

// Legenda com receita (>100 chars + palavras-chave) pode ser processada só como TEXTO (1-3s).
function captionLooksLikeRecipe(description) {
  return !!description
    && description.length > 100
    && /ingredientes?|modo de preparo|colher|xícara|gramas?|\bg\b|\bml\b|\bkg\b/i.test(description);
}

/**
 * Extrai a receita só do texto da legenda.
 * Retorna a receita se ela tiver ingredientes E modo de preparo; senão retorna null
 * (ex: a legenda só tem a lista de ingredientes) e o vídeo é usado para completar.
 */
async function extractRecipeFromCaption(description, author) {
  console.log(`[Smart Route] ⚡ Legenda contém receita — processando como TEXTO`);
  const geminiStart = Date.now();

  try {
    const response = await callGeminiWithRetry(() => ai.models.generateContent({
      model: MODEL,
      contents: [{
        role: 'user',
        parts: [{
          text: `Extraia a receita do texto abaixo (legenda de um vídeo do TikTok). Ingredientes e modo de preparo devem vir SOMENTE do texto. Para calorias (kcal), estime os valores nutricionais de cada ingrediente.\n\n${description}`
        }]
      }],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: RECIPE_SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
        temperature: 0,
        maxOutputTokens: 4000
      }
    }));

    const textResult = JSON.parse(response.text);
    const geminiElapsed = ((Date.now() - geminiStart) / 1000).toFixed(1);
    console.log(`[Smart Route] ✅ Gemini-texto respondeu em ${geminiElapsed}s`);

    const hasIngredients = textResult.ingredientes
      && textResult.ingredientes.some(sec => sec.itens && sec.itens.length > 0);
    const hasSteps = textResult.modo_preparo
      && textResult.modo_preparo.some(sec => sec.passos && sec.passos.length > 0);

    if (!textResult.erro && textResult.titulo && hasIngredients && hasSteps) {
      normalizeRecipe(textResult);
      if (author) {
        textResult.creditos_autor = author.startsWith('@') ? author : `@${author}`;
      }
      return textResult;
    }
    console.log(`[Smart Route] ⚠️  Legenda não gerou receita válida — fallback para vídeo`);
  } catch (captionErr) {
    console.warn(`[Smart Route] ⚠️  Falha no processamento da legenda: ${captionErr.message} — fallback para vídeo`);
  }
  return null;
}

// ========================================================================
// API Routes
// ========================================================================

app.post('/api/recipe/audio', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo de áudio enviado.' });
  }

  const filePath = req.file.path;
  const mimeType = req.file.mimetype || 'audio/mp3';

  try {
    const startTime = Date.now();
    console.log(`\n========================================`);
    console.log(`[Audio Upload] Processando: ${filePath} (${mimeType})`);
    console.log(`========================================`);

    const fileBytes = fs.readFileSync(filePath);
    const base64Data = fileBytes.toString('base64');

    console.log('[Gemini] Gerando conteúdo...');

    const response = await callGeminiWithRetry(() => ai.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { data: base64Data, mimeType: mimeType } },
            { text: "Extraia a receita deste conteúdo. Ingredientes e modo de preparo devem vir SOMENTE do que é dito ou mostrado. Para calorias (kcal), estime os valores nutricionais de cada ingrediente." }
          ]
        }
      ],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: RECIPE_SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
        temperature: 0,
        maxOutputTokens: 4000
      }
    }));

    fs.unlinkSync(filePath);

    let textResponse = response.text;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Gemini] ✅ Resposta recebida em ${elapsed}s`);

    const recipeData = JSON.parse(textResponse);
    res.json(recipeData);

  } catch (error) {
    console.error('Error processing audio:', error);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    res.status(500).json({ error: 'Falha ao processar o áudio e gerar a receita.', details: error.message });
  }
});

// O autor vem do próprio link (tiktok.com/@autor/video/...). É mais confiável que o
// dos provedores alternativos, que às vezes pegavam lixo da página (ex: "@media" do CSS).
function authorFromUrl(url) {
  const m = String(url || '').match(/tiktok\.com\/@([A-Za-z0-9_.]+)/i);
  return m ? m[1] : null;
}

// Normaliza o link colado (tira texto em volta e pontuação no fim).
function cleanTikTokUrl(url) {
  const urlMatch = String(url || '').match(/(https?:\/\/[^\s]+)/);
  if (urlMatch) url = urlMatch[0];
  return String(url || '').replace(/[,.!?;:]+$/, '').trim();
}

// Plano B para a duração: a própria página do TikTok traz "duration":<segundos>.
async function fetchTikTokPageDuration(url) {
  const response = await axios.get(url, {
    timeout: 6000,
    headers: { 'User-Agent': getRandomUserAgent(), 'Accept-Language': 'pt-BR,pt;q=0.9' },
    responseType: 'text'
  });
  const m = String(response.data || '').match(/"duration":(\d+)/);
  if (!m || !Number(m[1])) throw new Error('duração não encontrada na página');
  return Number(m[1]);
}

/**
 * Rota rápida (~1s) que a tela chama antes da principal: diz a duração do vídeo,
 * para avisar quando ele é longo e mostrar uma contagem de tempo adequada.
 * Se a receita já estiver no cache, devolve a receita direto.
 */
app.post('/api/recipe/info', async (req, res) => {
  let url = cleanTikTokUrl(req.body?.url);
  if (!/tiktok\.com/i.test(url)) return res.status(400).json({ error: 'Link inválido.', errorCode: 'INVALID_URL' });
  try {
    url = await resolveShortUrl(url);
    const cached = getCachedRecipe(url);
    if (cached) return res.json({ cached: true, recipe: cached });
    // TikWM e a página do TikTok ao mesmo tempo; vale a primeira que trouxer a duração.
    let tikwmMeta = null;
    const tikwm = getTikWMMeta(url).then(m => (tikwmMeta = m));
    tikwm.catch(() => {});
    const duration = await Promise.any([
      tikwm.then(m => { if (!m.duration) throw new Error('sem duração'); return m.duration; }),
      fetchTikTokPageDuration(url)
    ]);
    const meta = tikwmMeta; // só existe se o TikWM já respondeu
    res.json({
      duration,
      longVideo: duration >= LONG_VIDEO_SECONDS,
      captionHasRecipe: meta ? captionLooksLikeRecipe(meta.description) : false
    });
  } catch (err) {
    // Não é grave: a tela só não mostra o aviso de vídeo longo.
    res.json({ duration: null, longVideo: false });
  }
});

app.post('/api/recipe/url', async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL é obrigatória.", errorCode: 'INVALID_INPUT' });

  // ── Sanitização de URL ──
  // Extrai apenas o link caso o usuário tenha colado um texto junto (ex: "Olha essa receita: https...")
  const urlMatch = url.match(/(https?:\/\/[^\s]+)/);
  if (urlMatch) {
    url = urlMatch[0];
  }
  // Remove pontuações no final do link (como vírgula, ponto, etc.)
  url = url.replace(/[,.!?;:]+$/, '').trim();

  // ── Validar domínio TikTok ──
  if (!/tiktok\.com/i.test(url)) {
    return res.status(400).json({
      error: 'Por favor, insira um link válido do TikTok (ex: https://www.tiktok.com/@user/video/...).',
      errorCode: 'INVALID_URL'
    });
  }

  // ── Resolver links encurtados (vm.tiktok.com, vt.tiktok.com) ──
  url = await resolveShortUrl(url);

  // ── Verificar cache ──
  const cached = getCachedRecipe(url);
  if (cached) {
    return res.json(cached);
  }

  try {
    const startTime = Date.now();
    console.log(`\n========================================`);
    console.log(`[URL] Processando: ${url}`);
    console.log(`========================================`);

    // 1. Dados do vídeo (link + legenda) primeiro; o download do vídeo começa
    //    logo em seguida e corre em paralelo com a leitura da legenda.
    //    O TikWM às vezes fica sem responder (vimos 10s de espera à toa na Vercel).
    //    Ele ganha 4s de vantagem; se não responder, os outros provedores começam juntos
    //    e vence quem entregar o vídeo primeiro.
    const metaPromise = getTikWMMeta(url).catch(metaErr => {
      console.warn(`[TikWM] ⚠️  ${metaErr.message} — usando provedores alternativos`);
      return null;
    });
    let meta = await Promise.race([metaPromise, new Promise(r => setTimeout(() => r(undefined), 4000))]);
    if (meta && meta.duration) console.log(`[TikWM] 🎬 Vídeo de ${Math.round(meta.duration / 60)} min (${(meta.size / (1024 * 1024)).toFixed(1)}MB)`);

    let mediaPromise;
    if (meta) {
      mediaPromise = downloadTikWMVideo(meta).catch(err => {
        console.warn(`[Video] ⚠️  Download pelo TikWM falhou (${err.message}) — usando provedores alternativos`);
        return downloadWithFallbacks(url);
      });
    } else if (meta === null) {
      mediaPromise = downloadWithFallbacks(url);
    } else {
      console.warn('[TikWM] ⏳ Lento — provedores alternativos começam em paralelo');
      meta = null;
      mediaPromise = Promise.any([
        downloadWithFallbacks(url),
        metaPromise.then(m => {
          if (!m) throw new Error('TikWM sem dados');
          return downloadTikWMVideo(m);
        })
      ]).catch(e => { throw (e.errors && e.errors[0]) || e; });
    }
    // Evita "unhandled rejection" quando a legenda resolve e o vídeo nunca é aguardado
    mediaPromise.catch(() => {});

    // 2. ROTA RÁPIDA: legenda com receita → responde sem esperar o vídeo
    if (meta && captionLooksLikeRecipe(meta.description)) {
      const captionRecipe = await extractRecipeFromCaption(meta.description, authorFromUrl(url) || meta.author);
      if (captionRecipe) {
        setCachedRecipe(url, captionRecipe);
        const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n🏁 TOTAL: ${totalElapsed}s [FAST PATH — legenda]\n`);
        return res.json(captionRecipe);
      }
    }

    // 3. Esperar o download do vídeo
    let mediaData;
    try {
      mediaData = await mediaPromise;
    } catch (downloadError) {
      console.error('[Download] ❌ Todos os provedores falharam:', downloadError.message);
      const errorMsg = downloadError.isRateLimit
        ? 'O TikTok está bloqueando downloads temporariamente. Tente novamente em alguns minutos.'
        : 'Não foi possível baixar o vídeo do TikTok. Verifique se o link é válido e se o vídeo é público.';
      const errorCode = downloadError.isRateLimit ? 'DOWNLOAD_BLOCKED' : 'DOWNLOAD_FAILED';
      return res.status(400).json({
        error: errorMsg,
        errorCode,
        debug_error: downloadError.message
      });
    }

    const downloadElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Download] ⏱️  ${downloadElapsed}s (${mediaData.type})`);
    if (mediaData.description) {
      console.log(`[Legenda] 📝 Descrição encontrada (${mediaData.description.length} chars)`);
    } else {
      console.log(`[Legenda] ⚠️  Sem descrição/legenda disponível`);
    }

    // Legenda vinda de um provedor alternativo (o TikWM falhou, então ela ainda não foi lida)
    if (!meta && captionLooksLikeRecipe(mediaData.description)) {
      const captionRecipe = await extractRecipeFromCaption(mediaData.description, authorFromUrl(url) || mediaData.author);
      if (captionRecipe) {
        setCachedRecipe(url, captionRecipe);
        const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n🏁 TOTAL: ${totalElapsed}s (download: ${downloadElapsed}s) [FAST PATH — legenda]\n`);
        return res.json(captionRecipe);
      }
    }

    // ── ROTA PADRÃO: Processar VÍDEO com Gemini ──
    console.log(`[Gemini] Processando ${mediaData.type} com ${MODEL}...`);
    const geminiStart = Date.now();

    const mediaSizeMB = mediaData.buffer.length / (1024 * 1024);
    // Envio direto (inline) é bem mais rápido que a File API, mas o pedido ao Gemini
    // tem limite de 20MB e o base64 aumenta o arquivo em ~33% → até 14MB cabe.
    const USE_FILE_API_THRESHOLD_MB = 14;

    // Duração do vídeo: pelo TikWM ou lida do próprio arquivo MP4.
    const videoSeconds = mediaData.duration || mp4DurationSeconds(mediaData.buffer);
    const isLongVideo = videoSeconds ? videoSeconds >= LONG_VIDEO_SECONDS : mediaSizeMB > 30;
    if (videoSeconds) console.log(`[Video] 🎬 Duração: ${Math.round(videoSeconds)}s${isLongVideo ? ' (vídeo longo)' : ''}`);

    const promptText = `Extraia a receita deste conteúdo. Ingredientes e modo de preparo devem vir SOMENTE do que é dito, mostrado ou escrito na legenda. Em cada ingrediente, coloque a quantidade sempre que ela for dita ou mostrada em qualquer momento do vídeo (ex: "4 ovos", "1/2 xícara de óleo", "450 g de polvilho doce") — não deixe só o nome se a quantidade foi dita. Antes, anote em "falas_ingredientes" as frases do vídeo que citam ingredientes e quantidades, e use-as para montar a lista. Para calorias (kcal), estime os valores nutricionais de cada ingrediente.${mediaData.description ? `\n\n--- LEGENDA/DESCRIÇÃO DO VÍDEO ---\n${mediaData.description}` : ''}`;

    let contentParts;

    if (mediaSizeMB > USE_FILE_API_THRESHOLD_MB) {
      console.log(`[Gemini] Arquivo grande (${mediaSizeMB.toFixed(1)}MB) — usando File API`);
      const fileRef = await uploadToGeminiFileAPI(mediaData.buffer, mediaData.mimeType, mediaData.type);
      contentParts = [
        { fileData: { fileUri: fileRef.uri, mimeType: fileRef.mimeType } },
        { text: promptText }
      ];
    } else {
      console.log(`[Gemini] Arquivo pequeno (${mediaSizeMB.toFixed(1)}MB) — usando inline`);
      contentParts = [
        { inlineData: { data: mediaData.buffer.toString('base64'), mimeType: mediaData.mimeType } },
        { text: promptText }
      ];
    }

    let transcriptPromise = null;

    const response = await callGeminiWithRetry(() => ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: contentParts }],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: RECIPE_SCHEMA,
        // Resolução baixa: ~4x menos dados por quadro → IA responde mais rápido. O áudio não muda.
        mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
        // Vídeo longo: um pouco de raciocínio para não perder ingredientes e quantidades
        // ditos ao longo de 10+ minutos. Vídeo curto continua sem (mais rápido).
        thinkingConfig: { thinkingBudget: isLongVideo ? 1024 : 0 },
        temperature: 0,
        // Receitas de vídeos longos são maiores; 4000 cortava a resposta no meio.
        // O limite maior não deixa as receitas curtas mais lentas.
        maxOutputTokens: 8192
      }
    }));

    let textResponse = response.text;
    const geminiElapsed = ((Date.now() - geminiStart) / 1000).toFixed(1);
    console.log(`[Gemini] ✅ Resposta em ${geminiElapsed}s`);

    const recipeData = JSON.parse(textResponse);

    // Verificar se o Gemini indicou que não encontrou receita
    if (recipeData.erro) {
      console.warn(`[Gemini] ⚠️  Nenhuma receita encontrada: ${recipeData.erro}`);
      // Detectar se é uma compilação com múltiplas receitas
      const isCompilation = /múltiplas|compilação|várias receitas|multiple|compilation/i.test(recipeData.erro);
      const errorMsg = isCompilation
        ? 'Este vídeo parece conter múltiplas receitas. Tente com um vídeo que contenha uma única receita.'
        : 'O vídeo não contém uma receita clara com ingredientes e modo de preparo. Verifique se o vídeo é de uma receita culinária.';
      const errorCode = isCompilation ? 'MULTIPLE_RECIPES' : 'NO_RECIPE';
      return res.status(400).json({ error: errorMsg, errorCode });
    }

    // Validação básica: verificar se a receita tem estrutura mínima
    if (!recipeData.titulo || !recipeData.ingredientes || !recipeData.modo_preparo) {
      console.warn('[Gemini] ⚠️  Resposta sem estrutura de receita válida');
      return res.status(400).json({
        error: 'O vídeo não parece conter uma receita completa. Tente com um vídeo que mostre ingredientes e modo de preparo.',
        errorCode: 'NO_RECIPE'
      });
    }

    // ── Ingredientes sem quantidade (ou sem ingredientes) ──
    // Em vídeos longos a pessoa fala as quantidades aos poucos, enquanto cozinha, e a
    // IA às vezes lista só "Ovos, Óleo...". Nesse caso a lista é refeita a partir da
    // TRANSCRIÇÃO da fala, onde "4 ovos" e "meia xícara de óleo" estão escritos.
    const elapsedSoFar = Date.now() - startTime;
    const qty = ingredientsWithoutQuantity(recipeData);
    const needsFix = qty.total === 0
      || (isLongVideo ? qty.missing > 0 : qty.missing / qty.total > 0.5);
    if (needsFix && elapsedSoFar < 220000) {
      console.warn(`[Gemini] ⚠️  Ingredientes: ${qty.total} itens, ${qty.missing} sem quantidade — refazendo a lista pela transcrição`);
      const fixStart = Date.now();
      try {
        // Fonte do reparo: as frases que a própria IA anotou (texto, pedido leve). Se ela
        // não anotou nada, transcreve a fala do vídeo.
        const falas = (recipeData.falas_ingredientes || []).filter(Boolean);
        const transcript = falas.length >= 2
          ? falas.join('\n')
          : await (transcriptPromise || transcribeSpeech(contentParts[0]).catch(() => ''));
        // Sem transcrição (falhou): a IA olha o vídeo de novo, só atrás dos ingredientes.
        const source = transcript
          ? `--- FALAS DO VÍDEO (transcrição) ---\n${transcript}`
          : '--- A FONTE É O VÍDEO ACIMA: assista e ouça ele INTEIRO ---';
        const ingResponse = await callGeminiWithRetry(() => ai.models.generateContent({
          model: MODEL,
          contents: [{ role: 'user', parts: [...(transcript ? [] : [contentParts[0]]), { text:
`Monte a lista COMPLETA de ingredientes da receita "${recipeData.titulo}" com a QUANTIDADE EXATA de cada um, como foi dita no vídeo (ex: "4 ovos", "1/2 xícara de óleo", "1/2 colher de sopa de sal", "450 g de polvilho doce").
- Procure no conteúdo inteiro: a quantidade pode ser dita em qualquer momento (às vezes depois, ao colocar o ingrediente).
- Se a pessoa disser a quantidade aos poucos (ex: "mais um pouco"), use o total que ela disser; se não disser, use "A gosto" ou "Quantidade não especificada".
- Não invente ingrediente nem quantidade. Estime as calorias (kcal) de cada ingrediente pela quantidade.

${source}
${mediaData.description ? `\n--- LEGENDA DO VÍDEO ---\n${mediaData.description}\n` : ''}
--- MODO DE PREPARO JÁ EXTRAÍDO ---
${JSON.stringify(recipeData.modo_preparo)}` }] }],
          config: {
            systemInstruction: SYSTEM_INSTRUCTION,
            responseMimeType: "application/json",
            responseSchema: INGREDIENTS_SCHEMA,
            mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
            thinkingConfig: { thinkingBudget: transcript ? 1024 : 2048 },
            temperature: 0,
            maxOutputTokens: 8192
          }
        }));
        const ingData = JSON.parse(ingResponse.text);
        const newQty = ingredientsWithoutQuantity(ingData);
        console.log(`[Gemini] Lista refeita: ${(ingData.ingredientes || []).flatMap(sec => (sec.itens || []).map(i => i.descricao)).join(' | ')}`);
        if (newQty.total > 0 && (qty.total === 0 || newQty.missing < qty.missing)) {
          recipeData.ingredientes = ingData.ingredientes;
          if (ingData.calorias_totais) recipeData.calorias_totais = ingData.calorias_totais;
          console.log(`[Gemini] ✅ Lista refeita: ${newQty.total} itens, ${newQty.missing} sem quantidade (${((Date.now() - fixStart) / 1000).toFixed(1)}s)`);
        } else {
          console.warn(`[Gemini] ⚠️  Lista refeita não ficou melhor (${newQty.total} itens, ${newQty.missing} sem quantidade) — mantendo a primeira`);
        }
      } catch (fixErr) {
        console.warn(`[Gemini] ⚠️  Falha ao refazer os ingredientes: ${fixErr.message}`);
      }
    }
    transcriptPromise = null;

    normalizeRecipe(recipeData);

    // Adicionar créditos do autor
    const author = authorFromUrl(url) || mediaData.author;
    if (author) {
      recipeData.creditos_autor = author.startsWith('@') ? author : `@${author}`;
    }

    // Armazenar no cache
    setCachedRecipe(url, recipeData);

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n🏁 TOTAL: ${totalElapsed}s (download: ${downloadElapsed}s, gemini: ${geminiElapsed}s)\n`);

    res.json(recipeData);

  } catch (error) {
    console.error('[Error] ❌ Erro ao processar URL:', error.message || error);
    if (error.stack) console.error('[Error] Stack:', error.stack);

    let userError = 'Ocorreu um erro interno ao processar a receita. Tente novamente.';
    let errorCode = 'INTERNAL_ERROR';
    const msg = error.message || '';

    if (error.isDailyQuota) {
      userError = 'O limite de uso da IA foi atingido. Tente novamente mais tarde.';
      errorCode = 'AI_DAILY_LIMIT';
      console.error('[Gemini] ❌ TODAS AS CHAVES NO LIMITE — adicione mais chaves em GEMINI_API_KEYS');
    } else if (msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('ECONNABORTED')) {
      userError = 'O processamento excedeu o tempo limite. Vídeos muito longos podem não ser suportados. Tente com um vídeo mais curto ou tente novamente.';
      errorCode = 'TIMEOUT';
    } else if (msg.includes('Unterminated string') || msg.includes('JSON') || msg.includes('Unexpected token')) {
      userError = 'A receita gerada foi muito longa e foi cortada. Tente novamente — normalmente funciona na segunda tentativa.';
      errorCode = 'AI_TRUNCATED';
    } else if (msg.includes('503') || msg.includes('429') || msg.includes('overloaded') || msg.includes('RESOURCE_EXHAUSTED')) {
      userError = 'O serviço de IA está temporariamente sobrecarregado. Aguarde alguns segundos e tente novamente.';
      errorCode = 'AI_OVERLOADED';
    } else if (msg.includes('SAFETY') || msg.includes('blocked')) {
      userError = 'O conteúdo do vídeo foi bloqueado pelo filtro de segurança da IA. Tente com outro vídeo.';
      errorCode = 'SAFETY_BLOCKED';
    } else if (msg.includes('File API') || msg.includes('upload')) {
      userError = 'Não foi possível processar o vídeo. O arquivo pode ser muito grande. Tente com um vídeo mais curto.';
      errorCode = 'UPLOAD_FAILED';
    }

    res.status(500).json({
      error: userError,
      errorCode,
      details: error.message
    });
  }
});

app.post('/api/recipe/text', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Texto é obrigatório." });

  try {
    const startTime = Date.now();
    console.log(`\n[Text] Processando texto (${text.length} chars)...`);

    const response = await callGeminiWithRetry(() => ai.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            { text: `Extraia a receita do texto abaixo. Ingredientes e modo de preparo devem vir SOMENTE do texto. Para calorias (kcal), estime os valores nutricionais de cada ingrediente.\n\n${text}` }
          ]
        }
      ],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: RECIPE_SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
        temperature: 0,
        maxOutputTokens: 4000
      }
    }));

    let textResponse = response.text;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Gemini] ✅ Resposta em ${elapsed}s`);

    const recipeData = JSON.parse(textResponse);
    res.json(recipeData);

  } catch (error) {
    console.error('Error processing text:', error);
    res.status(500).json({ error: 'Falha ao processar o texto e gerar a receita.', details: error.message });
  }
});

const PORT = process.env.PORT || 3001;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Backend server running on port ${PORT}`);
  });
}
module.exports = app;
