require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { GoogleGenAI, Type } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());
const upload = multer({ dest: '/tmp/' });

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ========================================================================
// Configuração Otimizada
// ========================================================================

const MODEL = 'gemini-2.5-flash';

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
7. Escreva o modo de preparo com ortografia, gramática e concordância corretas no português, mesmo que a pessoa no vídeo fale com gírias, erros ou de forma informal.`;

const RECIPE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    erro: { type: Type.STRING, description: "Preencha apenas se não houver receita no conteúdo. Deixe vazio ou omita se for sucesso." },
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
  }
};

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

      if (isRetryable && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1500;
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
  const ext = type === 'audio' ? 'mp3' : 'mp4';
  const tmpPath = path.join('/tmp', `gemini_upload_${Date.now()}.${ext}`);

  try {
    fs.writeFileSync(tmpPath, rawBuffer);

    const sizeMB = (rawBuffer.length / (1024 * 1024)).toFixed(1);
    console.log(`[File API] ⬆️  Uploading ${sizeMB}MB ${type} to Gemini...`);

    const uploadStart = Date.now();
    const uploadResult = await ai.files.upload({
      file: tmpPath,
      config: { mimeType, displayName: `tiktok_${type}_${Date.now()}` }
    });

    const uploadElapsed = ((Date.now() - uploadStart) / 1000).toFixed(1);
    console.log(`[File API] ✅ Upload concluído em ${uploadElapsed}s (${uploadResult.name})`);

    // Aguardar processamento do arquivo se necessário
    let file = uploadResult;
    let waitCount = 0;
    while (file.state === 'PROCESSING') {
      if (waitCount++ > 10) throw new Error('File API: timeout aguardando processamento');
      console.log('[File API] ⏳ Aguardando processamento...');
      await new Promise(r => setTimeout(r, 1500));
      file = await ai.files.get({ name: file.name });
    }

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

// ========================================================================
// TikTok Audio/Video Download (Audio-First Strategy)
// ========================================================================

/**
 * Tenta extrair ÁUDIO primeiro (muito mais rápido).
 * Fallback para vídeo SD caso áudio não disponível.
 */
async function downloadTikTokMedia(url) {
  console.log('[TikWM] Buscando metadata...');
  const startTime = Date.now();

  const response = await axios.get('https://www.tikwm.com/api/', {
    params: { url, hd: 0 },
    timeout: 10000
  });

  if (response.data.code !== 0 || !response.data.data) {
    throw new Error(`TikWM retornou código ${response.data.code}: ${response.data.msg}`);
  }

  const data = response.data.data;
  const author = data.author?.unique_id || null;
  const title = data.title || null;

  // ── SEMPRE baixar o VÍDEO ──
  // O campo "music" do TikWM retorna apenas a trilha sonora/música de fundo,
  // NÃO a narração do criador. A fala real está no track de áudio do vídeo.
  // Enviar apenas a música fazia o Gemini receber conteúdo sem receita
  // e alucinar/inventar uma receita para satisfazer o prompt.
  const videoUrl = data.play;
  if (!videoUrl) {
    throw new Error('TikWM: nenhuma URL de vídeo encontrada');
  }

  console.log('[Video] ⬇️  Baixando vídeo SD...');
  const videoResponse = await axios({
    url: videoUrl,
    method: 'GET',
    responseType: 'arraybuffer',
    timeout: 12000  // Otimizado: fail-fast sem quebrar downloads legítimos
  });

  const sizeMB = (videoResponse.data.byteLength / (1024 * 1024)).toFixed(1);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Video] ✅ Download completo: ${sizeMB}MB em ${elapsed}s`);

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
 * TikWM POST variant (fallback provider)
 */
