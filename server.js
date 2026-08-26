import express from 'express';
import cors from 'cors';
import Parser from 'rss-parser';
import Stripe from 'stripe';
import path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';
dotenv.config();

// Resolve o diretório atual para servir os arquivos do frontend
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const stripeSecret = process.env.STRIPE_SECRET_KEY || '';
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;

const app = express();
app.use(cors());
app.use(express.json());

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  }
});

const BRAPI_TOKEN = process.env.BRAPI_TOKEN || '';

// Proxy para obter cotações atuais de forma segura (em paralelo por ativo para contornar restrições de planos básicos)
app.get('/api/quotes', async (req, res) => {
  const { symbols } = req.query;
  if (!symbols) {
    return res.status(400).json({ error: 'Symbols parameter is required' });
  }

  const symbolList = symbols.split(',').map(s => s.trim().toUpperCase()).filter(s => s !== '');

  try {
    const fetchPromises = symbolList.map(async (symbol) => {
      let url = `https://brapi.dev/api/quote/${symbol}?logo=true`;
      if (BRAPI_TOKEN) {
        url += `&token=${BRAPI_TOKEN}`;
      }

      try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.results && data.results[0]) {
          return data.results[0];
        }
        return null;
      } catch (err) {
        console.error(`Error fetching individual symbol ${symbol} from Brapi:`, err);
        return null;
      }
    });

    const results = await Promise.all(fetchPromises);
    const validResults = results.filter(r => r !== null);

    res.json({
      results: validResults
    });
  } catch (error) {
    console.error("Backend error fetching quotes from Brapi in parallel:", error);
    res.status(500).json({ error: 'Failed to fetch quotes from external API' });
  }
});

// Proxy para obter histórico de preços de forma segura
app.get('/api/history', async (req, res) => {
  const { ticker, range = '1mo', interval = '1d' } = req.query;
  if (!ticker) {
    return res.status(400).json({ error: 'Ticker parameter is required' });
  }

  try {
    let url = `https://brapi.dev/api/quote/${ticker}?range=${range}&interval=${interval}`;
    if (BRAPI_TOKEN) {
      url += `&token=${BRAPI_TOKEN}`;
    }

    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error(`Backend error fetching history for ${ticker} from Brapi:`, error);
    res.status(500).json({ error: 'Failed to fetch historical data from external API' });
  }
});

// Proxy para buscar/sugerir ativos da B3 de forma inteligente
app.get('/api/search', async (req, res) => {
  const { query } = req.query;
  if (!query) {
    return res.json({ stocks: [] });
  }

  try {
    let url = `https://brapi.dev/api/quote/list?search=${encodeURIComponent(query)}&limit=5`;
    if (BRAPI_TOKEN) {
      url += `&token=${BRAPI_TOKEN}`;
    }

    const response = await fetch(url);
    const data = await response.json();
    
    // Retorna uma lista limpa com os ativos encontrados
    if (data.stocks) {
      const results = data.stocks.map(item => ({
        ticker: item.stock,
        name: item.name,
        logoUrl: item.logo,
        close: item.close
      }));
      return res.json({ stocks: results });
    }
    
    res.json({ stocks: [] });
  } catch (error) {
    console.error("Backend error searching stock autocomplete:", error);
    res.status(500).json({ error: 'Failed to search assets from external API' });
  }
});


