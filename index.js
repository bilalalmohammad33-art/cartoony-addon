const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://cartoony.net';
const CATALOG_FILE = path.join(__dirname, 'catalog.json');

const CACHE = new Map();
const CACHE_TTL = 60 * 60 * 1000;

function cacheGet(key) {
  const entry = CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { CACHE.delete(key); return null; }
  return entry.value;
}
function cacheSet(key, value) {
  CACHE.set(key, { value, ts: Date.now() });
}

let browserInstance = null;
async function getBrowser() {
    if (!browserInstance) {
        console.log("🌐 Starting Cloud Chrome Browser...");
        browserInstance = await puppeteer.launch({ 
            headless: 'new',
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // Helps cloud servers with low RAM
                '--disable-gpu'
            ] 
        });
    }
    return browserInstance;
}

// ----------------------------------------------------------------
// 📚 MANUAL CATALOG LOADER
// ----------------------------------------------------------------
let GLOBAL_CATALOG = [];
try {
    if (fs.existsSync(CATALOG_FILE)) {
        GLOBAL_CATALOG = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf-8'));
    }
} catch(e) {
    console.error("❌ Failed to read catalog.json.");
}

const MANIFEST = {
  id: 'community.cartoony.net',
  version: '20.0.0', // Cloud Edition
  name: 'كرتوني Cartoony',
  description: 'مسلسلات كرتون عربية من موقع كرتوني',
  logo: `${BASE_URL}/favicon.ico`,
  resources: ['catalog', 'meta', 'stream'],
  types: ['series'],
  idPrefixes: ['cartoony:'],
  catalogs: [
    { type: 'series', id: 'cartoony-series', name: 'كرتوني - مسلسلات' }
  ]
};

const app = express();
app.use(cors({ origin: '*' }));
app.get('/manifest.json', (req, res) => res.json(MANIFEST));

// --- 1. CATALOG ---
app.get('/catalog/:type/:id/:extras?.json', (req, res) => {
    const extras = req.params.extras ? decodeURIComponent(req.params.extras) : '';
    const skip = parseInt((extras.match(/skip=(\d+)/) || [, '0'])[1]);
    const searchRaw = (extras.match(/search=([^&]+)/) || [])[1];
    const search = searchRaw ? decodeURIComponent(searchRaw) : null;

    let items = GLOBAL_CATALOG;
    if (search) items = items.filter(i => i.name.toLowerCase().includes(search.toLowerCase()));

    const sliced = items.slice(skip, skip + 100);
    res.json({ metas: sliced });
});
app.get('/catalog/:type/:id.json', (req, res) => res.redirect(`/catalog/${req.params.type}/${req.params.id}/.json`));

// --- CORE SCRAPER FUNCTION ---
async function scrapeShowData(rawId) {
    let page;
    try {
        const browser = await getBrowser();
        page = await browser.newPage();
        
        // Block images to save RAM on the cloud server!
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if(req.resourceType() === 'image' || req.resourceType() === 'stylesheet' || req.resourceType() === 'font') {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.goto(`${BASE_URL}/watch/${rawId}`, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 1500));

        const data = await page.evaluate((rawId) => {
            let name = document.title.replace('- كرتوني', '').trim();
            const h1 = document.querySelector('h1');
            if (h1) name = h1.innerText.trim();

            const img = document.querySelector('img');
            let poster = img ? (img.getAttribute('src') || img.getAttribute('data-src')) : '';
            if (poster && !poster.startsWith('http')) poster = 'https://cartoony.net' + poster;

            const episodes = [];
            const seen = new Set();
            
            document.querySelectorAll(`a[href*="/watch/${rawId}/"]`).forEach(ep => {
                const href = ep.getAttribute('href');
                const epId = href.split('/').pop();
                
                if (!seen.has(epId) && epId !== rawId) {
                    seen.add(epId);
                    let title = '';
                    ep.querySelectorAll('span').forEach(s => {
                        if (s.innerText.trim().length > 1) title = s.innerText.trim();
                    });
                    if (!title) title = `الحلقة ${episodes.length + 1}`;
                    
                    episodes.push({
                        id: `cartoony:ep:${rawId}:${epId}`,
                        title: title,
                        season: 1,
                        episode: episodes.length + 1
                    });
                }
            });
            return { name, poster, episodes };
        }, rawId);

        if (data.episodes.length > 0) {
            cacheSet(`epsmap:${rawId}`, data.episodes);
        } else {
            data.episodes.push({ id: `cartoony:ep:${rawId}:${rawId}`, title: data.name, season: 1, episode: 1 });
            cacheSet(`epsmap:${rawId}`, data.episodes);
        }
        return data;
    } catch (err) {
        return null;
    } finally {
        if (page && !page.isClosed()) await page.close();
    }
}