async function downloadViaTikWMPost(url) {
  console.log('[TikWM-POST] Tentando...');
  const response = await axios({
    method: 'post',
    url: 'https://www.tikwm.com/api/',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Origin': 'https://www.tikwm.com',
      'Referer': 'https://www.tikwm.com/'
    },
    data: `url=${encodeURIComponent(url)}&count=12&cursor=0&web=1&hd=0`,
    timeout: 10000
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
    timeout: 12000  // Otimizado
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
  const response = await axios.post('https://ttsave.app/download',
    { id: url, locale: 'en', tt: 'ttsave' },
    {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 10000
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
    timeout: 12000,  // Otimizado: fail-fast
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
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
 * Download paralelo: lança TODOS os provedores ao mesmo tempo.
 * Resolve IMEDIATAMENTE quando qualquer provedor retorna áudio (mais rápido).
 * Se nenhum tiver áudio, aguarda todos e usa o primeiro vídeo.
 */
async function downloadTikTokMedia_Sequential(url) {
  const providers = [
    { name: 'TikWM', fn: downloadTikTokMedia },
    { name: 'TTSave', fn: downloadViaTTSave },
    { name: 'TikWM-POST', fn: downloadViaTikWMPost },
  ];

  console.log('[Fallback] 🚀 Iniciando download sequencial...');
  const errors = [];

  for (const provider of providers) {
    try {
      console.log(`[Fallback] Tentando provedor: ${provider.name}...`);
      const result = await provider.fn(url);
      console.log(`[Fallback] ✅ Sucesso com ${provider.name}`);
      return result;
    } catch (err) {
      console.error(`[Fallback] ❌ Falha em ${provider.name}: ${err.message}`);
      errors.push(`${provider.name}: ${err.message}`);
    }
  }

  throw new Error(`Nenhum provedor conseguiu baixar o vídeo.\nDetalhes:\n${errors.join('\n')}`);
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
        maxOutputTokens: 1500
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

app.post('/api/recipe/url', async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL é obrigatória." });

  // ── Sanitização de URL ──
  // Extrai apenas o link caso o usuário tenha colado um texto junto (ex: "Olha essa receita: https...")
  const urlMatch = url.match(/(https?:\/\/[^\s]+)/);
  if (urlMatch) {
    url = urlMatch[0];
  }
  // Remove pontuações no final do link (como vírgula, ponto, etc.)
  url = url.replace(/[,.!?;:]+$/, '').trim();


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

    // 1. Download da mídia (prioriza áudio)
    let mediaData;
    try {
      mediaData = await downloadTikTokMedia_Sequential(url);
    } catch (downloadError) {
      console.error('Todos os provedores falharam:', downloadError.message);
      return res.status(400).json({
        error: 'Não foi possível baixar o vídeo do TikTok. Verifique se o link está completo e se o vídeo é público. Se o problema persistir, tente novamente em alguns minutos.',
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

    // ── ROTA INTELIGENTE: Legenda com receita → processar como TEXTO (1-2s) ──
    // Se a legenda contém ingredientes/receita (>100 chars + palavras-chave),
    // processa apenas o texto — PULA o vídeo inteiro (economiza 10-15s).
    const captionHasRecipe = mediaData.description 
      && mediaData.description.length > 100
      && /ingredientes?|modo de preparo|colher|xícara|gramas?|\bg\b|\bml\b|\bkg\b/i.test(mediaData.description);

    if (captionHasRecipe) {
      console.log(`[Smart Route] ⚡ Legenda contém receita — processando como TEXTO (skip vídeo)`);
      const geminiStart = Date.now();

      try {
        const response = await callGeminiWithRetry(() => ai.models.generateContent({
          model: MODEL,
          contents: [{
            role: 'user',
            parts: [{
              text: `Extraia a receita do texto abaixo (legenda de um vídeo do TikTok). Ingredientes e modo de preparo devem vir SOMENTE do texto. Para calorias (kcal), estime os valores nutricionais de cada ingrediente.\n\n${mediaData.description}`
            }]
          }],
          config: {
            systemInstruction: SYSTEM_INSTRUCTION,
            responseMimeType: "application/json",
            responseSchema: RECIPE_SCHEMA,
            temperature: 0,
            maxOutputTokens: 1500
          }
        }));

        const textResult = JSON.parse(response.text);
        const geminiElapsed = ((Date.now() - geminiStart) / 1000).toFixed(1);
        console.log(`[Smart Route] ✅ Receita extraída da legenda em ${geminiElapsed}s`);

        // Validar: se a extração da legenda retornou uma receita válida (com ingredientes E modo de preparo), usar direto.
        // Caso contrário (ex: a legenda só tem a lista de ingredientes), faz o fallback para o vídeo para extrair o resto.
        const hasIngredients = textResult.ingredientes 
          && textResult.ingredientes.some(sec => sec.itens && sec.itens.length > 0);
        const hasSteps = textResult.modo_preparo 
          && textResult.modo_preparo.some(sec => sec.passos && sec.passos.length > 0);

        if (!textResult.erro && textResult.titulo && hasIngredients && hasSteps) {
          if (mediaData.author) {
            textResult.creditos_autor = mediaData.author.startsWith('@') ? mediaData.author : `@${mediaData.author}`;
          }
          setCachedRecipe(url, textResult);
          const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`\n🏁 TOTAL: ${totalElapsed}s (download: ${downloadElapsed}s, gemini-texto: ${geminiElapsed}s) [FAST PATH]\n`);
          return res.json(textResult);
        }
        console.log(`[Smart Route] ⚠️  Legenda não gerou receita válida — fallback para vídeo`);
      } catch (captionErr) {
        console.warn(`[Smart Route] ⚠️  Falha no processamento da legenda: ${captionErr.message} — fallback para vídeo`);
      }
    }

    // ── ROTA PADRÃO: Processar VÍDEO com Gemini ──
    console.log(`[Gemini] Processando ${mediaData.type} com ${MODEL}...`);
    const geminiStart = Date.now();

    const mediaSizeMB = mediaData.buffer.length / (1024 * 1024);
    const USE_FILE_API_THRESHOLD_MB = 8;

    let contentParts;

    if (mediaSizeMB > USE_FILE_API_THRESHOLD_MB) {
      console.log(`[Gemini] Arquivo grande (${mediaSizeMB.toFixed(1)}MB) — usando File API`);
      const fileRef = await uploadToGeminiFileAPI(mediaData.buffer, mediaData.mimeType, mediaData.type);
      const promptText = `Extraia a receita deste conteúdo. Ingredientes e modo de preparo devem vir SOMENTE do que é dito, mostrado ou escrito na legenda. Para calorias (kcal), estime os valores nutricionais de cada ingrediente.${mediaData.description ? `\n\n--- LEGENDA/DESCRIÇÃO DO VÍDEO ---\n${mediaData.description}` : ''}`;
      contentParts = [
        { fileData: { fileUri: fileRef.uri, mimeType: fileRef.mimeType } },
        { text: promptText }
      ];
    } else {
      console.log(`[Gemini] Arquivo pequeno (${mediaSizeMB.toFixed(1)}MB) — usando inline`);
      const promptText = `Extraia a receita deste conteúdo. Ingredientes e modo de preparo devem vir SOMENTE do que é dito, mostrado ou escrito na legenda. Para calorias (kcal), estime os valores nutricionais de cada ingrediente.${mediaData.description ? `\n\n--- LEGENDA/DESCRIÇÃO DO VÍDEO ---\n${mediaData.description}` : ''}`;
      contentParts = [
        { inlineData: { data: mediaData.buffer.toString('base64'), mimeType: mediaData.mimeType } },
        { text: promptText }
      ];
    }

    const response = await callGeminiWithRetry(() => ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: contentParts }],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: RECIPE_SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
        temperature: 0,
        maxOutputTokens: 1500
      }
    }));

    let textResponse = response.text;
    const geminiElapsed = ((Date.now() - geminiStart) / 1000).toFixed(1);
    console.log(`[Gemini] ✅ Resposta em ${geminiElapsed}s`);

    const recipeData = JSON.parse(textResponse);

    // Verificar se o Gemini indicou que não encontrou receita
    if (recipeData.erro) {
      console.warn(`[Gemini] ⚠️  Nenhuma receita encontrada: ${recipeData.erro}`);
      return res.status(400).json({
        error: 'Não foi possível identificar uma receita neste vídeo. Verifique se o vídeo contém uma receita culinária com ingredientes e modo de preparo.'
      });
    }

    // Validação básica: verificar se a receita tem estrutura mínima
    if (!recipeData.titulo || !recipeData.ingredientes || !recipeData.modo_preparo) {
      console.warn('[Gemini] ⚠️  Resposta sem estrutura de receita válida');
      return res.status(400).json({
        error: 'O vídeo não parece conter uma receita completa. Tente com um vídeo que mostre ingredientes e modo de preparo.'
      });
    }

    // Adicionar créditos do autor
    if (mediaData.author) {
      recipeData.creditos_autor = mediaData.author.startsWith('@')
        ? mediaData.author
        : `@${mediaData.author}`;
    }

    // Armazenar no cache
    setCachedRecipe(url, recipeData);

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n🏁 TOTAL: ${totalElapsed}s (download: ${downloadElapsed}s, gemini: ${geminiElapsed}s)\n`);

    res.json(recipeData);

  } catch (error) {
    console.error('Error processing URL:', error);
    res.status(500).json({
      error: 'Ocorreu um erro interno ao processar a receita. Tente novamente.',
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
        maxOutputTokens: 1500
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