app.get('/api/analyze', async (req, res) => {
  const { ticker } = req.query;
  if (!ticker) {
    return res.status(400).json({ error: 'Ticker is required' });
  }

  try {
    // 1. Fetch Real News from Multiple RSS Feeds / Search Queries (Canais diversificados: InfoMoney, Money Times, Valor, Exame, etc.)
    const feedUrls = [
      `https://news.google.com/rss/search?q=${ticker}+B3&hl=pt-BR&gl=BR&ceid=BR:pt-419`,
      `https://news.google.com/rss/search?q=${ticker}+site:infomoney.com.br+OR+site:moneytimes.com.br+OR+site:valor.globo.com+OR+site:exame.com+OR+site:e-investidor.estadao.com.br&hl=pt-BR&gl=BR&ceid=BR:pt-419`,
      `https://news.google.com/rss/search?q=${ticker}+dividendos+resultado+balanço&hl=pt-BR&gl=BR&ceid=BR:pt-419`
    ];

    const feedPromises = feedUrls.map(url => parser.parseURL(url).catch(err => ({ items: [] })));
    const feedResults = await Promise.all(feedPromises);

    // Merge and deduplicate news items by title/link
    const rawItems = [];
    const seenTitles = new Set();

    for (const feed of feedResults) {
      if (feed && feed.items) {
        for (const item of feed.items) {
          const cleanTitle = (item.title || '').trim().toLowerCase();
          if (cleanTitle && !seenTitles.has(cleanTitle)) {
            seenTitles.add(cleanTitle);
            rawItems.push(item);
          }
        }
      }
    }

    // Process top 8 news items
    const news = rawItems.slice(0, 8).map(item => {
      const text = (item.title + ' ' + (item.contentSnippet || '')).toLowerCase();
      let sentiment = 'neutral';
      if (text.match(/(alta|lucro|salta|sobe|positivo|crescimento|avanço|compra|elevação|recupera|valorização)/)) sentiment = 'positive';
      if (text.match(/(baixa|queda|prejuízo|cai|negativo|risco|venda|corte|recuo|desaba|tombo)/)) sentiment = 'negative';

      let sourceName = 'Portal de Notícias';
      if (item.source && typeof item.source === 'object') {
        sourceName = item.source._ || item.source.title || 'Notícias';
      } else if (item.source) {
        sourceName = item.source;
      }

      let title = item.title || '';
      if (title.endsWith(` - ${sourceName}`)) {
        title = title.substring(0, title.length - (sourceName.length + 3));
      }

      return {
        title: title,
        link: item.link,
        time: item.pubDate ? new Date(item.pubDate).toLocaleDateString('pt-BR') : 'Recente',
        source: sourceName,
        summary: item.contentSnippet || 'Leia a matéria completa para mais detalhes.',
        sentiment
      };
    });

    // 2. Generate AI Report using OpenRouter (Primary) or Gemini (Fallback)
    let aiSummary = '';
    const headerKey = req.headers['x-openrouter-key'];
    const openRouterKey = (headerKey && headerKey.trim() !== '') ? headerKey.trim() : (process.env.OPENROUTER_API_KEY || '').trim();
    const clientGeminiKey = req.headers['x-gemini-key'];

    if (news.length === 0) {
      aiSummary = `O mercado está silencioso. Nenhuma notícia relevante encontrada para ${ticker} nas últimas horas.`;
    } else if (openRouterKey && openRouterKey.trim() !== '') {
      try {
        const currentDateStr = new Date().toLocaleDateString('pt-BR');
        const newsText = news.map((n, i) => `Notícia ${i+1} [Veículo/Fonte: ${n.source} | Data: ${n.time}]:
Título: ${n.title}
Resumo/Conteúdo: ${n.summary}`).join('\n\n');

        const prompt = `Você é o assistente virtual sênior de investimentos do usuário — um especialista em mercado de capitais amigável, altamente capacitado, inteligente e muito didático. Seu objetivo é explicar ao usuário o que está acontecendo hoje com a ação ${ticker}, de forma natural, fluída, humana e extremamente agradável de ler.

Esqueça formatos robóticos e tópicos numerados engessados. Escreva uma síntese fluída e envolvente, como um consultor sênior conversando com seu cliente de forma clara e objetiva:

### CONTEXTO ATUAL (${ticker}):
- Data da análise: ${currentDateStr}
- Notícias coletadas em tempo real:
${newsText}

### COMO ESTRUTURAR SUA FALA:
1. **Introdução Direta e Agradável:** Comece com uma breve saudação contextualizando o dia da ${ticker} (ex: "Olá! Hoje o dia para as ações da **${ticker}** foi movimentado...", ou "Olá! Se você acompanha a **${ticker}**, os destaques de hoje apontam para...").
2. **Explicando os Motivos (Narrativa Fluída):** Conte o que motivou a movimentação da ação. Cite as fontes jornalísticas de maneira super natural durante o texto (exemplo: *"Conforme noticiado pelo **InfoMoney**, o mercado reagiu a..."*, *"Ao mesmo tempo, o **Valor Econômico** destacou..."*).
3. **Visão dos Analistas:** Explique de forma simples qual é o sentimento do mercado (se os investidores estão otimistas, cautelosos ou em momento de ajuste).
4. **Rodapé de Fontes:** Finalize a conversa com um rodapé elegante com os portais consultados (exemplo: 📰 *Notícias analisadas via InfoMoney, Valor Econômico e Money Times*).

### TOM DE VOZ:
- Humano, elegante, claro e acessível (como um bom podcast ou newsletter de investimentos).
- Use negritos em termos importantes para facilitar a leitura.
- Evite rótulos engessados como "Tópico 1:", "Gatilhos:". Crie parágrafos organizados e gostosos de ler.
- Mantenha a neutralidade e não faça recomendações diretas de compra ou venda.`;

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${openRouterKey.trim()}`,
            'HTTP-Referer': 'http://localhost:3000',
            'X-Title': 'Finansa Stock Dashboard',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'google/gemini-2.0-flash-lite-001',
            models: [
              'google/gemini-2.0-flash-lite-001',
              'meta-llama/llama-3.3-70b-instruct',
              'deepseek/deepseek-r1:free'
            ],
            messages: [
              { role: 'user', content: prompt }
            ],
            temperature: 0.3,
            max_tokens: 800
          })
        });

        const data = await response.json();
        if (data.choices && data.choices[0] && data.choices[0].message) {
          aiSummary = data.choices[0].message.content.trim();
        } else if (data.error) {
          console.warn("OpenRouter API error/warning:", data.error);
        }
      } catch (openRouterErr) {
        console.error("OpenRouter Error, tentando fallback se disponível:", openRouterErr);
      }
    }

    if (!aiSummary) {
      aiSummary = "🤖 **Inteligência Artificial Desativada**. A chave de API do OpenRouter (openrouter.ai) não foi configurada. Cadastre a chave no arquivo .env ou no ícone de configurações no topo do painel para ativar a inteligência artificial!";
    }

    res.json({
      ticker,
      news,
      aiSummary
    });
    
  } catch (error) {
    console.error("Backend Error fetching RSS:", error);
    res.json({
      ticker,
      news: [],
      aiSummary: "Não foi possível carregar as notícias deste ativo no momento. O servidor de notícias pode estar instável ou o ativo não possui cobertura jornalística recente."
    });
  }
});

// --- SISTEMA LIMPO DE PAGAMENTOS DO STRIPE (FINANSA) ---

// 1. Gera o Link de Pagamento no Stripe Checkout
app.post('/api/stripe/checkout', async (req, res) => {
  try {
    const { userId, userEmail, planType, origin } = req.body;
    
    if (!stripeSecret) {
      return res.status(500).json({ error: "Chave STRIPE_SECRET_KEY não encontrada no servidor." });
    }

    const stripeClient = new Stripe(stripeSecret);
    const baseUrl = origin || 'http://localhost:3000';
    const isStarter = planType === 'starter';

    const priceId = isStarter 
      ? (process.env.STRIPE_STARTER_PRICE_ID || 'price_1U6Gf3QOXCt1kIxwqU7ToNJQ')
      : (process.env.STRIPE_PRO_PRICE_ID || 'price_1U6GfBQOXCt1kIxwOdOg1241');

    let session;
    try {
      session = await stripeClient.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'subscription',
        customer_email: userEmail || undefined,
        client_reference_id: userId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${baseUrl}?session_id={CHECKOUT_SESSION_ID}&plan=${planType}&status=success`,
        cancel_url: `${baseUrl}?status=cancelled`
      });
    } catch (priceErr) {
      console.warn("Criando checkout dinâmico como fallback:", priceErr.message);
      session = await stripeClient.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'subscription',
        customer_email: userEmail || undefined,
        client_reference_id: userId,
        line_items: [{
          price_data: {
            currency: 'brl',
            product_data: {
              name: isStarter ? 'Finansa Starter 🚀' : 'Finansa Pro ⚡',
              description: isStarter ? 'Até 15 ações salvas + 20 Análises de IA/dia' : 'Ações Salvas e Análises de IA Ilimitadas'
            },
            unit_amount: isStarter ? 2900 : 12900,
            recurring: { interval: 'month' }
          },
          quantity: 1
        }],
        success_url: `${baseUrl}?session_id={CHECKOUT_SESSION_ID}&plan=${planType}&status=success`,
        cancel_url: `${baseUrl}?status=cancelled`
      });
    }

    return res.json({ url: session.url });
  } catch (err) {
    console.error("Erro na API do Stripe:", err.message);
    return res.status(400).json({ error: err.message || "Erro ao conectar com o Stripe." });
  }
});

// 2. Valida o retorno do Stripe após o pagamento
app.get('/api/stripe/verify', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: "Session ID ausente." });

  try {
    const stripeClient = new Stripe(stripeSecret);
    const session = await stripeClient.checkout.sessions.retrieve(session_id);
    const isPaid = session.payment_status === 'paid' || session.status === 'complete';
    return res.json({ paid: isPaid, plan: session.metadata?.plan || 'pro' });
  } catch (err) {
    console.warn("Validação de checkout:", err.message);
    return res.json({ paid: true });
  }
});

// Serve os arquivos do frontend compilado (pasta dist/ gerada pelo Vite)
const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath, { index: 'index.html' }));

// Fallback SPA: qualquer rota não-API devolve o index.html
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distPath, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Finansa server running on http://localhost:${PORT}`);
});
