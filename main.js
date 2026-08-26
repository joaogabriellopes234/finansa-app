import './style.css'
import { createClient } from '@supabase/supabase-js'

// Define a base da API dinamicamente para funcionar localmente e em hospedagens como o Railway
const API_BASE = (window.location.origin.includes('localhost') || window.location.origin.includes('127.0.0.1'))
  ? 'http://localhost:3000'
  : window.location.origin;

// Inicialização do Supabase com tratamento de erro e suporte a modo Simulação (Mock)
let supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
let supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

let supabase = null;
let useMockAuth = true;
let currentUser = null; // Guarda os dados do usuário atual (logado ou simulado)

function initSupabase() {
  if (supabaseUrl && supabaseKey) {
    try {
      supabase = createClient(supabaseUrl, supabaseKey);
      useMockAuth = false;
      console.log("Supabase inicializado com sucesso!");
    } catch (err) {
      console.warn("Erro ao inicializar Supabase, usando autenticação simulada:", err);
      useMockAuth = true;
      supabase = null;
    }
  } else {
    console.log("Supabase não configurado. Utilizando autenticação simulada (Mock).");
    useMockAuth = true;
    supabase = null;
  }
}

initSupabase();

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000; // 48 horas (2 dias) em milissegundos

let savedStocks = JSON.parse(localStorage.getItem('my_stocks') || 'null');
let myStocks = savedStocks && savedStocks.length > 0 ? savedStocks : ['PETR4', 'VALE3', 'ITUB4', 'WEGE3'];
let currentStock = myStocks[0] || null;

let usedStocksHistory = [];
let quotaResetTimestamp = Date.now();

// Retorna as chaves do localStorage baseadas no usuário atual
function getUserStorageKeys() {
  if (!currentUser) {
    return {
      stocksKey: 'my_stocks',
      usedKey: 'used_stocks_history',
      resetKey: 'quota_reset_timestamp'
    };
  }
  const prefix = currentUser.isMock ? `mock_db_${currentUser.id}` : `user_${currentUser.id}`;
  return {
    stocksKey: `${prefix}_stocks`,
    usedKey: `${prefix}_used_stocks_history`,
    resetKey: `${prefix}_quota_reset_timestamp`
  };
}

// Verifica se se passaram 48h (2 dias) para renovar as cotas gastas do ciclo
function checkAndResetQuota() {
  const keys = getUserStorageKeys();
  let resetTime = parseInt(localStorage.getItem(keys.resetKey) || '0', 10);
  const now = Date.now();

  if (!resetTime) {
    resetTime = now;
    localStorage.setItem(keys.resetKey, resetTime.toString());
  }

  const elapsed = now - resetTime;

  if (elapsed >= TWO_DAYS_MS) {
    // Passaram-se 48h: Zera o histórico de cotas gastas do ciclo mantendo apenas as ativas
    quotaResetTimestamp = now;
    usedStocksHistory = [...myStocks];
    localStorage.setItem(keys.resetKey, quotaResetTimestamp.toString());
    localStorage.setItem(keys.usedKey, JSON.stringify(usedStocksHistory));
  } else {
    quotaResetTimestamp = resetTime;
    let storedUsed = JSON.parse(localStorage.getItem(keys.usedKey) || 'null');
    if (!storedUsed || !Array.isArray(storedUsed)) {
      usedStocksHistory = [...myStocks];
      localStorage.setItem(keys.usedKey, JSON.stringify(usedStocksHistory));
    } else {
      usedStocksHistory = storedUsed;
    }
  }
}