// --- 2. META (Episodes) ---
app.get('/meta/:type/:id.json', async (req, res) => {
    try {
        const rawId = req.params.id.split(':').pop();
        const cacheKey = `meta:${rawId}`;
        const cached = cacheGet(cacheKey);
        if (cached) return res.json({ meta: cached });

        console.log(`\n2. 🤖 Grabbing Episodes for Show (${rawId})...`);
        const data = await scrapeShowData(rawId);

        if (!data) throw new Error("Scraper failed to return data");

        const myShow = GLOBAL_CATALOG.find(s => s.id === req.params.id);
        const meta = {
            id: req.params.id, type: 'series', 
            name: myShow ? myShow.name : data.name, 
            poster: myShow ? myShow.poster : data.poster, 
            background: myShow ? myShow.poster : data.poster, 
            posterShape: 'poster', 
            videos: data.episodes
        };
        
        cacheSet(cacheKey, meta);
        console.log(`✅ Found ${data.episodes.length} episodes!`);
        res.json({ meta });
    } catch (err) {
        console.error("❌ Meta Error:", err.message);
        res.json({ meta: null });
    }
});

// --- 3. STREAM ---
app.get('/stream/:type/:id.json', async (req, res) => {
    let page;
    try {
        const parts = req.params.id.split(':');
        const showId = parts[2];
        let epId = parts[3] || showId;

        if (parts.length >= 5) {
            const epNum = parseInt(parts[4]);
            let epsMap = cacheGet(`epsmap:${showId}`);
            
            if (!epsMap) {
                const data = await scrapeShowData(showId);
                if (data) epsMap = data.episodes;
            }

            if (epsMap) {
                const realEp = epsMap.find(v => v.episode === epNum);
                if (realEp) epId = realEp.id.split(':').pop();
            }
        }

        const watchUrl = `${BASE_URL}/watch/${showId}/${epId}`;
        console.log(`\n3. 🤖 Grabbing Stream for True ID: ${epId}...`);
        
        const browser = await getBrowser();
        page = await browser.newPage();
        
        // Cloud Optimization: Block heavy files so stream loads faster!
        await page.setRequestInterception(true);
        let streamUrl = null;

        page.on('request', request => {
            const url = request.url();
            if (url.includes('.m3u8') && url.includes('pegasus') && !streamUrl) {
                streamUrl = url;
            }
            if(request.resourceType() === 'image' || request.resourceType() === 'stylesheet' || request.resourceType() === 'font') {
                request.abort();
            } else {
                request.continue();
            }
        });

        await page.goto(watchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        try {
            await page.waitForSelector('.play-icon-button', { timeout: 10000 });
            await page.evaluate(() => {
                const btn = document.querySelector('.play-icon-button');
                if (btn) btn.click();
            });
            await new Promise(r => setTimeout(r, 4000));
        } catch (e) {}

        try {
            if (!streamUrl) {
                const domUrl = await page.evaluate(() => {
                    const source = document.querySelector('video source[src*=".m3u8"]');
                    return source ? source.getAttribute('src') : null;
                });
                if (domUrl) streamUrl = domUrl;
            }
        } catch (e) {}

        if (streamUrl) {
            if (!streamUrl.includes('cache=bypass')) streamUrl += (streamUrl.includes('?') ? '&' : '?') + 'cache=bypass';
            console.log(`✅ SUCCESS! Final Stream: ${streamUrl}`);
            res.json({ streams: [{ url: streamUrl, title: 'كرتوني HLS', name: 'Cartoony' }] });
        } else {
            console.log(`❌ No stream found.`);
            res.json({ streams: [] });
        }
    } catch (err) {
        console.error("❌ Stream Error:", err.message);
        res.json({ streams: [] });
    } finally {
        if (page && !page.isClosed()) await page.close();
    }
});

// The cloud server will assign its own PORT automatically
const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Cartoony Stremio Addon is running in the Cloud on port ${PORT}!`);
});