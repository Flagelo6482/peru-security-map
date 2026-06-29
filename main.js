const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')
const https = require('https')

let db;

function initDatabase() {
  const dbPath = path.join(app.getPath('userData'), 'peru_security.db')
  console.log('Iniciando base de datos SQLite en:', dbPath)
  
  const Database = require('better-sqlite3')
  db = new Database(dbPath)

  // Crear tabla de incidencias si no existe
  db.prepare(`
    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      alert_level TEXT NOT NULL,
      category TEXT,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      ubigeo TEXT,
      address TEXT,
      created_at TEXT NOT NULL,
      news_link TEXT,
      status TEXT DEFAULT 'pendiente'
    )
  `).run()

  // Migración para añadir columnas en bases de datos ya existentes
  try {
    db.prepare(`ALTER TABLE incidents ADD COLUMN news_link TEXT`).run()
    console.log('Columna "news_link" añadida con éxito.')
  } catch (e) {
    // Columna ya existe o error menor
  }
  try {
    db.prepare(`ALTER TABLE incidents ADD COLUMN status TEXT DEFAULT 'pendiente'`).run()
    console.log('Columna "status" añadida con éxito.')
  } catch (e) {
    // Columna ya existe o error menor
  }

  // Crear tabla de caché de noticias
  db.prepare(`
    CREATE TABLE IF NOT EXISTS news_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ubigeo TEXT,
      source TEXT,
      title TEXT,
      description TEXT,
      link TEXT,
      pub_date TEXT,
      category TEXT,
      cached_at TEXT NOT NULL
    )
  `).run()

  // Migración para añadir columna category a news_cache si ya existe la tabla
  try {
    db.prepare(`ALTER TABLE news_cache ADD COLUMN category TEXT`).run()
    console.log('Columna "category" añadida con éxito a news_cache.')
  } catch (e) {
    // Columna ya existe o error menor
  }

  // Crear tabla de settings (para API Key)
  db.prepare(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `).run()

  // Crear tabla de caché de Google Places
  db.prepare(`
    CREATE TABLE IF NOT EXISTS cached_google_places (
      id TEXT PRIMARY KEY,
      ubigeo TEXT,
      category TEXT,
      name TEXT,
      latitude REAL,
      longitude REAL,
      address TEXT,
      rating REAL,
      created_at TEXT NOT NULL
    )
  `).run()

  // Crear tabla de noticias globales pre-cargadas en background
  db.prepare(`
    CREATE TABLE IF NOT EXISTS global_news (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT,
      title TEXT,
      description TEXT,
      link TEXT UNIQUE,
      pub_date TEXT,
      category TEXT,
      fetched_at TEXT NOT NULL
    )
  `).run()

  // Crear índices
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_incidents_ubigeo ON incidents(ubigeo)`).run()
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_news_cache_ubigeo ON news_cache(ubigeo)`).run()
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_cached_places ON cached_google_places(ubigeo, category)`).run()
}