// Formata o tempo restante para a renovação das cotas (ex: "1d 22h" ou "18h 45m")
function getTimeUntilQuotaReset() {
  checkAndResetQuota();
  const now = Date.now();
  const remainingMs = Math.max(0, TWO_DAYS_MS - (now - quotaResetTimestamp));

  const totalMinutes = Math.floor(remainingMs / (1000 * 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `${days}d ${remHours}h`;
  }
  return `${hours}h ${minutes}m`;
}

let currentFilter = 'all';
let currentPeriod = '1M'; // Período padrão do gráfico
let quotesData = {}; // Guarda dados de cotação atual
let aiData = {}; // Guarda notícias e resumos de IA
let stockHistory = {}; // Guarda pontos históricos dos últimos 10 dias
let isFetching = false;

// Referências de Elementos do DOM
const stocksListEl = document.getElementById('stocks-list');
const dashboardContentEl = document.getElementById('dashboard-content');
const searchInput = document.getElementById('stock-search-input');
const addNewStockBtn = document.getElementById('add-new-stock-btn');
const searchSuggestionsEl = document.getElementById('search-suggestions');
let searchTimeout = null;

// Formatador de Moeda (BRL)
const formatCurrency = (val) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(val || 0);

// Gera caminho estático para mini-gráficos na barra lateral
const generateChartPath = (isPositive) => {
  return isPositive 
    ? "M 0 20 Q 10 15, 20 20 T 40 10 T 60 15 T 80 5 T 100 0"
    : "M 0 0 Q 10 5, 20 0 T 40 10 T 60 5 T 80 15 T 100 20";
};

// Conversor simples de Markdown para HTML
function parseMarkdown(text) {
  return text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br/>');
}



const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

// Busca a análise de notícias com a IA no backend com cache de 4 horas no localStorage
async function fetchAiAnalysis(ticker) {
  if (aiData[ticker] && aiData[ticker].loaded) return; 

  // 1. Tenta carregar do cache local (válido por 4 horas)
  const cacheKey = `ai_cache_${ticker}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      const now = Date.now();
      if (now - parsed.timestamp < FOUR_HOURS_MS) {
        aiData[ticker] = {
          loaded: true,
          loading: false,
          news: parsed.news || [],
          summary: parsed.summary || 'Sem análise disponível.'
        };
        if (currentStock === ticker) renderDashboard();
        return;
      }
    } catch (e) {
      console.warn("Erro ao ler cache local de IA:", e);
    }
  }

  // 2. Checa limite diário de requisições de IA para usuários do Plano Free
  const limits = getUserLimits();
  const userId = currentUser ? currentUser.id : 'anon';
  const todayStr = new Date().toISOString().split('T')[0];
  const aiDateKey = `ai_requests_date_${userId}`;
  const aiCountKey = `ai_requests_count_${userId}`;
  
  let lastDate = localStorage.getItem(aiDateKey);
  let currentCount = parseInt(localStorage.getItem(aiCountKey) || '0', 10);
  
  if (lastDate !== todayStr) {
    localStorage.setItem(aiDateKey, todayStr);
    localStorage.setItem(aiCountKey, '0');
    currentCount = 0;
  }

  if (!limits.isPro && currentCount >= limits.maxAiPerDay) {
    aiData[ticker] = {
      loaded: true,
      loading: false,
      news: aiData[ticker]?.news || [],
      summary: `⚠️ **Limite diário de Análises de IA atingido (${limits.maxAiPerDay}/${limits.maxAiPerDay} hoje)**. Você pode continuar lendo as notícias mais recentes do mercado logo abaixo, ou ative o **Finansa PRO ⚡** para ter análises ilimitadas todos os dias!`
    };
    if (currentStock === ticker) renderDashboard();
    return;
  }

  // 3. Se não extrapolou limite, consulta a API de IA
  aiData[ticker] = { loaded: false, loading: true, news: [], summary: 'Conectando ao Motor de IA...' };
  if (currentStock === ticker) renderDashboard();

  try {
    const userOpenRouterKey = localStorage.getItem('openrouter_api_key') || localStorage.getItem('gemini_api_key') || '';
    const headers = {};
    if (userOpenRouterKey) {
      headers['x-openrouter-key'] = userOpenRouterKey;
      headers['x-gemini-key'] = userOpenRouterKey;
    }
    const res = await fetch(`${API_BASE}/api/analyze?ticker=${ticker}`, { headers });
    const data = await res.json();
    
    const payload = {
      loaded: true,
      loading: false,
      news: data.news || [],
      summary: data.aiSummary || 'Sem análise disponível.'
    };

    aiData[ticker] = payload;

    // Incrementa contagem de uso de IA no Supabase e LocalStorage
    if (!limits.isPro) {
      await incrementAiUsageInSupabase();
    }

    // Grava no localStorage com timestamp
    localStorage.setItem(cacheKey, JSON.stringify({
      timestamp: Date.now(),
      news: payload.news,
      summary: payload.summary
    }));
  } catch (e) {
    aiData[ticker] = {
      loaded: true,
      loading: false,
      news: [],
      summary: 'Falha ao conectar com o servidor de Inteligência Artificial.'
    };
  }
  
  if (currentStock === ticker) {
    renderDashboard();
  }
}

// Busca cotações reais da B3 via backend proxy (segurança em primeiro lugar)
async function fetchQuotes(isSilent = false) {
  if (myStocks.length === 0) return;
  isFetching = true;
  if (!isSilent) {
    renderSidebarLoading();
    renderDashboardLoading();
  }

  try {
    const symbols = myStocks.join(',');
    const res = await fetch(`${API_BASE}/api/quotes?symbols=${symbols}`);
    const data = await res.json();

    if (data.error) {
      console.warn("Brapi API proxy retornou erro:", data);
    } else if (data.results) {
      data.results.forEach(item => {
        quotesData[item.symbol] = {
          ticker: item.symbol,
          name: item.shortName || item.longName || item.symbol,
          price: item.regularMarketPrice || 0,
          variationValue: item.regularMarketChange || 0,
          variationPercent: item.regularMarketChangePercent || 0,
          isPositive: (item.regularMarketChangePercent || 0) >= 0,
          logoUrl: item.logourl || null
        };
      });
    }

    if (!quotesData[currentStock] && myStocks.length > 0) {
      const firstValid = myStocks.find(ticker => quotesData[ticker]);
      currentStock = firstValid || myStocks[0];
    }
  } catch (err) {
    console.error("Erro de conexão com o servidor backend:", err);
  } finally {
    isFetching = false;
    renderSidebar();
    renderDashboard();
  }
}

// Carrega o histórico de preços real via backend proxy
async function fetchHistory(ticker, currentPrice, isPositive) {
  const historyKey = `${ticker}_${currentPeriod}`;
  if (stockHistory[historyKey] && stockHistory[historyKey].loaded) return;
  
  stockHistory[historyKey] = { loaded: false, loading: true, error: false, points: [] };
  
  const rangeMap = { '5D': '5d', '1M': '1mo', '6M': '6mo', '1A': '1y' };
  const intervalMap = { '5D': '1d', '1M': '1d', '6M': '1d', '1A': '5d' };
  const range = rangeMap[currentPeriod] || '1mo';
  const interval = intervalMap[currentPeriod] || '1d';

  const isLongPeriod = currentPeriod === '6M' || currentPeriod === '1A';

  try {
    const res = await fetch(`${API_BASE}/api/history?ticker=${ticker}&range=${range}&interval=${interval}`);
    const data = await res.json();
    if (data.results && data.results[0] && data.results[0].historicalDataPrice) {
      // Pega todos os pontos retornados pela API
      const points = data.results[0].historicalDataPrice.map(item => {
        const dateObj = new Date(item.date * 1000);
        let dateFormatted = '';
        if (isLongPeriod) {
          const monthStr = dateObj.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
          const monthCap = monthStr.charAt(0).toUpperCase() + monthStr.slice(1);
          const yearStr = dateObj.getFullYear().toString().slice(-2);
          dateFormatted = `${monthCap}/${yearStr}`;
        } else {
          dateFormatted = dateObj.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        }

        return {
          date: dateFormatted,
          price: item.close
        };
      }).filter(p => p.price !== null && p.price !== undefined); // Remove pontos nulos
      
      if (points.length > 0) {
        stockHistory[historyKey] = { loaded: true, loading: false, error: false, points };
        if (currentStock === ticker) renderDashboard();
        return;
      }
    }
  } catch (err) {
    console.error("Erro ao carregar histórico via backend:", err);
  }

  // Se falhou ao buscar ou não retornou dados válidos, ativa estado de erro
  stockHistory[historyKey] = { loaded: true, loading: false, error: true, points: [] };
  if (currentStock === ticker) renderDashboard();
}

// Renderiza o gráfico em formato SVG dinâmico
function drawSvgChart(points, isPositive) {
  if (!points || points.length === 0) return '<p class="text-slate-500 text-sm text-center py-8">Sem histórico disponível.</p>';

  const width = 600;
  const height = 150;
  const padding = 20;
  
  const prices = points.map(p => p.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const priceRange = maxPrice - minPrice || 1;

  const yMin = minPrice - priceRange * 0.05;
  const yMax = maxPrice + priceRange * 0.05;
  const yRange = yMax - yMin;

  const getX = (index) => padding + (index * (width - 2 * padding) / (points.length - 1));
  const getY = (price) => height - padding - ((price - yMin) * (height - 2 * padding) / yRange);

  let linePath = `M ${getX(0)} ${getY(points[0].price)}`;
  for (let i = 1; i < points.length; i++) {
    linePath += ` L ${getX(i)} ${getY(points[i].price)}`;
  }

  const fillPath = `${linePath} L ${getX(points.length - 1)} ${height - padding} L ${getX(0)} ${height - padding} Z`;

  const color = isPositive ? '#10b981' : '#f43f5e';
  const gradientId = `chart-gradient-${tickerSafe(currentStock)}-${isPositive ? 'pos' : 'neg'}`;

  let circlesHtml = '';
  let labelsHtml = '';
  
  points.forEach((p, i) => {
    const cx = getX(i);
    const cy = getY(p.price);
    
    // Círculos no hover e de trigger de eventos
    circlesHtml += `
      <circle cx="${cx}" cy="${cy}" r="3" fill="${color}" class="opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none" />
      <circle cx="${cx}" cy="${cy}" r="12" fill="transparent" class="cursor-crosshair" onmouseover="window.showChartTooltip('${p.date}', ${p.price}, ${cx}, ${cy})" onmouseout="window.hideChartTooltip()" />
    `;
    
    // Labels do eixo X
    if (i === 0 || i === points.length - 1 || (points.length > 4 && i === Math.floor(points.length / 2))) {
      labelsHtml += `
        <text x="${cx}" y="${height - 2}" fill="#64748b" font-size="9" text-anchor="middle">${p.date}</text>
      `;
    }
  });

  return `
    <div class="relative w-full h-[150px] group select-none">
      <svg viewBox="0 0 ${width} ${height}" class="w-full h-full overflow-visible">
        <defs>
          <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${color}" stop-opacity="0.25"/>
            <stop offset="100%" stop-color="${color}" stop-opacity="0.00"/>
          </linearGradient>
        </defs>
        
        <!-- Linhas guias horizontais -->
        <line x1="${padding}" y1="${getY(yMin + yRange * 0.25)}" x2="${width - padding}" y2="${getY(yMin + yRange * 0.25)}" stroke="#334155" stroke-dasharray="3,3" stroke-width="0.5" />
        <line x1="${padding}" y1="${getY(yMin + yRange * 0.5)}" x2="${width - padding}" y2="${getY(yMin + yRange * 0.5)}" stroke="#334155" stroke-dasharray="3,3" stroke-width="0.5" />
        <line x1="${padding}" y1="${getY(yMin + yRange * 0.75)}" x2="${width - padding}" y2="${getY(yMin + yRange * 0.75)}" stroke="#334155" stroke-dasharray="3,3" stroke-width="0.5" />
        
        <!-- Gradiente sob a curva -->
        <path d="${fillPath}" fill="url(#${gradientId})" class="transition-all duration-300" />
        
        <!-- Linha da curva de cotações -->
        <path d="${linePath}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="transition-all duration-300" />
        
        <!-- Linha guia vertical móvel -->
        <line id="chart-hover-line" x1="0" y1="${padding}" x2="0" y2="${height - padding}" stroke="#475569" stroke-width="1" class="hidden pointer-events-none" />
        
        <!-- Eixo X labels -->
        ${labelsHtml}
        
        <!-- Nós e áreas de toque dos tooltips -->
        ${circlesHtml}
      </svg>
      
      <!-- Caixa de Tooltip dinâmico -->
      <div id="chart-tooltip" class="absolute hidden bg-slate-950/90 border border-slate-700/80 text-slate-100 rounded-lg p-2 text-xs font-semibold shadow-2xl pointer-events-none z-20 backdrop-blur-sm transition-all duration-75">
        <span id="tooltip-date" class="block text-[9px] text-slate-500 font-medium uppercase tracking-wider">--</span>
        <span id="tooltip-price" class="block text-emerald-400 font-bold mt-0.5">R$ 0,00</span>
      </div>
    </div>
  `;
}

// Sanitiza o ticker para IDs seguros no SVG
function tickerSafe(ticker) {
  return (ticker || '').replace(/[^a-zA-Z0-9]/g, '');
}

// Tooltips e Interatividades Globais do Gráfico
window.showChartTooltip = (date, price, cx, cy) => {
  const tooltip = document.getElementById('chart-tooltip');
  const line = document.getElementById('chart-hover-line');
  
  if (tooltip && line) {
    const formattedPrice = formatCurrency(price);
    document.getElementById('tooltip-date').innerText = date;
    const priceEl = document.getElementById('tooltip-price');
    priceEl.innerText = formattedPrice;
    
    const stock = quotesData[currentStock];
    const isPositive = stock ? stock.isPositive : true;
    priceEl.className = isPositive ? 'block text-emerald-400 font-bold mt-0.5' : 'block text-rose-400 font-bold mt-0.5';

    const svgEl = line.ownerSVGElement;
    if (svgEl) {
      const pctX = (cx / 600) * 100;
      const pctY = (cy / 150) * 100;
      
      tooltip.style.left = `calc(${pctX}% - 50px)`;
      tooltip.style.top = `calc(${pctY}% - 58px)`;
      tooltip.classList.remove('hidden');
      
      line.setAttribute('x1', cx);
      line.setAttribute('x2', cx);
      line.classList.remove('hidden');
    }
  }
};

window.hideChartTooltip = () => {
  const tooltip = document.getElementById('chart-tooltip');
  const line = document.getElementById('chart-hover-line');
  if (tooltip) tooltip.classList.add('hidden');
  if (line) line.classList.add('hidden');
};

function renderSidebarLoading() {
  stocksListEl.innerHTML = `<div class="p-4 text-sm text-slate-400 text-center animate-pulse">Carregando cotações...</div>`;
}

function renderDashboardLoading() {
  dashboardContentEl.innerHTML = `
    <div class="flex flex-col items-center justify-center h-64 text-emerald-400">
      <svg class="w-10 h-10 animate-spin mb-4" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
      <p class="text-slate-300 font-medium">Buscando dados em tempo real da B3...</p>
    </div>
  `;
}

function renderSidebar() {
  stocksListEl.innerHTML = '';
  if (myStocks.length === 0) {
    stocksListEl.innerHTML = `<div class="p-2 text-xs text-slate-500">Nenhuma ação adicionada.</div>`;
    return;
  }
  
  myStocks.forEach(ticker => {
    const stock = quotesData[ticker];
    const isActive = ticker === currentStock;
    
    const el = document.createElement('div');
    el.className = `flex items-center justify-between p-2 rounded-lg cursor-pointer transition-colors group ${isActive ? 'bg-slate-700/50' : 'hover:bg-slate-800'}`;
    el.onclick = () => {
      currentStock = ticker;
      currentFilter = 'all';
      renderSidebar();
      renderDashboard();
    };

    if (!stock) {
      el.innerHTML = `
        <div class="flex items-center gap-2.5 overflow-hidden">
          <div class="w-8 h-8 rounded-full bg-slate-800/60 flex items-center justify-center shrink-0 animate-pulse">
            <span class="text-xs font-bold text-slate-500">${ticker.charAt(0)}</span>
          </div>
          <div class="overflow-hidden">
            <h3 class="text-sm font-semibold text-slate-400">${ticker}</h3>
            <p class="text-[10px] text-slate-500 truncate w-16 sm:w-20">Indisponível</p>
          </div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <div class="text-right">
            <p class="text-sm font-semibold text-slate-400">R$ --</p>
            <p class="text-[10px] text-slate-500">--%</p>
          </div>
          <button onclick="event.stopPropagation(); window.removeStock('${ticker}')" title="Remover ${ticker}" class="p-1 text-rose-400/80 hover:text-rose-400 hover:bg-rose-500/20 rounded-md transition-colors">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
          </button>
        </div>
      `;
      stocksListEl.appendChild(el);
      return;
    }
    
    const colorClass = stock.isPositive ? 'text-emerald-400' : 'text-rose-400';
    const fallbackInitial = stock.ticker.charAt(0);
    const logoHtml = stock.logoUrl 
      ? `<img src="${stock.logoUrl}" alt="${stock.ticker}" class="w-8 h-8 object-contain rounded-full">`
      : `<span class="text-xs font-bold text-slate-300">${fallbackInitial}</span>`;

    el.innerHTML = `
      <div class="flex items-center gap-2.5 overflow-hidden">
        <div class="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center shrink-0">
          ${logoHtml}
        </div>
        <div class="overflow-hidden">
          <div class="flex items-center gap-1.5">
            <h3 class="text-sm font-semibold text-slate-200">${stock.ticker}</h3>
          </div>
          <p class="text-xs text-slate-500 truncate w-16 sm:w-20">${stock.name}</p>
        </div>
      </div>
      
      <div class="flex items-center gap-1.5 shrink-0">
        <div class="text-right shrink-0">
          <p class="text-sm font-semibold text-slate-200">${formatCurrency(stock.price)}</p>
          <p class="text-[10px] ${colorClass}">${stock.isPositive ? '+' : ''}${stock.variationPercent.toFixed(2)}%</p>
        </div>
        <button onclick="event.stopPropagation(); window.removeStock('${stock.ticker}')" title="Remover ${stock.ticker} das favoritas" class="p-1 text-slate-400 hover:text-rose-400 hover:bg-rose-500/20 rounded-md transition-colors opacity-0 group-hover:opacity-100">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
        </button>
      </div>
    `;
    stocksListEl.appendChild(el);
  });
}

function renderDashboard() {
  if (!currentStock || !quotesData[currentStock]) {
    if(!isFetching) {
      dashboardContentEl.innerHTML = `
        <div class="flex flex-col items-center justify-center h-[60vh] text-slate-500">
          <svg class="w-16 h-16 mb-4 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 002-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
          <p class="text-lg font-medium text-slate-300">Nenhuma ação selecionada.</p>
          <p class="text-sm mt-2">Use a barra de pesquisa para adicionar novas ações aos seus favoritos.</p>
        </div>`;
    }
    return;
  }

  const stock = quotesData[currentStock];
  const ai = aiData[currentStock] || { loaded: false, loading: false, news: [], summary: '' };
  
  if (!ai.loaded && !ai.loading) {
    fetchAiAnalysis(currentStock);
  }

  const historyKey = `${currentStock}_${currentPeriod}`;
  const history = stockHistory[historyKey] || { loaded: false, loading: false, points: [] };
  if (!history.loaded && !history.loading) {
    fetchHistory(currentStock, stock.price, stock.isPositive);
  }

  const colorClass = stock.isPositive ? 'text-emerald-400' : 'text-rose-400';
  const sign = stock.isPositive ? '+' : '';
  const bgColorClass = stock.isPositive ? 'bg-emerald-400/10 border-emerald-500/30' : 'bg-rose-400/10 border-rose-500/30';
  const badgeClass = stock.isPositive ? 'bg-emerald-400/20 text-emerald-400' : 'bg-rose-400/20 text-rose-400';

  let filteredNews = ai.news;
  if (currentFilter !== 'all') {
    filteredNews = ai.news.filter(n => n.sentiment === currentFilter);
  }

  let newsHtml = '';
  if (ai.loading) {
    newsHtml = `<div class="col-span-full py-8 text-center text-slate-500 animate-pulse">Procurando notícias recentes em tempo real...</div>`;
  } else {
    newsHtml = filteredNews.map(news => {
      let sentimentColor = 'bg-slate-700 text-slate-300 border-slate-600'; 
      if(news.sentiment === 'positive') sentimentColor = 'bg-emerald-400/10 text-emerald-400 border-emerald-400/20';
      if(news.sentiment === 'negative') sentimentColor = 'bg-rose-400/10 text-rose-400 border-rose-400/20';
      
      const sentimentPt = { 'positive': 'Positiva', 'negative': 'Negativa', 'neutral': 'Neutra' }[news.sentiment] || news.sentiment;

      return `
        <a href="${news.link}" target="_blank" class="block bg-slate-800/40 border border-slate-700/50 rounded-xl p-5 hover:bg-slate-800/60 transition-colors group">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <div class="w-6 h-6 rounded-full bg-slate-700 flex items-center justify-center text-xs font-bold text-slate-300">
                ${news.source.charAt(0)}
              </div>
              <span class="text-sm font-medium text-slate-300">${news.source}</span>
            </div>
            <span class="text-xs text-slate-500">${news.time}</span>
          </div>
          <h4 class="text-base font-semibold text-slate-200 mb-2 leading-snug group-hover:text-emerald-400 transition-colors">${news.title}</h4>
          <div class="flex gap-2 mb-3">
            <span class="px-2.5 py-0.5 rounded-md text-[10px] font-medium border uppercase tracking-wider ${sentimentColor}">
              ${sentimentPt}
            </span>
          </div>
          <p class="text-sm text-slate-400 leading-relaxed line-clamp-2">${news.summary}</p>
        </a>
      `;
    }).join('');
  }

  let aiSummaryHtml = ai.summary;
  if (ai.loading) {
    aiSummaryHtml = `<div class="flex items-center gap-2 text-slate-400 animate-pulse">
      <svg class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
      Lendo notícias e gerando relatório da IA...
    </div>`;
  } else {
    aiSummaryHtml = parseMarkdown(ai.summary);
  }

  const fallbackInitial = stock.ticker.charAt(0);
  const logoHtml = stock.logoUrl 
    ? `<img src="${stock.logoUrl}" alt="${stock.ticker}" class="w-14 h-14 object-contain rounded-full">`
    : `<span class="text-xl font-bold text-slate-300">${fallbackInitial}</span>`;

  dashboardContentEl.innerHTML = `
    <div>
      <h2 class="text-xl font-semibold mb-4 text-slate-300">Cotação Atual</h2>
      
      <div class="bg-slate-800/50 border border-slate-700 rounded-2xl p-6 flex items-center justify-between shadow-lg">
        <div class="flex items-center gap-4">
          <div class="w-14 h-14 rounded-full bg-slate-900 border border-slate-700 flex items-center justify-center shrink-0">
            ${logoHtml}
          </div>
          <div>
            <div class="flex items-center gap-3">
              <h1 class="text-2xl font-bold text-slate-100">${stock.ticker}</h1>
              <button onclick="window.removeStock('${stock.ticker}')" class="text-[10px] uppercase font-bold tracking-wider text-rose-400/80 hover:text-rose-400 border border-rose-400/20 hover:border-rose-400/50 bg-rose-400/10 px-2 py-1 rounded transition-colors flex items-center gap-1">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                Remover
              </button>
            </div>
            <p class="text-slate-400">${stock.name}</p>
          </div>
        </div>
        
        <div class="text-right">
          <h2 class="text-4xl font-bold tracking-tight text-slate-100">${formatCurrency(stock.price)}</h2>
          <p class="text-lg font-medium mt-1 ${colorClass}">
            ${sign}${stock.variationPercent.toFixed(2)}% <span class="text-slate-500 text-sm font-normal mx-1">|</span> ${sign}${formatCurrency(Math.abs(stock.variationValue))}
          </p>
        </div>
      </div>
    </div>

    <!-- Gráfico Histórico Interativo -->
    <div class="bg-slate-800/40 border border-slate-700/60 rounded-2xl p-6 shadow-lg mt-8">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div>
          <h3 class="text-sm font-semibold text-slate-300 uppercase tracking-wider">Histórico de Preços (${currentPeriod})</h3>
          <p class="text-[11px] text-slate-500 font-medium mt-0.5">Passe o mouse sobre os pontos para ver os valores</p>
        </div>
        <div class="flex bg-slate-900/60 rounded-lg p-0.5 border border-slate-700/50 self-start sm:self-auto">
          <button onclick="window.changePeriod('5D')" class="px-3 py-1 text-[11px] font-semibold rounded-md transition-colors ${currentPeriod === '5D' ? 'bg-slate-800 text-slate-100 shadow-md border border-slate-700/50' : 'text-slate-400 hover:text-slate-200'}">5D</button>
          <button onclick="window.changePeriod('1M')" class="px-3 py-1 text-[11px] font-semibold rounded-md transition-colors ${currentPeriod === '1M' ? 'bg-slate-800 text-slate-100 shadow-md border border-slate-700/50' : 'text-slate-400 hover:text-slate-200'}">1M</button>
          <button onclick="window.changePeriod('6M')" class="px-3 py-1 text-[11px] font-semibold rounded-md transition-colors ${currentPeriod === '6M' ? 'bg-slate-800 text-slate-100 shadow-md border border-slate-700/50' : 'text-slate-400 hover:text-slate-200'}">6M</button>
          <button onclick="window.changePeriod('1A')" class="px-3 py-1 text-[11px] font-semibold rounded-md transition-colors ${currentPeriod === '1A' ? 'bg-slate-800 text-slate-100 shadow-md border border-slate-700/50' : 'text-slate-400 hover:text-slate-200'}">1A</button>
        </div>
      </div>
      ${history.loading 
        ? `<div class="h-[150px] flex items-center justify-center text-slate-500 animate-pulse gap-2">
            <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
            Carregando histórico do gráfico...
           </div>` 
        : (history.error 
            ? `<div class="h-[150px] flex flex-col items-center justify-center text-rose-450 bg-rose-950/15 border border-rose-900/40 rounded-xl p-4 gap-1 select-none">
                <svg class="w-7 h-7 text-rose-500 mb-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
                <span class="text-sm font-bold text-slate-200">Falha ao carregar o gráfico</span>
                <span class="text-xs text-slate-400 text-center max-w-xs">Não foi possível carregar os dados reais de cotações para este período.</span>
               </div>`
            : drawSvgChart(history.points, stock.isPositive)
          )
      }
    </div>

    <div class="rounded-2xl border ${bgColorClass} p-6 relative overflow-hidden mt-8">
      <div class="absolute -top-10 -right-10 w-32 h-32 blur-3xl opacity-20 ${stock.isPositive ? 'bg-emerald-500' : 'bg-rose-500'}"></div>
      
      <div class="flex items-center gap-2 mb-3 relative z-10">
        <svg class="w-5 h-5 ${colorClass}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
        </svg>
        <h3 class="text-lg font-semibold text-slate-100">Por que ${stock.isPositive ? 'subiu' : 'caiu'}?</h3>
        <span class="ml-2 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${badgeClass}">Resumo Dinâmico</span>
      </div>
      <p class="text-slate-300 leading-relaxed relative z-10 text-[15px]">
        ${aiSummaryHtml}
      </p>
    </div>

    <div class="mt-8">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-semibold text-slate-300">Notícias</h2>
        
        <div class="flex bg-slate-800/80 rounded-lg p-1 border border-slate-700/50">
          <button onclick="window.setFilter('all')" class="px-4 py-1.5 text-xs font-medium rounded-md transition-colors ${currentFilter === 'all' ? 'bg-slate-700 text-slate-100 shadow' : 'text-slate-400 hover:text-slate-200'}">Todas</button>
          <button onclick="window.setFilter('positive')" class="px-4 py-1.5 text-xs font-medium rounded-md transition-colors ${currentFilter === 'positive' ? 'bg-emerald-500/20 text-emerald-400 shadow' : 'text-slate-400 hover:text-slate-200'}">Positivas</button>
          <button onclick="window.setFilter('negative')" class="px-4 py-1.5 text-xs font-medium rounded-md transition-colors ${currentFilter === 'negative' ? 'bg-rose-500/20 text-rose-400 shadow' : 'text-slate-400 hover:text-slate-200'}">Negativas</button>
        </div>
      </div>
      
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        ${newsHtml.length > 0 || ai.loading ? newsHtml : '<p class="text-slate-500 text-sm col-span-full">Nenhuma notícia encontrada para este filtro.</p>'}
      </div>
    </div>
  `;
}

window.setFilter = (filter) => {
  currentFilter = filter;
  renderDashboard();
}

window.changePeriod = (period) => {
  currentPeriod = period;
  renderDashboard();
}

// Adiciona ou remove ações no banco correspondente (Supabase ou Local)
async function persistStockChange(ticker, action) {
  checkAndResetQuota();
  const keys = getUserStorageKeys();

  if (action === 'add') {
    const limits = getUserLimits();
    // Se a ação ainda não consumiu cota neste ciclo de 2 dias
    if (!usedStocksHistory.includes(ticker)) {
      if (usedStocksHistory.length >= limits.maxStocks) {
        const timeStr = getTimeUntilQuotaReset();
        openUpgradeModal(`Você atingiu o limite de ${limits.maxStocks} cotas do seu plano no ciclo atual de 2 dias. Suas cotas serão renovadas em ${timeStr}, ou ative o Finansa PRO ⚡ para ter cotas ilimitadas agora mesmo!`);
        return;
      }
      usedStocksHistory.push(ticker);
      localStorage.setItem(keys.usedKey, JSON.stringify(usedStocksHistory));
    }

    if (!myStocks.includes(ticker)) {
      myStocks.push(ticker);
    }
    currentStock = ticker;

    localStorage.setItem(keys.stocksKey, JSON.stringify(myStocks));

    if (currentUser && !currentUser.isMock && supabase) {
      try {
        await supabase
          .from('user_stocks')
          .upsert([{ user_id: currentUser.id, ticker }], { onConflict: 'user_id, ticker', ignoreDuplicates: true });
      } catch (err) {
        console.error("Erro ao salvar ação no Supabase:", err);
      }
    }
  } else if (action === 'remove') {
    myStocks = myStocks.filter(t => t !== ticker);
    if (currentStock === ticker) {
      currentStock = myStocks.length > 0 ? myStocks[0] : null;
    }

    localStorage.setItem(keys.stocksKey, JSON.stringify(myStocks));

    if (currentUser && !currentUser.isMock && supabase) {
      try {
        await supabase
          .from('user_stocks')
          .delete()
          .eq('user_id', currentUser.id)
          .eq('ticker', ticker);
      } catch (err) {
        console.error("Erro ao remover ação no Supabase:", err);
      }
    }
  }

  updatePlanUsageUI();
  renderSidebar();
  renderDashboard();
}

// Sincroniza as ações favoritas do usuário logado (Supabase ou Mock DB)
async function syncUserStocks() {
  if (!currentUser) return;

  const userKey = currentUser.isMock ? `mock_db_stocks_${currentUser.id}` : `user_stocks_${currentUser.id}`;
  
  // 1. Carrega do cache local da conta para resposta instantânea
  let cachedUserStocks = JSON.parse(localStorage.getItem(userKey) || 'null');
  if (cachedUserStocks && cachedUserStocks.length > 0) {
    myStocks = cachedUserStocks;
    currentStock = myStocks[0] || null;
  }

  if (currentUser.isMock) {
    if (!cachedUserStocks) {
      localStorage.setItem(userKey, JSON.stringify(myStocks));
    }
  } else if (supabase) {
    try {
      const { data, error } = await supabase
        .from('user_stocks')
        .select('ticker')
        .eq('user_id', currentUser.id);

      if (!error && data && data.length > 0) {
        myStocks = data.map(item => item.ticker);
        localStorage.setItem(userKey, JSON.stringify(myStocks));
      } else if (!error && data && data.length === 0) {
        if (myStocks.length > 0) {
          const importRows = myStocks.map(ticker => ({ user_id: currentUser.id, ticker }));
          await supabase.from('user_stocks').insert(importRows);
          localStorage.setItem(userKey, JSON.stringify(myStocks));
        }
      }
      currentStock = myStocks[0] || null;
    } catch (err) {
      console.warn("Aviso ao ler 'user_stocks' do Supabase:", err);
    }
  }
}

// Sincroniza o plano e consumo de IA do usuário no Supabase
async function syncUserSubscription() {
  if (!currentUser) return;

  const userId = currentUser.id;
  const todayStr = new Date().toISOString().split('T')[0];

  if (!currentUser.isMock && supabase) {
    try {
      const { data, error } = await supabase
        .from('user_subscriptions')
        .select('plan, ai_usage_count, last_usage_date')
        .eq('user_id', userId)
        .maybeSingle();

      if (!error && data) {
        const userPlan = data.plan || 'free';
        currentUser.plan = userPlan;
        currentUser.isPro = (userPlan === 'pro' || userPlan === 'starter');
        
        localStorage.setItem(`user_plan_${userId}`, userPlan);
        localStorage.setItem(`user_is_pro_${userId}`, currentUser.isPro ? 'true' : 'false');
        
        if (data.last_usage_date === todayStr) {
          localStorage.setItem(`ai_requests_count_${userId}`, (data.ai_usage_count || 0).toString());
        } else {
          localStorage.setItem(`ai_requests_count_${userId}`, '0');
        }
      } else if (!error && !data) {
        await supabase.from('user_subscriptions').upsert([{
          user_id: userId,
          plan: currentUser.plan || 'free',
          ai_usage_count: parseInt(localStorage.getItem(`ai_requests_count_${userId}`) || '0', 10),
          last_usage_date: todayStr
        }], { onConflict: 'user_id' });
      }
    } catch (err) {
      console.warn("Aviso ao sincronizar assinatura do Supabase:", err);
    }
  }

  updateAuthUI();
}

// Atualiza o plano do usuário no Supabase
async function updateUserPlanInSupabase(planType) {
  if (!currentUser) return;
  currentUser.plan = planType;
  currentUser.isPro = (planType === 'pro' || planType === 'starter');
  
  const userId = currentUser.id;
  localStorage.setItem(`user_plan_${userId}`, planType);
  localStorage.setItem(`user_is_pro_${userId}`, currentUser.isPro ? 'true' : 'false');

  if (!currentUser.isMock && supabase) {
    try {
      await supabase.from('user_subscriptions').upsert([{
        user_id: userId,
        plan: planType,
        updated_at: new Date()
      }], { onConflict: 'user_id' });
    } catch (err) {
      console.warn("Aviso ao atualizar plano no Supabase:", err);
    }
  }

  updateAuthUI();
}

// Incrementa a contagem de uso de IA do usuário no Supabase
async function incrementAiUsageInSupabase() {
  if (!currentUser) return;
  const userId = currentUser.id;
  const todayStr = new Date().toISOString().split('T')[0];
  const aiCountKey = `ai_requests_count_${userId}`;
  let currentCount = parseInt(localStorage.getItem(aiCountKey) || '0', 10) + 1;
  localStorage.setItem(aiCountKey, currentCount.toString());

  if (!currentUser.isMock && supabase) {
    try {
      await supabase.from('user_subscriptions').upsert([{
        user_id: userId,
        ai_usage_count: currentCount,
        last_usage_date: todayStr,
        updated_at: new Date()
      }], { onConflict: 'user_id' });
    } catch (err) {
      console.warn("Aviso ao salvar uso de IA no Supabase:", err);
    }
  }
}

window.removeStock = async (ticker) => {
  await persistStockChange(ticker, 'remove');
};

function updateHeader() {
  const now = new Date();
  const hour = now.getHours();
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const hoursStr = hour.toString().padStart(2, '0');
  
  const isMarketOpen = hour >= 10 && hour < 17;
  const dot = document.getElementById('market-status-dot');
  const text = document.getElementById('market-status-text');
  
  if (dot && text) {
    if (isMarketOpen) {
      dot.className = "w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]";
      text.innerHTML = `Mercado da B3 Aberto, <span id="current-time">${hoursStr}:${minutes}</span> <span class="text-emerald-400 font-bold ml-1">Ao Vivo</span>`;
    } else {
      dot.className = "w-2 h-2 rounded-full bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.8)]";
      text.innerHTML = `Mercado da B3 Fechado, <span id="current-time">${hoursStr}:${minutes}</span> <span class="text-slate-500 ml-1">--</span>`;
    }
  }
}

// Lógica de Busca & Adição de Ações com Autocomplete e Validação Real
window.selectSuggestedStock = async (ticker) => {
  const cleanTicker = ticker.toUpperCase();
  if (searchSuggestionsEl) {
    searchSuggestionsEl.innerHTML = '';
    searchSuggestionsEl.classList.add('hidden');
  }
  if (searchInput) {
    searchInput.value = '';
    searchInput.blur();
  }

  if (!myStocks.includes(cleanTicker)) {
    checkAndResetQuota();
    const limits = getUserLimits();
    if (!usedStocksHistory.includes(cleanTicker) && usedStocksHistory.length >= limits.maxStocks) {
      const timeStr = getTimeUntilQuotaReset();
      openUpgradeModal(`Você atingiu o limite de ${limits.maxStocks} cotas do seu plano para o ciclo atual de 2 dias. As cotas serão renovadas em ${timeStr}, ou ative o Finansa PRO ⚡ para ter cotas ilimitadas!`);
      return;
    }
    await persistStockChange(cleanTicker, 'add');
    fetchQuotes();
  } else {
    currentStock = cleanTicker;
    renderSidebar();
    renderDashboard();
  }
};

const B3_CATALOG = [
  { ticker: 'PETR4', name: 'Petróleo Brasileiro S.A. - Petrobras', logoUrl: 'https://icons.brapi.dev/icons/PETR4.svg' },
  { ticker: 'VALE3', name: 'Vale S.A.', logoUrl: 'https://icons.brapi.dev/icons/VALE3.svg' },
  { ticker: 'ITUB4', name: 'Itaú Unibanco Holding S.A.', logoUrl: 'https://icons.brapi.dev/icons/ITUB4.svg' },
  { ticker: 'BBDC4', name: 'Banco Bradesco S.A.', logoUrl: 'https://icons.brapi.dev/icons/BBDC4.svg' },
  { ticker: 'BBAS3', name: 'Banco do Brasil S.A.', logoUrl: 'https://icons.brapi.dev/icons/BBAS3.svg' },
  { ticker: 'WEGE3', name: 'WEG S.A.', logoUrl: 'https://icons.brapi.dev/icons/WEGE3.svg' },
  { ticker: 'MGLU3', name: 'Magazine Luiza S.A.', logoUrl: 'https://icons.brapi.dev/icons/MGLU3.svg' },
  { ticker: 'ABEV3', name: 'Ambev S.A.', logoUrl: 'https://icons.brapi.dev/icons/ABEV3.svg' },
  { ticker: 'B3SA3', name: 'B3 S.A. - Brasil, Bolsa, Balcão', logoUrl: 'https://icons.brapi.dev/icons/B3SA3.svg' },
  { ticker: 'RENT3', name: 'Localiza Rent a Car S.A.', logoUrl: 'https://icons.brapi.dev/icons/RENT3.svg' },
  { ticker: 'EMBR3', name: 'Embraer S.A.', logoUrl: 'https://icons.brapi.dev/icons/EMBR3.svg' },
  { ticker: 'PRIO3', name: 'Prio S.A.', logoUrl: 'https://icons.brapi.dev/icons/PRIO3.svg' },
  { ticker: 'SUZB3', name: 'Suzano S.A.', logoUrl: 'https://icons.brapi.dev/icons/SUZB3.svg' },
  { ticker: 'GGBR4', name: 'Gerdau S.A.', logoUrl: 'https://icons.brapi.dev/icons/GGBR4.svg' },
  { ticker: 'CSNA3', name: 'Companhia Siderúrgica Nacional', logoUrl: 'https://icons.brapi.dev/icons/CSNA3.svg' },
  { ticker: 'TAEE11', name: 'Transmissora Aliança de Energia Elétrica S.A.', logoUrl: 'https://icons.brapi.dev/icons/TAEE11.svg' },
  { ticker: 'CPLE6', name: 'Companhia Paranaense de Energia - Copel', logoUrl: 'https://icons.brapi.dev/icons/CPLE6.svg' },
  { ticker: 'VBBR3', name: 'Vibra Energia S.A.', logoUrl: 'https://icons.brapi.dev/icons/VBBR3.svg' },
  { ticker: 'SANB11', name: 'Banco Santander (Brasil) S.A.', logoUrl: 'https://icons.brapi.dev/icons/SANB11.svg' },
  { ticker: 'KLBN11', name: 'Klabin S.A.', logoUrl: 'https://icons.brapi.dev/icons/KLBN11.svg' }
];

if (searchInput && searchSuggestionsEl) {
  // Input escuta digitação do usuário (com Debounce de 300ms)
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const query = searchInput.value.trim();
    const queryUpper = query.toUpperCase();

    if (!query) {
      searchSuggestionsEl.innerHTML = '';
      searchSuggestionsEl.classList.add('hidden');
      return;
    }

    searchTimeout = setTimeout(async () => {
      let results = [];
      try {
        const res = await fetch(`${API_BASE}/api/search?query=${encodeURIComponent(query)}`);
        const data = await res.json();
        if (data.stocks && data.stocks.length > 0) {
          results = data.stocks;
        }
      } catch (err) {
        console.warn("API de busca externa falhou ou indisponível, usando catálogo local:", err);
      }

      // Se a API externa não retornar ou falhar, filtra do catálogo local da B3
      if (results.length === 0) {
        results = B3_CATALOG.filter(item => 
          item.ticker.includes(queryUpper) || 
          item.name.toUpperCase().includes(queryUpper)
        ).slice(0, 5);
      }

      if (results.length > 0) {
        searchSuggestionsEl.innerHTML = results.map(item => {
          const logoHtml = item.logoUrl
            ? `<img src="${item.logoUrl}" alt="${item.ticker}" class="w-6 h-6 object-contain rounded-full">`
            : `<div class="w-6 h-6 rounded-full bg-slate-900 flex items-center justify-center text-[10px] font-bold text-slate-450">${item.ticker.charAt(0)}</div>`;

          return `
            <div onclick="window.selectSuggestedStock('${item.ticker}')" class="flex items-center justify-between p-2.5 hover:bg-slate-700/60 cursor-pointer transition-colors text-left group">
              <div class="flex items-center gap-2 overflow-hidden">
                ${logoHtml}
                <div class="overflow-hidden">
                  <span class="text-sm font-bold text-slate-100 group-hover:text-emerald-400 transition-colors">${item.ticker}</span>
                  <span class="text-[10px] text-slate-400 truncate block max-w-[140px]">${item.name}</span>
                </div>
              </div>
              <span class="text-xs font-semibold text-slate-400 shrink-0">${item.close ? formatCurrency(item.close) : ''}</span>
            </div>
          `;
        }).join('');
        searchSuggestionsEl.classList.remove('hidden');
        searchSuggestionsEl.classList.add('flex');
      } else {
        searchSuggestionsEl.innerHTML = `
          <div class="p-3 text-xs text-slate-500 text-center select-none">
            Nenhum ativo localizado na B3
          </div>
        `;
        searchSuggestionsEl.classList.remove('hidden');
        searchSuggestionsEl.classList.add('flex');
      }
    }, 300);
  });

  // Fechar sugestões ao clicar fora do componente de busca
  document.addEventListener('click', (e) => {
    if (e.target !== searchInput && e.target !== searchSuggestionsEl && !searchSuggestionsEl.contains(e.target)) {
      searchSuggestionsEl.classList.add('hidden');
    }
  });

  // Reabrir sugestões existentes ao focar se houver conteúdo digitado
  searchInput.addEventListener('focus', () => {
    if (searchInput.value.trim() !== '' && searchSuggestionsEl.children.length > 0) {
      searchSuggestionsEl.classList.remove('hidden');
      searchSuggestionsEl.classList.add('flex');
    }
  });

  // Lógica do Enter: adiciona primeira sugestão ou valida o texto digitado na API externa
  searchInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const firstSuggestion = searchSuggestionsEl.querySelector('[onclick]');
      if (firstSuggestion) {
        firstSuggestion.click();
      } else {
        const ticker = searchInput.value.trim().toUpperCase();
        if (ticker) {
          try {
            const res = await fetch(`${API_BASE}/api/quotes?symbols=${ticker}`);
            const data = await res.json();
            if (data.results && data.results.length > 0 && !data.error) {
              window.selectSuggestedStock(ticker);
            } else {
              alert(`Ativo "${ticker}" não localizado na B3. Certifique-se de que o ticker está correto (Ex: PETR4).`);
            }
          } catch (err) {
            console.error("Erro ao validar ticker digitado:", err);
          }
        }
      }
    }
  });
}

if (addNewStockBtn) {
  addNewStockBtn.addEventListener('click', () => {
    searchInput.focus();
  });
}

// --- LÓGICA DE AUTENTICAÇÃO E MODAIS (LOGIN, CADASTRO, CONFIGURAÇÕES) ---
let isSignUpMode = false;
let isResetMode = false;

// Referências de Elementos do DOM (Novos Modais e Upgrade PRO)
const authModal = document.getElementById('auth-modal');
const settingsModal = document.getElementById('settings-modal');
const upgradeModal = document.getElementById('upgrade-modal');
const loginTriggerBtn = document.getElementById('login-trigger-btn');
const settingsTriggerBtn = document.getElementById('settings-trigger-btn');
const upgradeTriggerBtn = document.getElementById('upgrade-trigger-btn');
const closeAuthModalBtn = document.getElementById('close-auth-modal');
const closeSettingsModalBtn = document.getElementById('close-settings-modal');
const closeUpgradeModalBtn = document.getElementById('close-upgrade-modal');
const activateProBtn = document.getElementById('activate-pro-btn');
const authToggleBtn = document.getElementById('auth-toggle-btn');
const authToggleText = document.getElementById('auth-toggle-text');
const authModalTitle = document.getElementById('auth-modal-title');
const authModalSubtitle = document.getElementById('auth-modal-subtitle');
const authForm = document.getElementById('auth-form');
const authForgotPasswordBtn = document.getElementById('auth-forgot-password-btn');
const authPasswordGroup = document.getElementById('auth-password-group');
const settingsForm = document.getElementById('settings-form');
const authMessageBox = document.getElementById('auth-message-box');
const settingsMessageBox = document.getElementById('settings-message-box');
const authLoadingSpinner = document.getElementById('auth-loading-spinner');
const authSubmitBtn = document.getElementById('auth-submit-btn');
const userProfileBadge = document.getElementById('user-profile-badge');
const userEmailText = document.getElementById('user-email-text');
const userTierText = document.getElementById('user-tier-text');
const logoutBtn = document.getElementById('logout-btn');
const planBadgeText = document.getElementById('plan-badge-text');
const stocksLimitCount = document.getElementById('stocks-limit-count');
const stocksLimitBar = document.getElementById('stocks-limit-bar');
const upgradeModalReason = document.getElementById('upgrade-modal-reason');

// Retorna as permissões e limites do usuário logado (Gratuito, Starter R$29 ou Pro R$129)
function getUserLimits() {
  const isPro = currentUser && (currentUser.isPro === true || localStorage.getItem(`user_is_pro_${currentUser.id}`) === 'true');
  const userPlan = currentUser ? (currentUser.plan || localStorage.getItem(`user_plan_${currentUser.id}`) || (isPro ? 'pro' : 'free')) : 'free';

  if (userPlan === 'pro') {
    return {
      planName: 'Pro',
      isPro: true,
      maxStocks: Infinity,
      maxAiPerDay: Infinity
    };
  } else if (userPlan === 'starter') {
    return {
      planName: 'Starter',
      isPro: false,
      maxStocks: 15,
      maxAiPerDay: 20
    };
  }

  return {
    planName: 'Free',
    isPro: false,
    maxStocks: 5,
    maxAiPerDay: 5
  };
}

// Atualiza o widget visual do plano na barra lateral
function updatePlanUsageUI() {
  checkAndResetQuota();
  const limits = getUserLimits();
  if (!planBadgeText || !stocksLimitCount || !stocksLimitBar) return;

  const resetTimerEl = document.getElementById('quota-reset-timer');
  const timerContainerEl = document.getElementById('quota-timer-container');

  if (limits.planName === 'Pro') {
    planBadgeText.innerText = "Plano PRO ⚡";
    planBadgeText.className = "text-[10px] font-black uppercase tracking-wider text-amber-400";
    stocksLimitCount.innerText = `${myStocks.length} (Ilimitado)`;
    stocksLimitBar.style.width = "100%";
    stocksLimitBar.className = "bg-amber-400 h-full transition-all duration-500";
    if (timerContainerEl) timerContainerEl.classList.add('hidden');
    if (upgradeTriggerBtn) {
      upgradeTriggerBtn.innerHTML = `<span>PRO Ativo</span>`;
      upgradeTriggerBtn.className = "text-[10px] font-bold text-amber-400 bg-amber-400/10 border border-amber-400/30 px-2 py-0.5 rounded-full cursor-default";
    }
  } else if (limits.planName === 'Starter') {
    planBadgeText.innerText = "Plano Starter 🚀";
    planBadgeText.className = "text-[10px] font-extrabold uppercase tracking-wider text-emerald-400";
    const usedCount = usedStocksHistory.length;
    const max = 15;
    stocksLimitCount.innerText = `${usedCount}/${max}`;
    const pct = Math.min(100, Math.round((usedCount / max) * 100));
    stocksLimitBar.style.width = `${pct}%`;
    stocksLimitBar.className = usedCount >= max ? "bg-amber-500 h-full transition-all duration-500" : "bg-emerald-500 h-full transition-all duration-500";
    if (timerContainerEl) timerContainerEl.classList.remove('hidden');
    if (resetTimerEl) resetTimerEl.innerText = `Em ${getTimeUntilQuotaReset()}`;
    if (upgradeTriggerBtn) {
      upgradeTriggerBtn.innerHTML = `<span>Fazer Upgrade ⚡</span>`;
      upgradeTriggerBtn.className = "text-[10px] font-bold text-amber-300 hover:text-amber-200 transition-colors bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 rounded-full flex items-center gap-1 shadow-sm";
    }
  } else {
    planBadgeText.innerText = "Plano Gratuito";
    planBadgeText.className = "text-[10px] font-extrabold uppercase tracking-wider text-slate-400";
    const usedCount = usedStocksHistory.length;
    const max = 5;
    stocksLimitCount.innerText = `${usedCount}/${max}`;
    const pct = Math.min(100, Math.round((usedCount / max) * 100));
    stocksLimitBar.style.width = `${pct}%`;
    stocksLimitBar.className = usedCount >= max ? "bg-amber-500 h-full transition-all duration-500" : "bg-emerald-500 h-full transition-all duration-500";
    if (timerContainerEl) timerContainerEl.classList.remove('hidden');
    if (resetTimerEl) resetTimerEl.innerText = `Em ${getTimeUntilQuotaReset()}`;
    if (upgradeTriggerBtn) {
      upgradeTriggerBtn.innerHTML = `<span>Assinar Plano ⚡</span>`;
      upgradeTriggerBtn.className = "text-[10px] font-bold text-emerald-400 hover:text-emerald-300 transition-colors bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 rounded-full flex items-center gap-1 shadow-sm";
    }
  }
}

// Abre o Modal de Upgrade PRO com motivo
function openUpgradeModal(reason) {
  if (upgradeModalReason && reason) {
    upgradeModalReason.innerText = reason;
  }
  if (upgradeModal) {
    toggleModal(upgradeModal, true);
  }
}

// Controla exibição dos Modais com efeitos de transição
function toggleModal(modal, show) {
  if (show) {
    modal.classList.remove('hidden');
    modal.offsetHeight; // Força reflow
    modal.classList.remove('opacity-0');
    modal.classList.add('opacity-100');
    modal.querySelector('.transform').classList.remove('scale-95');
    modal.querySelector('.transform').classList.add('scale-100');
  } else {
    modal.classList.remove('opacity-100');
    modal.classList.add('opacity-0');
    modal.querySelector('.transform').classList.remove('scale-100');
    modal.querySelector('.transform').classList.add('scale-95');
    setTimeout(() => {
      modal.classList.add('hidden');
    }, 300);
  }
}

// Mostra mensagens de sucesso/erro nos modais
function showModalMessage(box, text, type) {
  box.innerText = text;
  box.classList.remove('hidden', 'bg-rose-500/10', 'border-rose-500/30', 'text-rose-400', 'bg-emerald-500/10', 'border-emerald-500/30', 'text-emerald-400');
  if (type === 'error') {
    box.classList.add('bg-rose-500/10', 'border-rose-500/30', 'text-rose-400');
  } else {
    box.classList.add('bg-emerald-500/10', 'border-emerald-500/30', 'text-emerald-400');
  }
  box.classList.remove('hidden');
}

// Atualiza a visualização do perfil de login no cabeçalho
function updateAuthUI() {
  if (currentUser) {
    if (loginTriggerBtn) loginTriggerBtn.classList.add('hidden');
    if (userProfileBadge) {
      userProfileBadge.classList.remove('hidden');
      userProfileBadge.classList.add('flex');
    }
    if (userEmailText) userEmailText.innerText = currentUser.email;
    if (userTierText) {
      const limits = getUserLimits();
      userTierText.innerText = limits.isPro ? 'Plano PRO ⚡' : 'Plano Gratuito';
      userTierText.className = limits.isPro 
        ? 'text-[10px] text-amber-400 font-extrabold tracking-wider uppercase' 
        : 'text-[10px] text-emerald-400 font-semibold tracking-wider uppercase';
    }
    if (closeAuthModalBtn) closeAuthModalBtn.classList.remove('hidden');
  } else {
    if (loginTriggerBtn) loginTriggerBtn.classList.remove('hidden');
    if (userProfileBadge) {
      userProfileBadge.classList.add('hidden');
      userProfileBadge.classList.remove('flex');
    }
    if (closeAuthModalBtn) closeAuthModalBtn.classList.add('hidden');
  }
  updatePlanUsageUI();
}

// Verifica se há sessões salvas ao carregar o site e força Login Mandatório
async function checkSession() {
  if (useMockAuth) {
    const mockSession = localStorage.getItem('mock_session');
    if (mockSession) {
      currentUser = JSON.parse(mockSession);
      if (localStorage.getItem(`user_is_pro_${currentUser.id}`) === 'true') {
        currentUser.isPro = true;
      }
      updateAuthUI();
      await syncUserStocks();
    }
  } else if (supabase) {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session && session.user) {
        currentUser = {
          id: session.user.id,
          email: session.user.email,
          isMock: false,
          isPro: localStorage.getItem(`user_is_pro_${session.user.id}`) === 'true'
        };
        updateAuthUI();
        await syncUserStocks();
        await syncUserSubscription();
      }

      // Registra o ouvinte reativo de mudanças de estado de autenticação do Supabase
      supabase.auth.onAuthStateChange(async (event, session) => {
        if (session && session.user) {
          currentUser = {
            id: session.user.id,
            email: session.user.email,
            isMock: false,
            isPro: localStorage.getItem(`user_is_pro_${session.user.id}`) === 'true'
          };
          updateAuthUI();
          await syncUserStocks();
          await syncUserSubscription();
          fetchQuotes();
        } else {
          currentUser = null;
          updateAuthUI();
          toggleModal(authModal, true);
        }
      });
    } catch (err) {
      console.error("Erro ao verificar sessão real do Supabase:", err);
    }
  }

  // Se não houver usuário logado, força a abertura mandatória do modal de Login/Cadastro
  if (!currentUser) {
    if (closeAuthModalBtn) closeAuthModalBtn.classList.add('hidden');
    toggleModal(authModal, true);
  } else {
    if (closeAuthModalBtn) closeAuthModalBtn.classList.remove('hidden');
  }
}

function toggleResetMode(enable) {
  isResetMode = enable;
  if (isResetMode) {
    authModalTitle.innerText = "Recuperar Senha";
    authModalSubtitle.innerText = "Digite seu e-mail para receber o link de redefinição de senha.";
    authSubmitBtn.querySelector('span').innerText = "Enviar link de recuperação";
    if (authPasswordGroup) authPasswordGroup.classList.add('hidden');
    authToggleText.innerText = "Lembrou a senha?";
    authToggleBtn.innerText = "Voltar ao Login";
  } else {
    if (authPasswordGroup) authPasswordGroup.classList.remove('hidden');
    isSignUpMode = false;
    authModalTitle.innerText = "Entrar no Finansa";
    authModalSubtitle.innerText = "Acesse sua carteira e análises de IA de qualquer lugar.";
    authSubmitBtn.querySelector('span').innerText = "Entrar";
    authToggleText.innerText = "Não tem uma conta?";
    authToggleBtn.innerText = "Criar Conta";
  }
  authMessageBox.classList.add('hidden');
  authForm.reset();
}

// Alterna o Modal entre Modo Login e Modo Cadastro
function toggleAuthMode() {
  if (isResetMode) {
    toggleResetMode(false);
    return;
  }
  isSignUpMode = !isSignUpMode;
  if (isSignUpMode) {
    authModalTitle.innerText = "Criar nova conta";
    authModalSubtitle.innerText = "Cadastre-se para sincronizar seus ativos financeiros.";
    authSubmitBtn.querySelector('span').innerText = "Cadastrar";
    authToggleText.innerText = "Já tem uma conta?";
    authToggleBtn.innerText = "Entrar";
  } else {
    authModalTitle.innerText = "Entrar no Finansa";
    authModalSubtitle.innerText = "Acesse sua carteira e análises de IA de qualquer lugar.";
    authSubmitBtn.querySelector('span').innerText = "Entrar";
    authToggleText.innerText = "Não tem uma conta?";
    authToggleBtn.innerText = "Criar Conta";
  }
  authMessageBox.classList.add('hidden');
  authForm.reset();
}

if (authForgotPasswordBtn) {
  authForgotPasswordBtn.addEventListener('click', () => toggleResetMode(true));
}

// Lógica de envio do formulário de autenticação (Login, Cadastro ou Reset)
if (authForm) {
  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('auth-email').value.trim();
    const passwordInput = document.getElementById('auth-password');
    const password = passwordInput ? passwordInput.value : '';
    
    if (authLoadingSpinner) authLoadingSpinner.classList.remove('hidden');
    authSubmitBtn.disabled = true;
    authMessageBox.classList.add('hidden');

    try {
      if (isResetMode) {
        if (useMockAuth) {
          await new Promise(resolve => setTimeout(resolve, 800));
          showModalMessage(authMessageBox, "Link de redefinição de senha enviado para seu e-mail (Simulado)!", "success");
          setTimeout(() => {
            toggleResetMode(false);
            toggleModal(authModal, false);
          }, 2000);
        } else if (supabase) {
          const { error } = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: window.location.origin
          });
          if (error) throw error;
          showModalMessage(authMessageBox, "E-mail de recuperação enviado com sucesso! Verifique sua caixa de entrada.", "success");
          setTimeout(() => {
            toggleResetMode(false);
            toggleModal(authModal, false);
          }, 2500);
        }
        return;
      }

      if (useMockAuth) {
        await new Promise(resolve => setTimeout(resolve, 800));
        
        if (isSignUpMode) {
          showModalMessage(authMessageBox, "Cadastro simulado com sucesso! Agora você está logado.", "success");
        } else {
          showModalMessage(authMessageBox, "Login simulado realizado com sucesso!", "success");
        }
        
        currentUser = {
          id: 'mock-user-' + Math.random().toString(36).substr(2, 9),
          email: email,
          isMock: true
        };
        
        localStorage.setItem('mock_session', JSON.stringify(currentUser));
        updateAuthUI();
        await syncUserStocks();
        
        setTimeout(() => {
          toggleModal(authModal, false);
          authForm.reset();
          fetchQuotes();
        }, 1000);

      } else {
        if (isSignUpMode) {
          const { data, error } = await supabase.auth.signUp({ email, password });
          if (error) throw error;
          
          showModalMessage(authMessageBox, "Conta criada com sucesso! Verifique seu e-mail para confirmação.", "success");
          
          if (data?.session?.user) {
            currentUser = { id: data.session.user.id, email: data.session.user.email, isMock: false };
            updateAuthUI();
            await syncUserStocks();
            setTimeout(() => {
              toggleModal(authModal, false);
              fetchQuotes();
            }, 1500);
          }
        } else {
          const { data, error } = await supabase.auth.signInWithPassword({ email, password });
          if (error) throw error;

          showModalMessage(authMessageBox, "Entrada realizada com sucesso!", "success");
          
          if (data?.user) {
            currentUser = { id: data.user.id, email: data.user.email, isMock: false };
            updateAuthUI();
            await syncUserStocks();
            setTimeout(() => {
              toggleModal(authModal, false);
              fetchQuotes();
            }, 1000);
          }
        }
      }
    } catch (err) {
      console.error("Erro de Autenticação:", err);
      let errorMsg = err.message || "Erro inesperado ao autenticar. Tente novamente.";
      if (errorMsg === "Invalid login credentials") {
        errorMsg = "Email ou senha incorretos.";
      }
      showModalMessage(authMessageBox, errorMsg, "error");
    } finally {
      if (authLoadingSpinner) authLoadingSpinner.classList.add('hidden');
      authSubmitBtn.disabled = false;
    }
  });
}

// Logout do usuário
if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    try {
      if (!useMockAuth && supabase) {
        await supabase.auth.signOut();
      }
    } catch (err) {
      console.warn("Erro ao fazer logout no Supabase:", err);
    }
    
    currentUser = null;
    localStorage.removeItem('mock_session');
    updateAuthUI();
    
    let saved = JSON.parse(localStorage.getItem('my_stocks') || 'null');
    myStocks = saved && saved.length > 0 ? saved : ['PETR4', 'VALE3', 'ITUB4', 'WEGE3'];
    currentStock = myStocks[0] || null;
    
    fetchQuotes();
  });
}

// Formulário de Configuração de Chaves de API
if (settingsForm) {
  const openSettings = () => {
    const openRouterInput = document.getElementById('settings-openrouter-key');
    if (openRouterInput) {
      openRouterInput.value = localStorage.getItem('openrouter_api_key') || localStorage.getItem('gemini_api_key') || '';
    }
    toggleModal(settingsModal, true);
  };
  
  if (settingsTriggerBtn) {
    settingsTriggerBtn.addEventListener('click', openSettings);
  }

  settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const openRouterInput = document.getElementById('settings-openrouter-key');
    const openRouterKey = openRouterInput ? openRouterInput.value.trim() : '';

    if (openRouterKey) {
      localStorage.setItem('openrouter_api_key', openRouterKey);
    } else {
      localStorage.removeItem('openrouter_api_key');
    }

    showModalMessage(settingsMessageBox, "Configurações salvas com sucesso!", "success");
    
    setTimeout(() => {
      toggleModal(settingsModal, false);
      if (currentStock) {
        localStorage.removeItem(`ai_cache_${currentStock}`);
        if (aiData[currentStock]) {
          aiData[currentStock].loaded = false;
        }
        fetchAiAnalysis(currentStock);
      }
    }, 1200);
  });
}

if (loginTriggerBtn) loginTriggerBtn.addEventListener('click', () => toggleModal(authModal, true));
if (closeAuthModalBtn) closeAuthModalBtn.addEventListener('click', () => {
  if (currentUser) toggleModal(authModal, false);
});
if (closeSettingsModalBtn) closeSettingsModalBtn.addEventListener('click', () => toggleModal(settingsModal, false));
if (closeUpgradeModalBtn) closeUpgradeModalBtn.addEventListener('click', () => toggleModal(upgradeModal, false));
if (authToggleBtn) authToggleBtn.addEventListener('click', toggleAuthMode);

// --- FLUXO LIMPO DE CHECKOUT DO STRIPE ---
const activateStarterBtn = document.getElementById('activate-starter-btn');

async function handleStripeCheckout(planType) {
  if (!currentUser) {
    toggleModal(upgradeModal, false);
    toggleModal(authModal, true);
    return;
  }

  const targetBtn = planType === 'starter' ? activateStarterBtn : activateProBtn;
  const btnSpan = targetBtn ? targetBtn.querySelector('span') : null;
  const originalText = btnSpan ? btnSpan.innerText : 'Assinar';
  if (btnSpan) btnSpan.innerText = "Carregando Stripe...";
  if (targetBtn) targetBtn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/api/stripe/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: currentUser.id,
        userEmail: currentUser.email,
        planType: planType,
        origin: window.location.origin
      })
    });

    const data = await res.json();

    if (data.url) {
      window.location.href = data.url;
    } else {
      showModalMessage(authMessageBox, `Erro do Stripe: ${data.error || "Não foi possível gerar a página de checkout."}`, "error");
      toggleModal(upgradeModal, false);
      toggleModal(authModal, true);
    }
  } catch (err) {
    console.error("Erro na requisição para o servidor:", err);
    showModalMessage(authMessageBox, "Não foi possível se conectar ao servidor. Tente novamente em alguns segundos.", "error");
    toggleModal(upgradeModal, false);
    toggleModal(authModal, true);
  } finally {
    if (btnSpan) btnSpan.innerText = originalText;
    if (targetBtn) targetBtn.disabled = false;
  }
}

if (activateStarterBtn) {
  activateStarterBtn.addEventListener('click', () => handleStripeCheckout('starter'));
}
if (activateProBtn) {
  activateProBtn.addEventListener('click', () => handleStripeCheckout('pro'));
}

if (upgradeTriggerBtn) {
  upgradeTriggerBtn.addEventListener('click', () => {
    openUpgradeModal("Escolha o plano ideal para gerenciar suas ações e análises de IA na B3:");
  });
}

window.addEventListener('click', (e) => {
  if (e.target === authModal && currentUser) toggleModal(authModal, false);
  if (e.target === settingsModal) toggleModal(settingsModal, false);
  if (e.target === upgradeModal) toggleModal(upgradeModal, false);
});

// Inicializa a aplicação
document.addEventListener('DOMContentLoaded', async () => {
  updateHeader();
  setInterval(updateHeader, 60000); 
  
  checkAndResetQuota();
  setInterval(updatePlanUsageUI, 60000);

  await checkSession();
  fetchQuotes();
  setInterval(() => fetchQuotes(true), 60000);

  // Processa o retorno oficial do Stripe Checkout (?session_id=...&status=success ou ?status=cancelled)
  const urlParams = new URLSearchParams(window.location.search);
  const sessionId = urlParams.get('session_id');
  const status = urlParams.get('status');
  const returnedPlan = urlParams.get('plan') || 'pro';

  if (status === 'success' && currentUser) {
    try {
      if (sessionId) {
        await fetch(`${API_BASE}/api/stripe/verify?session_id=${sessionId}`);
      }
      await updateUserPlanInSupabase(returnedPlan);
      renderSidebar();
      renderDashboard();
      
      window.history.replaceState({}, document.title, window.location.pathname);
      showModalMessage(authMessageBox, `🎉 Parabéns! Sua assinatura do Plano ${returnedPlan === 'starter' ? 'Starter 🚀 (R$ 29/mês)' : 'Pro ⚡ (R$ 129/mês)'} foi confirmada pelo Stripe!`, "success");
      toggleModal(authModal, true);
    } catch (err) {
      console.error("Erro ao validar confirmação do Stripe:", err);
    }
  } else if (status === 'cancelled') {
    window.history.replaceState({}, document.title, window.location.pathname);
    openUpgradeModal("⚠️ O pagamento no Stripe foi cancelado. Escolha um plano para tentar novamente quando quiser!");
  }
});