// Helper para normalizar textos y buscar palabras clave ignorando acentos y mayúsculas
function cleanTextForMatch(str) {
  return str ? str.toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") : "";
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsWholeWord(text, word) {
  if (!text || !word) return false;
  const cleanText = cleanTextForMatch(text);
  const cleanWord = cleanTextForMatch(word);
  if (cleanWord.length === 0) return false;
  const regex = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(cleanWord)}(?:[^a-z0-9]|$)`, 'i');
  return regex.test(cleanText);
}

const DEPARTMENTS_LIST = [
  'amazonas', 'ancash', 'apurimac', 'arequipa', 'ayacucho',
  'cajamarca', 'callao', 'cusco', 'huancavelica', 'huanuco',
  'ica', 'junin', 'la libertad', 'lambayeque', 'lima',
  'loreto', 'madre de dios', 'moquegua', 'pasco', 'piura',
  'puno', 'san martin', 'tacna', 'tumbes', 'ucayali'
];

function checkGeoDepartmentCollision(text, currentDepName) {
  if (!text || !currentDepName) return false;
  const cleanText = cleanTextForMatch(text);
  const cleanCurrentDep = cleanTextForMatch(currentDepName);

  for (const dep of DEPARTMENTS_LIST) {
    if (dep === cleanCurrentDep) continue;
    
    const depRegex = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(dep)}(?:[^a-z0-9]|$)`, 'i');
    if (depRegex.test(cleanText)) {
      const currentRegex = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(cleanCurrentDep)}(?:[^a-z0-9]|$)`, 'i');
      if (!currentRegex.test(cleanText)) {
        return true; // Colisión detectada (menciona otro departamento pero no el actual)
      }
    }
  }
  return false;
}

// Descarga con soporte para redirecciones mixtas http/https y timeout por feed
function getWithRedirects(url, depth = 0) {
  if (depth > 3) {
    return Promise.reject(new Error('Demasiados redireccionamientos (max 3)'))
  }
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https')
    const client = isHttps ? https : http
    
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 3000 // 3 segundos de timeout max por feed
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location
        if (!redirectUrl.startsWith('http')) {
          const parsed = new URL(url)
          redirectUrl = parsed.protocol + '//' + parsed.host + redirectUrl
        }
        resolve(getWithRedirects(redirectUrl, depth + 1))
      } else if (res.statusCode >= 200 && res.statusCode < 300) {
        let body = ''
        res.on('data', chunk => body += chunk)
        res.on('end', () => resolve(body))
      } else {
        reject(new Error(`HTTP ${res.statusCode}`))
      }
    })

    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Timeout'))
    })

    req.on('error', reject)
  })
}

// Descarga asíncrona periódica de noticias (Pool Global)
async function updateGlobalNewsCache() {
  console.log('[RSSNews] Iniciando descarga periódica de noticias (Background)...')
  
  const feeds = [
    { name: 'RPP Noticias', url: 'https://rpp.pe/feed' },
    { name: 'Exitosa Noticias', url: 'https://exitosanoticias.pe/feed/' },
    { name: 'Agencia Andina', url: 'https://andina.pe/agencia/rss.aspx' }
  ]

  const allArticles = []
  
  const downloadPromises = feeds.map(async (feed) => {
    try {
      const xml = await getWithRedirects(feed.url)
      
      const itemRegex = /<item>([\s\S]*?)<\/item>/g
      let match
      
      const cleanXmlText = (str) => {
        if (!str) return ''
        return str
          .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
          .replace(/<[^>]*>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .trim()
      }

      while ((match = itemRegex.exec(xml)) !== null) {
        const itemContent = match[1]
        const title = cleanXmlText((itemContent.match(/<title>([\s\S]*?)<\/title>/) || [])[1])
        const link = cleanXmlText((itemContent.match(/<link>([\s\S]*?)<\/link>/) || [])[1])
        const description = cleanXmlText((itemContent.match(/<description>([\s\S]*?)<\/description>/) || [])[1])
        const pubDate = cleanXmlText((itemContent.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1])

        if (title && link) {
          allArticles.push({
            source: feed.name,
            title,
            link,
            description,
            pubDate
          })
        }
      }
    } catch (err) {
      console.error(`[RSSNews] Error al descargar feed ${feed.name}:`, err.message)
    }
  })

  await Promise.all(downloadPromises)

  if (allArticles.length === 0) {
    console.log('[RSSNews] No se descargaron artículos nuevos.')
    return
  }

  // Clasificar e insertar en SQLite
  const now = new Date().toISOString()
  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO global_news (source, title, description, link, pub_date, category, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  const transaction = db.transaction((articles) => {
    for (const art of articles) {
      const titleClean = cleanTextForMatch(art.title)
      const descClean = cleanTextForMatch(art.description)
      const fullText = titleClean + ' ' + descClean

      // 1. Filtrar solo noticias relacionadas a seguridad, emergencias, accidentes o incidentes policiales (removiendo acentos)
      const isSecurityNews = /policia|pnp|comisaria|patrullero|serenazgo|delito|delincuencia|inseguridad|seguridad ciudadana|captura|detenido|capturado|interviene|fiscalizacion|clausura|operativo policial|emergencia|urgente|sicariato|asesina|homicidio|muerto|fallecido|balacera|cuerpo|cadaver|acribillado|extorsion|extorsiones|extorsionador|cobro de cupo|secuestro|secuestros|secuestrado|secuestrada|rapto|banda criminal|banda|organizacion criminal|robo|hurto|asalto|delincuente|raquetero|arreba|sustra|robar|pandill|destroz|vandalismo|barra brava|accidente|choque|despiste|colision|atropell|chocar|mineria ilegal|draga|deforestacion|tala ilegal|madera ilegal|trafico de animales|fauna silvestre|trata de personas|trafico de personas|incendio|huaico/i.test(fullText)

      if (!isSecurityNews) continue

      // 2. Clasificación
      let category = 'Otros'
      if (/sicariato|asesina|homicidio|muerto|fallecido|balacera|cuerpo|cadaver|acribillado/i.test(fullText)) {
        category = 'Homicidio'
      } else if (/extorsion|extorsiones|extorsionador|cobro de cupo/i.test(fullText)) {
        category = 'Extorsion'
      } else if (/secuestro|secuestros|secuestrado|secuestrada|rapto/i.test(fullText)) {
        category = 'Secuestro'
      } else if (/banda criminal|banda|organizacion criminal/i.test(fullText)) {
        category = 'BandaCriminal'
      } else if (/robo|hurto|asalto|delincuente|raquetero|arreba|sustra|robar/i.test(fullText)) {
        category = 'Robo'
      } else if (/pandill|destroz|vandalismo|barra brava/i.test(fullText)) {
        category = 'Vandalismo'
      } else if (/accidente de transito|choque|despiste|colision|atropello|chocar/i.test(fullText)) {
        category = 'Accidente'
      } else if (/mineria ilegal|draga|minero ilegal|mercurio|oro ilegal/i.test(fullText)) {
        category = 'MineriaIlegal'
      } else if (/deforestacion|tala ilegal|bosque protegido|madera ilegal|maderero/i.test(fullText)) {
        category = 'Deforestacion'
      } else if (/trafico de animales|fauna silvestre|animales exoticos|fauna salvaje|trafico de especies/i.test(fullText)) {
        category = 'TraficoAnimales'
      } else if (/trata de personas|trafico de migrantes|explotacion sexual|explotacion laboral|proxeneta/i.test(fullText)) {
        category = 'TrataPersonas'
      } else if (/incendio|incendios|fuego|siniestro/i.test(fullText)) {
        category = 'Incendio'
      } else if (/huaico|deslizamiento|inundacion/i.test(fullText)) {
        category = 'Huaico'
      } else if (/paro|protesta|huelga/i.test(fullText)) {
        category = 'Protesta'
      } else if (/inseguridad ciudadana|violencia/i.test(fullText)) {
        category = 'Otros'
      }

      insertStmt.run(art.source, art.title, art.description, art.link, art.pubDate, category, now)
    }
  })

  transaction(allArticles)
  console.log(`[RSSNews] Caché global actualizada. ${allArticles.length} artículos procesados en SQLite.`)

  // Limpiar noticias desactivado a solicitud del usuario para no borrar nunca los registros acumulados
  // try {
  //   const limitDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  //   db.prepare('DELETE FROM global_news WHERE fetched_at < ?').run(limitDate)
  // } catch (err) {
  //   console.error('[RSSNews] Error limpiando noticias antiguas:', err.message)
  // }
}

// Registrar manejadores IPC para la comunicación Renderer <-> Main
function registerIpcHandlers() {
  ipcMain.handle('db-get-incidents', (event, ubigeo) => {
    const stmt = db.prepare('SELECT * FROM incidents WHERE ubigeo = ? ORDER BY created_at DESC')
    return stmt.all(ubigeo)
  })

  ipcMain.handle('db-get-all-incidents', () => {
    const stmt = db.prepare('SELECT * FROM incidents ORDER BY created_at DESC')
    return stmt.all()
  })

  ipcMain.handle('db-add-incident', (event, incident) => {
    const stmt = db.prepare(`
      INSERT INTO incidents (title, description, alert_level, category, latitude, longitude, ubigeo, address, created_at, news_link, status)
      VALUES (@title, @description, @alert_level, @category, @latitude, @longitude, @ubigeo, @address, @created_at, @news_link, @status)
    `)
    const info = stmt.run(incident)
    return { id: info.lastInsertRowid, ...incident }
  })

  ipcMain.handle('db-delete-incident', (event, id) => {
    db.prepare('DELETE FROM incidents WHERE id = ?').run(id)
    return true
  })

  ipcMain.handle('db-update-incident-status', (event, { id, status }) => {
    db.prepare('UPDATE incidents SET status = ? WHERE id = ?').run(status, id)
    return true
  })

  // Obtener noticias de la caché global SQLite y filtrarlas en memoria al instante
  ipcMain.handle('db-get-news', async (event, { ubigeo, districtName, provName, depName }) => {
    try {
      const allNews = db.prepare('SELECT * FROM global_news ORDER BY id DESC').all()
      
      const cDist = cleanTextForMatch(districtName)
      const cProv = cleanTextForMatch(provName)

      // Si la caché está vacía, forzar descarga sincrónica por única vez
      if (allNews.length === 0) {
        console.log('[RSSNews] Caché vacía detectada al consultar. Forzando descarga rápida...')
        await updateGlobalNewsCache()
      }

      const repopulatedNews = db.prepare('SELECT * FROM global_news ORDER BY id DESC').all()

      const filtered = repopulatedNews.filter(art => {
        // A: Evitar colisiones geográficas interdepartamentales (p.ej. descartar noticia de Arequipa si consultamos Lima)
        if (checkGeoDepartmentCollision(art.title, depName) || checkGeoDepartmentCollision(art.description, depName)) {
          return false
        }

        let geoMatch = false
        // B: Coincidencia por Distrito (siempre como palabra completa)
        if (cDist && cDist.length > 2) {
          geoMatch = geoMatch || containsWholeWord(art.title, districtName) || containsWholeWord(art.description, districtName)
        }
        // C: Coincidencia por Provincia (solo como fallback para provincias que no sean LIMA o CALLAO para evitar masivas falsas alarmas)
        if (cProv && cProv.length > 2 && cProv !== 'lima' && cProv !== 'callao') {
          geoMatch = geoMatch || containsWholeWord(art.title, provName) || containsWholeWord(art.description, provName)
        }
        return geoMatch
      })

      console.log(`[RSSNews] Retornadas ${filtered.length} noticias locales filtradas desde SQLite para ${districtName}`)
      return filtered.slice(0, 15)
    } catch (err) {
      console.error('[RSSNews] Error en db-get-news handle:', err.message)
      return []
    }
  })

  // Manejadores para Settings (API Key)
  ipcMain.handle('db-get-setting', (event, key) => {
    const stmt = db.prepare('SELECT value FROM settings WHERE key = ?')
    const row = stmt.get(key)
    return row ? row.value : null
  })

  ipcMain.handle('db-set-setting', (event, { key, value }) => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
    return true
  })

  // Búsqueda de Google Places con Caché en SQLite
  ipcMain.handle('google-places-search', async (event, { lat, lon, radius, category, ubigeo }) => {
    // 1. Intentar cargar desde la caché local en SQLite
    const cachedStmt = db.prepare('SELECT * FROM cached_google_places WHERE ubigeo = ? AND category = ?')
    const cached = cachedStmt.all(ubigeo, category)
    if (cached.length > 0) {
      console.log(`[GooglePlaces] Cargados ${cached.length} locales desde SQLite para ubigeo: ${ubigeo}`)
      return cached.map(c => ({
        id: c.id,
        c: c.category,
        lt: c.latitude,
        ln: c.longitude,
        n: c.name,
        st: c.address,
        rating: c.rating
      }))
    }

    // 2. Si no hay caché, verificar si tenemos API Key
    const keyRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('google_api_key')
    const apiKey = keyRow ? keyRow.value : null
    if (!apiKey) {
      console.log(`[GooglePlaces] Sin API Key configurada. Usando fallback de OSM para ubigeo: ${ubigeo}`)
      return null // Retornar null para que el renderer use el fallback local de OSM
    }

    // 3. Consultar a la API de Google Places Nearby Search
    let gType = 'restaurant'
    if (category === 'police') gType = 'police'
    else if (category === 'hospital') gType = 'hospital|clinic'
    else if (category === 'school') gType = 'school|university'
    else if (category === 'hotel') gType = 'lodging'

    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lon}&radius=${radius}&type=${gType}&key=${apiKey}&language=es`
    try {
      const res = await new Promise((resolve, reject) => {
        https.get(url, (response) => {
          let body = ''
          response.on('data', chunk => body += chunk)
          response.on('end', () => {
            try {
              resolve(JSON.parse(body))
            } catch (err) {
              reject(new Error('Respuesta inválida de Google: ' + err.message))
            }
          })
        }).on('error', reject)
      })

      if (res.status === 'OK' || res.status === 'ZERO_RESULTS') {
        const results = res.results || []
        const parsed = []
        const insertStmt = db.prepare(`
          INSERT OR REPLACE INTO cached_google_places (id, ubigeo, category, name, latitude, longitude, address, rating, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)

        const now = new Date().toISOString()
        const transaction = db.transaction((places) => {
          for (const place of places) {
            const id = place.place_id
            const name = place.name
            const latitude = place.geometry.location.lat
            const longitude = place.geometry.location.lng
            const address = place.vicinity || ''
            const rating = place.rating || 0

            insertStmt.run(id, ubigeo, category, name, latitude, longitude, address, rating, now)
            
            parsed.push({
              id,
              c: category,
              lt: latitude,
              ln: longitude,
              n: name,
              st: address,
              rating
            })
          }
        })

        transaction(results)
        console.log(`[GooglePlaces] Descargados y guardados en SQLite ${parsed.length} locales de Google para ubigeo: ${ubigeo}`)
        return parsed;
      } else {
        throw new Error(res.error_message || res.status)
      }
    } catch (err) {
      console.error('Error en búsqueda de Google Places:', err.message)
      throw err // Lanzar el error al renderer
    }
  })
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: 'Mapa de Seguridad — Perú',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  win.loadFile('index.html')

  // Descomenta esta línea para abrir DevTools automáticamente (útil para debug)
  // win.webContents.openDevTools()
}

app.whenReady().then(() => {
  initDatabase()
  registerIpcHandlers()
  
  // Lanzar descarga asíncrona en background al iniciar y programar cada 5 horas
  updateGlobalNewsCache().catch(console.error)
  setInterval(() => {
    updateGlobalNewsCache().catch(console.error)
  }, 5 * 60 * 60 * 1000)

  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})