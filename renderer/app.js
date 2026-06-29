// ============================
// Configuración inicial del mapa
// ============================
const map = L.map('map', {
  zoomControl: true,
  attributionControl: false,
  minZoom: 5,
  maxZoom: 19
}).setView([-9.19, -75.015], 6)

let tileLayer = L.tileLayer('https://mt1.google.com/vt/lyrs=m&hl=es&x={x}&y={y}&z={z}', {
  maxZoom: 19
}).addTo(map)

// ============================
// Estado global
// ============================
let layerDep = null
let layerProv = null
let layerDist = null
let selectedDep = null    // CCDD del departamento seleccionado
let selectedProv = null   // CCPP de la provincia seleccionada
let darkMode = true
let layersVisible = true
let hoverEnabled = true
let fillEnabled = true
let activePoiCategory = null
let leafletClickHandled = false
const { ipcRenderer, shell } = require('electron')
const fs = require('fs')
const path = require('path')
const https = require('https')

const poiLayerGroup = L.layerGroup().addTo(map)
const incidentLayerGroup = L.layerGroup().addTo(map)
let currentDistrictIncidents = []
let incidentCountsCache = {}

// ============================
// Estilos de polígonos dinámicos
// ============================
function getStyle(type, isHover = false, feature = null) {
  if (!layersVisible) {
    return { opacity: 0, fillOpacity: 0 }
  }

  let color, weight, fillColor, fillOpacity;

  if (type === 'dep') {
    if (isHover && hoverEnabled) {
      color = '#2563eb';
      weight = 1.5;
    } else {
      color = darkMode ? '#334155' : '#94a3b8';
      weight = 1;
    }
    fillColor = darkMode ? '#1e3a5f' : '#bfdbfe';
    fillOpacity = fillEnabled ? (darkMode ? 0.6 : 0.5) : 0;

  } else if (type === 'prov') {
    if (isHover && hoverEnabled) {
      color = '#3b82f6';
      weight = 1.2;
    } else {
      color = darkMode ? '#475569' : '#94a3b8';
      weight = 0.8;
    }
    fillColor = darkMode ? '#1e3a5f' : '#bfdbfe';
    fillOpacity = fillEnabled ? (darkMode ? 0.5 : 0.4) : 0;

  } else { // dist
    if (isHover && hoverEnabled) {
      color = '#60a5fa';
      weight = 1.0;
    } else {
      color = darkMode ? '#64748b' : '#94a3b8';
      weight = 0.5;
    }
    
    // Obtener color dinámico según incidencias en el caché
    let riskColor = darkMode ? '#1e3a5f' : '#bfdbfe'; // azul por defecto
    let hasIncidents = false;
    if (feature && feature.properties) {
      const ubigeo = feature.properties.UBIGEO
      const stats = incidentCountsCache[ubigeo]
      if (stats && stats.total > 0) {
        hasIncidents = true;
        if (stats.red > 0) {
          riskColor = '#ef4444' // Rojo (Emergencia)
        } else if (stats.yellow > 0) {
          riskColor = '#f59e0b' // Amarillo (Moderado)
        } else {
          riskColor = '#22c55e' // Verde (Seguro)
        }
      }
    }
    
    fillColor = riskColor;
    fillOpacity = fillEnabled ? (hasIncidents ? (darkMode ? 0.45 : 0.35) : (darkMode ? 0.15 : 0.1)) : 0;
  }

  if (isHover && hoverEnabled && fillEnabled) {
    if (type !== 'dist') {
      fillColor = type === 'dep' ? '#2563eb' : '#3b82f6';
    }
    fillOpacity = type === 'dep' ? 0.75 : (type === 'prov' ? 0.7 : 0.65);
  }

  return {
    color: color,
    weight: weight,
    fillColor: fillColor,
    fillOpacity: fillOpacity,
    fill: fillOpacity > 0
  };
}

function updateAllStyles() {
  if (layerDep) layerDep.setStyle(feat => getStyle('dep', false, feat))
  if (layerProv) layerProv.setStyle(feat => getStyle('prov', false, feat))
  if (layerDist) layerDist.setStyle(feat => getStyle('dist', false, feat))
}

// ============================
// Cargar GeoJSON local (Asíncrono)
// ============================
async function loadGeoJSONAsync(filename) {
  const filepath = path.join(__dirname, 'assets', filename)
  const data = await fs.promises.readFile(filepath, 'utf8')
  return JSON.parse(data)
}

let geoDep = null
let geoProv = null
let geoDist = null
let localPois = []
const loadingPromises = { prov: null, dist: null }

function ensureGeoJSONLoaded(type) {
  if (type === 'prov') {
    if (geoProv) return Promise.resolve(geoProv)
    if (!loadingPromises.prov) {
      loadingPromises.prov = loadGeoJSONAsync('provincias.geojson').then(data => {
        geoProv = data
        return data
      })
    }
    return loadingPromises.prov
  }
  if (type === 'dist') {
    if (geoDist) return Promise.resolve(geoDist)
    if (!loadingPromises.dist) {
      loadingPromises.dist = loadGeoJSONAsync('distritos.geojson').then(data => {
        geoDist = data
        return data
      })
    }
    return loadingPromises.dist
  }
}

async function initializeData() {
  try {
    // Cargar departamentos (requerido al inicio)
    geoDep = await loadGeoJSONAsync('departamentos.geojson')
    console.log('GeoJSON departamentos cargado:', geoDep.features.length)
    
    // Dibujar mapa inicial
    showDepartments()

    // Cargar caché de conteo de incidencias de SQLite
    await updateIncidentCountsCache()

    // Ocultar loader del mapa inicial
    document.getElementById('loader').classList.add('hide')

    // Cargar POIs de forma asíncrona
    const poisPath = path.join(__dirname, 'assets', 'pois_local.json')
    if (fs.existsSync(poisPath)) {
      const rawPois = await fs.promises.readFile(poisPath, 'utf8')
      localPois = JSON.parse(rawPois)
      console.log('Puntos de interés locales cargados:', localPois.length)
    } else {
      console.log('No se encontró pois_local.json. Se cargará vacío.')
    }
  } catch (err) {
    alert('Error inicializando datos geográficos: ' + err.message)
    console.error(err)
  }
}

// Disparar inicialización
initializeData()

// ============================
// Renderizar departamentos
// ============================
function showDepartments() {
  if (layerDep) { map.removeLayer(layerDep); layerDep = null }
  if (layerProv) { map.removeLayer(layerProv); layerProv = null }
  if (layerDist) { map.removeLayer(layerDist); layerDist = null }
  if (incidentLayerGroup) { incidentLayerGroup.clearLayers(); currentDistrictIncidents = [] }

  layerDep = L.geoJSON(geoDep, {
    style: () => getStyle('dep', false),
    onEachFeature(feat, layer) {
      const name = feat.properties.DEPARTAMEN
      layer.bindTooltip(name, { sticky: true })

      layer.on('mouseover', () => { if (layersVisible) layer.setStyle(getStyle('dep', true)) })
      layer.on('mouseout', () => { if (layersVisible) layer.setStyle(getStyle('dep', false)) })
      layer.on('click', async () => {
        leafletClickHandled = true
        selectedDep = feat.properties.CCDD
        map.fitBounds(layer.getBounds(), { padding: [40, 40] })
        await showProvinces(selectedDep, name)
        openPanel(name, 'Departamento del Perú', 'neutral', 'Selecciona una provincia para más detalle.')
        updateBreadcrumb([{ label: 'Perú', action: () => goToDepartments() }, { label: name, active: true }])
      })
    }
  }).addTo(map)

  if (!map.getBounds().contains(layerDep.getBounds())) {
    map.fitBounds(layerDep.getBounds())
  }
}

// ============================
// Renderizar provincias (filtradas por departamento)
// ============================
async function showProvinces(ccdd, depName) {
  if (layerDep) { map.removeLayer(layerDep); layerDep = null }
  if (layerProv) { map.removeLayer(layerProv); layerProv = null }
  if (layerDist) { map.removeLayer(layerDist); layerDist = null }
  if (incidentLayerGroup) { incidentLayerGroup.clearLayers(); currentDistrictIncidents = [] }

  // Asegurar carga asíncrona de provincias
  if (!geoProv) {
    openPanel('Cargando...', 'Geografía', 'neutral', 'Cargando mapa de provincias del Perú... Por favor, espera.')
    await ensureGeoJSONLoaded('prov')
    closePanel()
  }

  const filtered = {
    type: 'FeatureCollection',
    features: geoProv.features.filter(f => f.properties.CCDD === ccdd)
  }

  layerProv = L.geoJSON(filtered, {
    style: () => getStyle('prov', false),
    onEachFeature(feat, layer) {
      const name = feat.properties.NOMBPROV || feat.properties.NOMBRE
      layer.bindTooltip(name, { sticky: true })

      layer.on('mouseover', () => { if (layersVisible) layer.setStyle(getStyle('prov', true)) })
      layer.on('mouseout', () => { if (layersVisible) layer.setStyle(getStyle('prov', false)) })
      layer.on('click', async () => {
        leafletClickHandled = true
        selectedProv = feat.properties.CCPP
        map.fitBounds(layer.getBounds(), { padding: [40, 40] })
        await showDistricts(ccdd, selectedProv, name, depName)
        openPanel(name, 'Provincia de ' + depName, 'neutral', 'Selecciona un distrito para ver detalles y noticias.')
        updateBreadcrumb([
          { label: 'Perú', action: () => goToDepartments() },
          { label: depName, action: () => goToProvinces(ccdd, depName) },
          { label: name, active: true }
        ])
      })
    }
  }).addTo(map)
}

// ============================
// Renderizar distritos (filtrados por provincia)
// ============================
async function showDistricts(ccdd, ccpp, provName, depName) {
  if (layerDep) { map.removeLayer(layerDep); layerDep = null }
  if (layerProv) { map.removeLayer(layerProv); layerProv = null }
  if (layerDist) { map.removeLayer(layerDist); layerDist = null }
  if (incidentLayerGroup) { incidentLayerGroup.clearLayers(); currentDistrictIncidents = [] }

  // Asegurar carga asíncrona de distritos
  if (!geoDist) {
    openPanel('Cargando...', 'Geografía', 'neutral', 'Cargando mapa de distritos del Perú... Por favor, espera.')
    await ensureGeoJSONLoaded('dist')
    closePanel()
  }

  const filtered = {
    type: 'FeatureCollection',
    features: geoDist.features.filter(f => f.properties.CCDD === ccdd && f.properties.CCPP === ccpp)
  }

  layerDist = L.geoJSON(filtered, {
    style: (feature) => getStyle('dist', false, feature),
    onEachFeature(feat, layer) {
      const name = feat.properties.DISTRITO
      const ubigeo = feat.properties.UBIGEO
      layer.bindTooltip(name, { sticky: true })

      layer.on('mouseover', () => {
        if (layersVisible) layer.setStyle(getStyle('dist', true, feat))
        
        // Obtener estadísticas y actualizar tooltip con el conteo de incidentes
        const stats = incidentCountsCache[ubigeo] || { red: 0, yellow: 0, green: 0, total: 0 }
        layer.setTooltipContent(`
          <div style="font-weight:600; font-size:12px; margin-bottom:4px;">${name}</div>
          <div style="font-size:11px; display:flex; flex-direction:column; gap:2px; text-align:left;">
            <span>🔴 Emergencia: <b>${stats.red}</b></span>
            <span>🟡 Moderado: <b>${stats.yellow}</b></span>
            <span>🟢 Seguro: <b>${stats.green}</b></span>
            <span style="border-top: 1px solid #475569; margin-top:2px; padding-top:2px;">📊 Total: <b>${stats.total}</b></span>
          </div>
        `)
      })
      layer.on('mouseout', () => { 
        if (layersVisible) layer.setStyle(getStyle('dist', false, feat)) 
      })
      layer.on('click', () => {
        leafletClickHandled = true
        showDistrictDetails(ubigeo, name, provName, depName)
        updateBreadcrumb([
          { label: 'Perú', action: () => goToDepartments() },
          { label: depName, action: () => goToProvinces(ccdd, depName) },
          { label: provName, action: () => goToDistricts(ccdd, ccpp, provName, depName) },
          { label: name, active: true }
        ])
      })
    }
  }).addTo(map)
}

// ============================
// Navegación (breadcrumb)
// ============================
function goToDepartments() {
  selectedDep = null
  selectedProv = null
  closePanel()
  showDepartments()
  updateBreadcrumb([{ label: 'Perú', active: true }])
}

async function goToProvinces(ccdd, depName) {
  selectedProv = null
  await showProvinces(ccdd, depName)
  updateBreadcrumb([
    { label: 'Perú', action: () => goToDepartments() },
    { label: depName, active: true }
  ])
}

async function goToDistricts(ccdd, ccpp, provName, depName) {
  await showDistricts(ccdd, ccpp, provName, depName)
  updateBreadcrumb([
    { label: 'Perú', action: () => goToDepartments() },
    { label: depName, action: () => goToProvinces(ccdd, depName) },
    { label: provName, active: true }
  ])
}

function updateBreadcrumb(items) {
  const bc = document.getElementById('breadcrumb')
  bc.innerHTML = ''
  items.forEach((it, i) => {
    if (i > 0) {
      const sep = document.createElement('span')
      sep.className = 'bc-sep'
      sep.textContent = '›'
      bc.appendChild(sep)
    }
    const el = document.createElement('span')
    el.className = 'bc-item' + (it.active ? ' active' : '')
    el.textContent = it.label
    if (it.action) el.onclick = it.action
    bc.appendChild(el)
  })
}

// ============================
// Panel lateral
// ============================
function openPanel(title, desc, level, message, showNews = false) {
  document.getElementById('stitle').textContent = title
  document.getElementById('sdesc').textContent = desc

  const badge = document.getElementById('sbadge')
  const labels = {
    red: '🔴 Zona de emergencia',
    yellow: '🟡 Actividad moderada',
    green: '🟢 Zona segura',
    neutral: 'Sin datos de incidencia'
  }
  badge.textContent = labels[level] || labels.neutral
  badge.className = level

  let html = ''
  if (message) {
    html += `<div style="font-size:12px;color:#94a3b8;margin-top:6px;line-height:1.5;">${message}</div>`
  }
  if (showNews) {
    const fakeNews = [
      { src: 'El Comercio', title: 'Aumento de incidencias delictivas reportadas en la zona', date: '14 jun 2025' },
      { src: 'La República', title: 'PNP refuerza patrullaje en el distrito', date: '11 jun 2025' },
      { src: 'RPP Noticias', title: 'Vecinos solicitan más cámaras de seguridad', date: '8 jun 2025' }
    ]
    html += `<div class="ns-title">Noticias vinculadas</div>`
    fakeNews.forEach(n => {
      html += `<a class="ni" href="#" onclick="return false">
        <div class="ni-src">${n.src}</div>
        <div class="ni-title">${n.title}</div>
        <div class="ni-date">${n.date}</div>
      </a>`
    })
  }

  document.getElementById('sbody').innerHTML = html
  document.getElementById('sidebar').classList.add('open')
}

function closePanel() {
  document.getElementById('sidebar').classList.remove('open')
}

document.getElementById('sclose').onclick = closePanel

// ============================
// Filtros (placeholder por ahora)
// ============================
document.querySelectorAll('.fbtn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.fbtn').forEach(b => b.className = 'fbtn')
    btn.className = 'fbtn active-' + btn.dataset.type
  }
})

// ============================
// Arrancar
// ============================
// Las funciones de arranque se ejecutan asíncronamente en initializeData()


// ============================
// Activar / desactivar resaltado hover
// ============================
document.getElementById('hover-toggle').onclick = () => {
  hoverEnabled = !hoverEnabled
  const btn = document.getElementById('hover-toggle')
  btn.classList.toggle('hover-off', !hoverEnabled)
  btn.title = hoverEnabled ? 'Desactivar resaltado' : 'Activar resaltado'
  updateAllStyles()
}

// ============================
// Activar / desactivar sombreado (relleno)
// ============================
document.getElementById('fill-toggle').onclick = () => {
  fillEnabled = !fillEnabled
  const btn = document.getElementById('fill-toggle')
  btn.classList.toggle('fill-off', !fillEnabled)
  btn.title = fillEnabled ? 'Desactivar sombreado' : 'Activar sombreado'
  updateAllStyles()
}

// ============================
// Mostrar / ocultar capas
// ============================
document.getElementById('layer-toggle').onclick = () => {
  layersVisible = !layersVisible
  const btn = document.getElementById('layer-toggle')
  btn.classList.toggle('layer-off', !layersVisible)
  btn.title = layersVisible ? 'Ocultar zonas' : 'Mostrar zonas'
  updateAllStyles()
}

// ============================
// Modo oscuro / claro
// ============================
document.getElementById('theme-toggle').onclick = () => {
  darkMode = !darkMode
  document.body.classList.toggle('light', !darkMode)
  document.getElementById('theme-toggle').textContent = darkMode ? '🌙' : '☀️'
  updateAllStyles()
}

// ============================
// Atajos de teclado
// ============================
document.addEventListener('keydown', (e) => {
  // Esc funciona siempre (incluso escribiendo en un input) para limpiar la navegación
  if (e.key === 'Escape') {
    const searchInput = document.getElementById('search-input')
    const searchSuggestions = document.getElementById('search-suggestions')
    if (searchInput) searchInput.value = ''
    if (searchSuggestions) searchSuggestions.classList.add('hide')
    
    // Cerrar paneles laterales
    closePanel()
    
    // Restablecer estilos de selección en el mapa sin perder el zoom ni la capa actual
    if (layerDist) {
      layerDist.eachLayer(layer => {
        layerDist.resetStyle(layer)
      })
    }
    return
  }

  // Evitar que otros atajos se activen si el usuario está escribiendo en un input o formulario
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
    return
  }
  if (e.key.toLowerCase() === 's') {
    document.getElementById('fill-toggle').click()
  }
  if (e.key.toLowerCase() === 't') {
    const poiCategorySelect = document.getElementById('poi-category-select')
    if (poiCategorySelect) {
      poiCategorySelect.value = poiCategorySelect.value === 'all' ? 'none' : 'all'
      poiCategorySelect.dispatchEvent(new Event('change'))
    }
  }
})

// ============================
// Búsqueda de Puntos de Interés (Overpass API)
// ============================
let currentPoiController = null

function getCategoryFromElement(el) {
  const amenity = el.tags.amenity
  const tourism = el.tags.tourism
  if (amenity === 'police') return 'police'
  if (amenity === 'hospital' || amenity === 'clinic') return 'hospital'
  if (amenity === 'school' || amenity === 'university' || amenity === 'college') return 'school'
  if (tourism === 'hotel' || tourism === 'hostel' || tourism === 'motel' || tourism === 'guest_house' || tourism === 'apartment') return 'hotel'
  if (amenity === 'restaurant' || amenity === 'fast_food' || amenity === 'cafe') return 'restaurant'
  return 'other'
}

function createPoiIcon(cat) {
  let emoji = '📍'
  let color = '#64748b'
  if (cat === 'police') { emoji = '👮'; color = '#1d4ed8' }
  else if (cat === 'hospital') { emoji = '🏥'; color = '#ef4444' }
  else if (cat === 'school') { emoji = '🏫'; color = '#f59e0b' }
  else if (cat === 'hotel') { emoji = '🏨'; color = '#7c3aed' }
  else if (cat === 'restaurant') { emoji = '🍴'; color = '#10b981' }

  return L.divIcon({
    html: `<div style="background-color: ${color}; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 2px solid white; box-shadow: 0 2px 5px rgba(0,0,0,0.4); font-size: 14px;">${emoji}</div>`,
    className: 'poi-custom-marker',
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  })
}

async function fetchPOIs(category) {
  // Limpiamos los marcadores previos
  poiLayerGroup.clearLayers()

  if (map.getZoom() < 14) {
    openPanel('Zoom insuficiente', 'Lugares de interés', 'neutral', 'Por favor, haz más zoom (nivel 14 o superior) para cargar los lugares en este sector del mapa.')
    return
  }

  const bounds = map.getBounds()
  const center = map.getCenter()
  const south = bounds.getSouth()
  const north = bounds.getNorth()
  const west = bounds.getWest()
  const east = bounds.getEast()

  // Calcular radio estimado en metros basado en la vista del mapa
  const radius = Math.min(2000, Math.round(center.distanceTo(bounds.getNorthEast())))

  // Identificar el UBIGEO activo según el centro del mapa
  let activeUbigeo = '000000'
  const centerDist = findDistrictByCoords(center.lat, center.lng)
  if (centerDist) {
    activeUbigeo = centerDist.properties.UBIGEO
  }

  let points = null
  let loadedFrom = 'Google Maps'

  try {
    // Intentar buscar utilizando la API de Google Places (vía IPC)
    if (category === 'all') {
      const categoriesToQuery = ['police', 'hospital', 'school', 'hotel', 'restaurant']
      const results = await Promise.all(categoriesToQuery.map(cat => 
        ipcRenderer.invoke('google-places-search', { 
          lat: center.lat, 
          lon: center.lng, 
          radius, 
          category: cat, 
          ubigeo: activeUbigeo 
        })
      ))

      // Si todos los retornos son null, significa que no hay API key configurada
      if (results.every(res => res === null)) {
        points = null
      } else {
        points = []
        results.forEach(res => {
          if (res) points = points.concat(res)
        })
      }
    } else {
      points = await ipcRenderer.invoke('google-places-search', { 
        lat: center.lat, 
        lon: center.lng, 
        radius, 
        category, 
        ubigeo: activeUbigeo 
      })
    }
  } catch (err) {
    console.error('Error al buscar en Google Places:', err)
    points = null // Forzar fallback en caso de error
  }

  // Fallback a la base de datos offline (OpenStreetMap) si no hay API Key o falló
  if (points === null) {
    loadedFrom = 'base de datos offline'
    if (localPois.length === 0) {
      openPanel(
        'Base de datos offline',
        'Lugares de interés',
        'neutral',
        'No se encontró la base de datos local en <b>assets/pois_local.json</b> ni una API Key de Google Maps configurada.'
      )
      return
    }

    // Filtrar los puntos locales en memoria según coordenadas y categoría
    points = localPois.filter(p => {
      if (category !== 'all' && p.c !== category) return false
      return p.lt >= south && p.lt <= north && p.ln >= west && p.ln <= east
    })
  }

  if (points.length === 0) {
    openPanel('Sin resultados', 'Lugares de interés', 'neutral', `No se encontraron puntos de interés de esta categoría en esta zona usando la ${loadedFrom}.`)
    return
  }

  // Dibujamos los marcadores en el mapa
  points.forEach(p => {
    const marker = L.marker([p.lt, p.ln], { icon: createPoiIcon(p.c) })

    marker.on('click', () => {
      leafletClickHandled = true
      let description = `Lugar cargado desde la <b>${loadedFrom}</b>.`
      if (p.rating) description += `<br><b>Calificación:</b> ⭐ ${p.rating}`
      if (p.op) description += `<br><b>Operador:</b> ${p.op}`
      if (p.st) {
        description += `<br><b>Dirección:</b> ${p.st}`
        if (p.hn) description += ` ${p.hn}`
      }
      if (p.tl) description += `<br><b>Teléfono:</b> ${p.tl}`
      if (p.wb) description += `<br><b>Web:</b> <a href="${p.wb}" target="_blank" style="color:#60a5fa">${p.wb}</a>`
      
      let badgeLevel = 'neutral'
      if (p.c === 'police') badgeLevel = 'green'
      else if (p.c === 'hospital') badgeLevel = 'red'
      else if (p.c === 'school') badgeLevel = 'yellow'
      
      let categoryLabel = 'Lugar de Interés'
      if (p.c === 'police') categoryLabel = '👮 Comisaría / Policía'
      else if (p.c === 'hospital') categoryLabel = '🏥 Centro de Salud / Hospital'
      else if (p.c === 'school') categoryLabel = '🏫 Institución Educativa'
      else if (p.c === 'hotel') categoryLabel = '🏨 Hospedaje / Hotel'
      else if (p.c === 'restaurant') categoryLabel = '🍴 Restaurante / Café'

      openPanel(p.n || 'Lugar sin nombre registrado', categoryLabel, badgeLevel, description)
    })

    poiLayerGroup.addLayer(marker)
  })

  let categoryText = ''
  if (category === 'all') categoryText = 'lugares de interés'
  else if (category === 'police') categoryText = 'comisarías'
  else if (category === 'hospital') categoryText = 'hospitales'
  else if (category === 'school') categoryText = 'colegios'
  else if (category === 'hotel') categoryText = 'hoteles'
  else if (category === 'restaurant') categoryText = 'restaurantes'

  openPanel(
    'Búsqueda finalizada',
    'Lugares de interés',
    'neutral',
    `Se cargaron <b>${points.length}</b> ${categoryText} en esta zona desde la <b>${loadedFrom}</b>.`
  )
}

// Bindeo de eventos y mapa con select
let moveEndTimeout = null

const poiCategorySelect = document.getElementById('poi-category-select')
if (poiCategorySelect) {
  poiCategorySelect.onchange = () => {
    const val = poiCategorySelect.value
    if (val === 'none') {
      activePoiCategory = null
      poiLayerGroup.clearLayers()
      closePanel()
    } else {
      activePoiCategory = val
      fetchPOIs(val)
    }
  }
}

map.on('moveend', () => {
  if (activePoiCategory) {
    if (moveEndTimeout) clearTimeout(moveEndTimeout)
    moveEndTimeout = setTimeout(() => {
      fetchPOIs(activePoiCategory)
    }, 250)
  }
})

// ============================
// Sistema de Búsqueda Jerárquica
// ============================
function cleanString(str) {
  return str ? str.toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") : ""
}

async function navigateToPlace(scope, feat) {
  const props = feat.properties

  if (scope === 'dep') {
    const ccdd = props.CCDD
    const name = props.DEPARTAMEN
    selectedDep = ccdd
    selectedProv = null
    
    // Zoom y desplazamiento suave al Departamento completo
    const tempLayer = L.geoJSON(feat)
    map.flyToBounds(tempLayer.getBounds(), { duration: 1.5, padding: [40, 40] })
    
    await showProvinces(ccdd, name)
    openPanel(name, 'Departamento del Perú', 'neutral', 'Selecciona una provincia para más detalle.')
    updateBreadcrumb([{ label: 'Perú', action: () => goToDepartments() }, { label: name, active: true }])

  } else if (scope === 'prov') {
    const ccdd = props.CCDD
    const ccpp = props.CCPP
    const name = props.NOMBPROV
    const depName = props.NOMBDEP
    selectedDep = ccdd
    selectedProv = ccpp

    // Zoom y desplazamiento suave a la Provincia completa
    const tempLayer = L.geoJSON(feat)
    map.flyToBounds(tempLayer.getBounds(), { duration: 1.5, padding: [40, 40] })

    await showDistricts(ccdd, ccpp, name, depName)
    openPanel(name, 'Provincia de ' + depName, 'neutral', 'Selecciona un distrito para ver detalles y noticias.')
    updateBreadcrumb([
      { label: 'Perú', action: () => goToDepartments() },
      { label: depName, action: () => goToProvinces(ccdd, depName) },
      { label: name, active: true }
    ])

  } else { // dist
    const ccdd = props.CCDD
    const ccpp = props.CCPP
    const name = props.DISTRITO
    const provName = props.PROVINCIA
    const depName = props.DEPARTAMEN
    selectedDep = ccdd
    selectedProv = ccpp

    // 1. Cargar la capa de distritos de esa provincia
    await showDistricts(ccdd, ccpp, provName, depName)
    
    // 2. Buscar el distrito específico cargado para hacerle zoom y resaltarlo,
    // deseleccionando cualquier otro distrito que pudiera estar sombreado.
    let foundLayer = null
    layerDist.eachLayer(layer => {
      layer.setStyle(getStyle('dist', false))
      if (layer.feature.properties.UBIGEO === props.UBIGEO) {
        foundLayer = layer
      }
    })

    if (foundLayer) {
      // Zoom y desplazamiento suave al Distrito
      map.flyToBounds(foundLayer.getBounds(), { duration: 1.5, padding: [100, 100] })
      foundLayer.setStyle(getStyle('dist', true, feat))
    } else {
      const tempLayer = L.geoJSON(feat)
      map.flyToBounds(tempLayer.getBounds(), { duration: 1.5, padding: [100, 100] })
    }

    showDistrictDetails(props.UBIGEO, name, provName, depName)

    updateBreadcrumb([
      { label: 'Perú', action: () => goToDepartments() },
      { label: depName, action: () => goToProvinces(ccdd, depName) },
      { label: provName, action: () => goToDistricts(ccdd, ccpp, provName, depName) },
      { label: name, active: true }
    ])
  }
}

const searchInput = document.getElementById('search-input')
if (searchInput) {
  searchInput.onfocus = () => {
    searchInput.select()
  }
}
const searchScope = document.getElementById('search-scope')
const searchSuggestions = document.getElementById('search-suggestions')

searchScope.onchange = async () => {
  searchInput.value = ''
  const scope = searchScope.value
  searchInput.placeholder = `Buscar ${scope === 'dep' ? 'departamento' : (scope === 'prov' ? 'provincia' : 'distrito')}...`
  searchSuggestions.innerHTML = ''
  searchSuggestions.classList.add('hide')

  // Pre-cargar de forma asíncrona y silenciosa el GeoJSON correspondiente al cambiar el selector
  if (scope === 'prov' && !geoProv) {
    console.log('Pre-cargando provincias para el buscador...')
    ensureGeoJSONLoaded('prov').catch(console.error)
  } else if (scope === 'dist' && !geoDist) {
    console.log('Pre-cargando distritos para el buscador...')
    ensureGeoJSONLoaded('dist').catch(console.error)
  }
}

searchInput.oninput = async (e) => {
  const query = cleanString(e.target.value)
  searchSuggestions.innerHTML = ''
  
  if (query.length < 2) {
    searchSuggestions.classList.add('hide')
    return
  }

  const scope = searchScope.value

  // Asegurar que la capa geográfica necesaria esté cargada antes de filtrar
  if (scope === 'prov' && !geoProv) {
    searchSuggestions.innerHTML = '<div class="suggestion-item" style="cursor:default">Cargando provincias...</div>'
    searchSuggestions.classList.remove('hide')
    await ensureGeoJSONLoaded('prov')
    if (cleanString(searchInput.value) !== query) return // Cancelar si el usuario siguió escribiendo
    searchSuggestions.innerHTML = ''
  } else if (scope === 'dist' && !geoDist) {
    searchSuggestions.innerHTML = '<div class="suggestion-item" style="cursor:default">Cargando distritos...</div>'
    searchSuggestions.classList.remove('hide')
    await ensureGeoJSONLoaded('dist')
    if (cleanString(searchInput.value) !== query) return // Cancelar si el usuario siguió escribiendo
    searchSuggestions.innerHTML = ''
  }

  let matches = []

  if (scope === 'dep') {
    matches = geoDep.features.filter(f => cleanString(f.properties.DEPARTAMEN).includes(query))
  } else if (scope === 'prov') {
    matches = geoProv.features.filter(f => cleanString(f.properties.NOMBPROV).includes(query))
  } else { // dist
    matches = geoDist.features.filter(f => cleanString(f.properties.DISTRITO).includes(query))
  }

  const sliced = matches.slice(0, 8)

  if (sliced.length === 0) {
    const item = document.createElement('div')
    item.className = 'suggestion-item'
    item.textContent = 'No se encontraron resultados'
    item.style.cursor = 'default'
    searchSuggestions.appendChild(item)
  } else {
    sliced.forEach(f => {
      const item = document.createElement('div')
      item.className = 'suggestion-item'
      
      if (scope === 'dep') {
        const name = f.properties.DEPARTAMEN
        item.textContent = name
        item.onclick = () => {
          searchInput.value = name
          searchSuggestions.classList.add('hide')
          navigateToPlace('dep', f)
        }
      } else if (scope === 'prov') {
        const name = f.properties.NOMBPROV
        const parent = f.properties.NOMBDEP
        item.innerHTML = `${name} <span class="parent-info">Departamento: ${parent}</span>`
        item.onclick = () => {
          searchInput.value = name
          searchSuggestions.classList.add('hide')
          navigateToPlace('prov', f)
        }
      } else { // dist
        const name = f.properties.DISTRITO
        const parentProv = f.properties.PROVINCIA
        const parentDep = f.properties.DEPARTAMEN
        item.innerHTML = `${name} <span class="parent-info">${parentDep} › ${parentProv}</span>`
        item.onclick = () => {
          searchInput.value = name
          searchSuggestions.classList.add('hide')
          navigateToPlace('dist', f)
        }
      }
      
      searchSuggestions.appendChild(item)
    })
  }

  searchSuggestions.classList.remove('hide')
}

// Cerrar sugerencias al hacer clic fuera del buscador
document.addEventListener('click', (e) => {
  if (!document.getElementById('search-container').contains(e.target)) {
    searchSuggestions.classList.add('hide')
  }
})

// ==========================================================================
// Gestión de Incidencias Locales (SQLite + Leaflet Eventos)
// ==========================================================================

// Iconos personalizados para incidencias de seguridad según nivel de alerta
function createIncidentIcon(level) {
  let color = '#ef4444' // Rojo (Crítico)
  if (level === 'yellow') color = '#f59e0b' // Amarillo (Mediano)
  else if (level === 'green') color = '#10b981' // Verde (Bajo/Seguro)
  
  return L.divIcon({
    html: `<div style="background-color: ${color}; width: 18px; height: 18px; border-radius: 50%; border: 2.5px solid white; box-shadow: 0 0 8px rgba(0,0,0,0.6); position: relative; display: flex; align-items: center; justify-content: center;">
             <div style="width: 5px; height: 5px; border-radius: 50%; background-color: white;"></div>
           </div>`,
    className: 'incident-marker-div',
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  })
}

// Algoritmo Ray-Casting para detectar si un punto (lat, lon) está dentro de un polígono/multipolígono GeoJSON
function isPointInPolygon(point, geometry) {
  const x = point[1], y = point[0] // lon, lat
  
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
  
  for (const poly of polygons) {
    const exteriorRing = poly[0]
    if (!exteriorRing) continue
    
    let polyInside = false
    for (let i = 0, j = exteriorRing.length - 1; i < exteriorRing.length; j = i++) {
      const xi = exteriorRing[i][0], yi = exteriorRing[i][1]
      const xj = exteriorRing[j][0], yj = exteriorRing[j][1]
      
      const intersect = ((yi > y) !== (yj > y))
          && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)
      if (intersect) polyInside = !polyInside
    }
    if (polyInside) return true
  }
  return false
}

// Buscar en cuál distrito cargado de geoDist cayeron las coordenadas lat/lon
function findDistrictByCoords(lat, lon) {
  if (!geoDist) return null
  const point = [lat, lon]
  
  for (const feature of geoDist.features) {
    if (isPointInPolygon(point, feature.geometry)) {
      return feature
    }
  }
  return null
}

// Cargar y renderizar incidencias desde SQLite para un distrito específico
async function loadAndRenderIncidentsForDistrict(ubigeo) {
  incidentLayerGroup.clearLayers()
  try {
    const list = await ipcRenderer.invoke('db-get-incidents', ubigeo)
    currentDistrictIncidents = list
    renderIncidents(list)
  } catch (err) {
    console.error('Error cargando incidencias de SQLite:', err)
  }
}

// Pintar marcadores de incidencias aplicando el filtro activo
function renderIncidents(list) {
  incidentLayerGroup.clearLayers()
  
  const activeAlertFilter = getActiveAlertFilter()
  const filtered = list.filter(item => {
    if (activeAlertFilter === 'all') return true
    return item.alert_level === activeAlertFilter
  })

  filtered.forEach(item => {
    const marker = L.marker([item.latitude, item.longitude], {
      icon: createIncidentIcon(item.alert_level)
    })

    marker.on('click', () => {
      leafletClickHandled = true
      openIncidentDetailPanel(item)
    })

    incidentLayerGroup.addLayer(marker)
  })
}



async function updateIncidentCountsCache() {
  try {
    const allIncidents = await ipcRenderer.invoke('db-get-all-incidents')
    incidentCountsCache = {}
    allIncidents.forEach(item => {
      if (!incidentCountsCache[item.ubigeo]) {
        incidentCountsCache[item.ubigeo] = { red: 0, yellow: 0, green: 0, total: 0 }
      }
      const cat = item.alert_level === 'red' ? 'red' : (item.alert_level === 'yellow' ? 'yellow' : 'green')
      incidentCountsCache[item.ubigeo][cat]++
      incidentCountsCache[item.ubigeo].total++
    })
    updateAllStyles()
  } catch (err) {
    console.error('Error al actualizar caché de incidencias:', err)
  }
}

// Obtener qué nivel de alerta está seleccionado en los filtros superiores (Desplegable)
function getActiveAlertFilter() {
  const select = document.getElementById('alert-filter-select')
  if (!select) return 'all'
  const val = select.value
  if (val === 'emergency') return 'red'
  if (val === 'moderated') return 'yellow'
  if (val === 'safe') return 'green'
  return 'all'
}

// Bindeo del evento del selector desplegable de alerta
const alertFilterSelect = document.getElementById('alert-filter-select')
if (alertFilterSelect) {
  alertFilterSelect.onchange = () => {
    renderIncidents(currentDistrictIncidents)
    updateAllStyles()
  }
}

// Mostrar los detalles normales del distrito (vista regular con noticias reales y resumen de alertas)
async function showDistrictDetails(ubigeo, districtName, provName, depName) {
  const stats = incidentCountsCache[ubigeo] || { red: 0, yellow: 0, green: 0, total: 0 }
  
  openPanel(districtName, `${provName}, ${depName}`, 'yellow', null, false)
  
  const content = document.getElementById('sbody')
  let html = `
    <div style="background: rgba(30, 41, 59, 0.4); border: 1px solid #334155; border-radius: 8px; padding: 12px; margin-bottom: 14px;">
      <h3 style="font-size: 11px; font-weight: 600; color: #cbd5e1; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; text-align: left;">Resumen de Alertas</h3>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 11px;">
        <div style="display: flex; align-items: center; gap: 6px; background: #2d1616; padding: 6px; border-radius: 4px; border: 1px solid #7f1d1d;">
          <span style="font-size: 14px;">🔴</span> 
          <div style="text-align: left;">
            <div style="color: #fca5a5; font-weight:500; font-size: 10px;">Emergencia</div>
            <div style="color: #ef4444; font-size: 13px; font-weight: 700;">${stats.red}</div>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 6px; background: #2d2216; padding: 6px; border-radius: 4px; border: 1px solid #78350f;">
          <span style="font-size: 14px;">🟡</span> 
          <div style="text-align: left;">
            <div style="color: #fcd34d; font-weight:500; font-size: 10px;">Moderado</div>
            <div style="color: #f59e0b; font-size: 13px; font-weight: 700;">${stats.yellow}</div>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 6px; background: #162d1c; padding: 6px; border-radius: 4px; border: 1px solid #064e3b;">
          <span style="font-size: 14px;">🟢</span> 
          <div style="text-align: left;">
            <div style="color: #86efac; font-weight:500; font-size: 10px;">Seguro</div>
            <div style="color: #10b981; font-size: 13px; font-weight: 700;">${stats.green}</div>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 6px; background: #1e293b; padding: 6px; border-radius: 4px; border: 1px solid #475569;">
          <span style="font-size: 14px;">📊</span> 
          <div style="text-align: left;">
            <div style="color: #94a3b8; font-weight:500; font-size: 10px;">Total</div>
            <div style="color: #cbd5e1; font-size: 13px; font-weight: 700;">${stats.total}</div>
          </div>
        </div>
      </div>
    </div>
  `

  html += `<div class="ns-title" style="margin-top: 14px; margin-bottom: 8px;">Noticias locales vinculadas</div>`
  html += `<div id="news-loading" style="font-size: 11px; color: #94a3b8; text-align: center; padding: 12px;">⌛ Descargando y filtrando noticias reales...</div>`

  content.innerHTML = html
  loadAndRenderIncidentsForDistrict(ubigeo)

  // Consultar noticias reales vía IPC de forma asíncrona
  try {
    const newsList = await ipcRenderer.invoke('db-get-news', { ubigeo, districtName, provName, depName })
    const loadingEl = document.getElementById('news-loading')
    if (loadingEl) loadingEl.remove()

    const categoryEmojis = {
      Robo: '🚨 Robo',
      Homicidio: '💀 Homicidio',
      Vandalismo: '💥 Vandalismo',
      Accidente: '🚗 Accidente',
      MineriaIlegal: '⛏️ Minería Ilegal',
      Deforestacion: '🌲 Deforestación',
      TraficoAnimales: '🐵 Tráfico Fauna',
      TrataPersonas: '🔗 Trata Personas',
      Incendio: '🔥 Incendio',
      Huaico: '🌧️ Huaico',
      Protesta: '📢 Protesta',
      Extorsion: '💸 Extorsión',
      BandaCriminal: '👥 Banda Criminal',
      Secuestro: '🚪 Secuestro',
      Otros: '📰 General'
    }

    if (newsList && newsList.length > 0) {
      let newsHtml = ''
      newsList.forEach(n => {
        const dateStr = n.pub_date ? new Date(n.pub_date).toLocaleDateString() : 'Reciente'
        const label = categoryEmojis[n.category] || '📰 General'
        
        newsHtml += `
          <a class="ni" href="#" onclick="require('electron').shell.openExternal('${n.link}'); return false;" style="display: block; margin-bottom: 8px;">
            <div style="display: flex; justify-content: space-between; font-size: 10px; color: #64748b; margin-bottom: 2px;">
              <span>${n.source}</span>
              <span style="background: rgba(255,255,255,0.05); padding: 1px 4px; border-radius: 3px; font-weight:600;">${label}</span>
            </div>
            <div class="ni-title" style="font-weight: 600; color: #cbd5e1; font-size: 11px; line-height: 1.3;">${n.title}</div>
            <div style="font-size: 10px; color: #64748b; margin-top: 4px; text-align: right;">${dateStr}</div>
          </a>
        `
      })
      content.insertAdjacentHTML('beforeend', newsHtml)
    } else {
      content.insertAdjacentHTML('beforeend', `
        <div style="font-size: 11px; color: #64748b; text-align: center; padding: 14px; background: rgba(30, 41, 59, 0.2); border: 1px dashed #334155; border-radius: 6px;">
          Sin noticias de seguridad recientes registradas en ${districtName} o ${provName}.
        </div>
      `)
    }
  } catch (err) {
    console.error('Error al recuperar noticias:', err)
    const loadingEl = document.getElementById('news-loading')
    if (loadingEl) loadingEl.remove()
    content.insertAdjacentHTML('beforeend', `
      <div style="font-size: 11px; color: #fca5a5; text-align: center; padding: 10px;">
        ⚠️ Error al descargar noticias: ${err.message}
      </div>
    `)
  }
}

// Formulario lateral para registrar incidencias
function openIncidentForm(lat, lon, ubigeo, districtName, provName, depName) {
  document.getElementById('sidebar').classList.add('open')
  document.getElementById('stitle').textContent = 'Reportar Incidencia'
  
  const badge = document.getElementById('sbadge')
  badge.textContent = `${districtName} (${provName})`
  badge.className = 'yellow'

  const content = document.getElementById('sbody')
  content.innerHTML = `
    <div style="font-size: 11px; color: #64748b; margin-bottom: 12px; border-bottom: 1px solid #334155; padding-bottom: 8px;">
      <b>Ubicación:</b> ${lat.toFixed(6)}, ${lon.toFixed(6)}
    </div>
    <form id="incident-form">
      <div class="form-group">
        <label for="inc-title">Título del Incidente *</label>
        <input type="text" id="inc-title" placeholder="Ej: Robo de celular en esquina" required>
      </div>
      <div class="form-group">
        <label for="inc-category">Tipo de Incidente</label>
        <select id="inc-category">
          <option value="Robo">Robo / Hurto</option>
          <option value="Asalto">Asalto / Atraco</option>
          <option value="Homicidio">Homicidio</option>
          <option value="Vandalismo">Vandalismo / Pandillaje</option>
          <option value="Accidente">Accidente de Tránsito</option>
          <option value="MineriaIlegal">Minería Ilegal</option>
          <option value="Deforestacion">Deforestación / Tala Ilegal</option>
          <option value="TraficoAnimales">Tráfico de Fauna Silvestre</option>
          <option value="TrataPersonas">Trata y Tráfico de Personas</option>
          <option value="Sospechoso">Actividad Sospechosa</option>
          <option value="Otros">Otros / Emergencias</option>
        </select>
      </div>
      <div class="form-group">
        <label for="inc-alert">Nivel de Alerta</label>
        <select id="inc-alert">
          <option value="red">Crítico / Emergencia (Rojo)</option>
          <option value="yellow">Mediano / Moderado (Amarillo)</option>
          <option value="green">Bajo / Seguro (Verde)</option>
        </select>
      </div>
      <div class="form-group">
        <label for="inc-status">Estado</label>
        <select id="inc-status">
          <option value="pendiente">Pendiente</option>
          <option value="terminado">Terminado / Resuelto</option>
        </select>
      </div>
      <div class="form-group">
        <label for="inc-link">Noticia vinculada (Enlace URL)</label>
        <input type="url" id="inc-link" placeholder="https://..." autocomplete="off">
      </div>
      <div class="form-group">
        <label for="inc-desc">Descripción / Detalles</label>
        <textarea id="inc-desc" rows="3" placeholder="Describe lo que ocurrió..."></textarea>
      </div>
      <div class="form-actions">
        <button type="submit" id="btn-save-incident">Guardar Reporte</button>
        <button type="button" id="btn-cancel-incident">Cancelar</button>
      </div>
    </form>
  `

  document.getElementById('btn-cancel-incident').onclick = () => {
    showDistrictDetails(ubigeo, districtName, provName, depName)
  }

  document.getElementById('incident-form').onsubmit = async (e) => {
    e.preventDefault()
    
    const incidentData = {
      title: document.getElementById('inc-title').value.trim(),
      category: document.getElementById('inc-category').value,
      alert_level: document.getElementById('inc-alert').value,
      status: document.getElementById('inc-status').value,
      news_link: document.getElementById('inc-link').value.trim() || null,
      description: document.getElementById('inc-desc').value.trim() || null,
      latitude: lat,
      longitude: lon,
      ubigeo: ubigeo,
      address: null,
      created_at: new Date().toISOString()
    }

    try {
      await ipcRenderer.invoke('db-add-incident', incidentData)
      await updateIncidentCountsCache()
      showDistrictDetails(ubigeo, districtName, provName, depName)
    } catch (err) {
      alert('Error guardando incidencia: ' + err.message)
    }
  }
}

// Abrir el panel de detalles de una incidencia registrada
function openIncidentDetailPanel(item) {
  document.getElementById('sidebar').classList.add('open')
  document.getElementById('stitle').textContent = item.title
  
  const badge = document.getElementById('sbadge')
  let label = 'Emergencia / Crítico'
  let colorClass = 'red'
  if (item.alert_level === 'yellow') { label = 'Moderado'; colorClass = 'yellow' }
  else if (item.alert_level === 'green') { label = 'Zona Segura'; colorClass = 'green' }
  
  badge.textContent = label
  badge.className = colorClass

  const statusLabel = item.status === 'terminado' ? '✅ Resuelto / Terminado' : '⏳ Pendiente'
  const statusColor = item.status === 'terminado' ? '#10b981' : '#f59e0b'

  const categoryLabels = {
    Robo: 'Robo / Hurto',
    Asalto: 'Asalto / Atraco',
    Homicidio: 'Homicidio',
    Vandalismo: 'Vandalismo / Pandillaje',
    Accidente: 'Accidente de Tránsito',
    MineriaIlegal: 'Minería Ilegal ⛏️',
    Deforestacion: 'Deforestación 🌲',
    TraficoAnimales: 'Tráfico de Fauna Silvestre 🐵',
    TrataPersonas: 'Trata y Tráfico de Personas 🔗',
    Sospechoso: 'Actividad Sospechosa',
    Otros: 'Otros / Emergencias'
  }
  const displayCategory = categoryLabels[item.category] || item.category || 'Otros'

  let descHtml = `
    <div style="font-size: 11px; color: #64748b; margin-bottom: 8px;">
      <b>Categoría:</b> ${displayCategory} | <b>Fecha:</b> ${new Date(item.created_at).toLocaleDateString()}
    </div>
    <div style="margin-bottom: 12px;">
      <span style="display: inline-block; padding: 3px 8px; border-radius: 4px; background: rgba(255,255,255,0.05); border: 1px solid #334155; font-size: 10px; font-weight: 600; color: ${statusColor}">
        ${statusLabel}
      </span>
    </div>
    <div style="font-size: 12px; color: #cbd5e1; line-height: 1.5; margin-bottom: 14px;">
      ${item.description || 'Sin detalles adicionales registrados.'}
    </div>
  `

  if (item.news_link) {
    descHtml += `
      <div style="margin-bottom: 14px;">
        <b style="font-size: 11px; color: #94a3b8;">Noticia Vinculada:</b> <br>
        <a href="${item.news_link}" target="_blank" style="color: #60a5fa; font-size: 11px; word-break: break-all;">${item.news_link}</a>
      </div>
    `
  }

  descHtml += `
    <div class="form-actions" style="margin-top: 24px; border-top: 1px solid #334155; padding-top: 14px;">
      <button id="btn-edit-status" class="poibtn" style="flex: 1; padding: 8px; font-size: 11px;">Cambiar Estado</button>
      <button id="btn-delete-incident" class="poibtn" style="background: #450a0a; color: #fca5a5; border-color: #7f1d1d; flex: 1; padding: 8px; font-size: 11px;">Eliminar Reporte</button>
    </div>
  `

  document.getElementById('sbody').innerHTML = descHtml

  // Lógica de botones
  document.getElementById('btn-edit-status').onclick = async () => {
    const newStatus = item.status === 'pendiente' ? 'terminado' : 'pendiente'
    try {
      await ipcRenderer.invoke('db-update-incident-status', { id: item.id, status: newStatus })
      await loadAndRenderIncidentsForDistrict(item.ubigeo)
      const updatedItem = currentDistrictIncidents.find(i => i.id === item.id)
      if (updatedItem) openIncidentDetailPanel(updatedItem)
    } catch (err) {
      alert('Error al cambiar el estado: ' + err.message)
    }
  }

  document.getElementById('btn-delete-incident').onclick = async () => {
    if (confirm('¿Estás seguro de que deseas eliminar este reporte de incidencia?')) {
      try {
        await ipcRenderer.invoke('db-delete-incident', item.id)
        await updateIncidentCountsCache()
        
        let distName = 'Distrito'
        let provName = 'Provincia'
        let depName = 'Departamento'
        
        if (layerDist) {
          layerDist.eachLayer(layer => {
            if (layer.feature.properties.UBIGEO === item.ubigeo) {
              distName = layer.feature.properties.DISTRITO
              provName = layer.feature.properties.PROVINCIA
              depName = layer.feature.properties.DEPARTAMEN
            }
          })
        }
        showDistrictDetails(item.ubigeo, distName, provName, depName)
      } catch (err) {
        alert('Error al eliminar incidencia: ' + err.message)
      }
    }
  }
}

// Evento de clic izquierdo libre en el mapa para navegar y ver noticias sin restricciones
map.on('click', async (e) => {
  if (leafletClickHandled) {
    leafletClickHandled = false
    return
  }

  const lat = e.latlng.lat
  const lon = e.latlng.lng

  // Asegurar carga de distritos para cruzar coordenadas
  if (!geoDist) {
    try {
      await ensureGeoJSONLoaded('dist')
    } catch (err) {
      return
    }
  }

  const distFeature = findDistrictByCoords(lat, lon)
  if (distFeature) {
    const props = distFeature.properties
    
    // Cargar capa de distritos de esa provincia de forma transparente
    await showDistricts(props.CCDD, props.CCPP, props.PROVINCIA, props.DEPARTAMEN)

    // Resaltar el distrito en el mapa
    let foundLayer = null
    layerDist.eachLayer(layer => {
      if (layer.feature.properties.UBIGEO === props.UBIGEO) {
        foundLayer = layer
      }
    })
    if (foundLayer) {
      foundLayer.setStyle(getStyle('dist', true, distFeature))
    }

    // Mostrar detalles y noticias
    showDistrictDetails(props.UBIGEO, props.DISTRITO, props.PROVINCIA, props.DEPARTAMEN)

    // Actualizar breadcrumb
    updateBreadcrumb([
      { label: 'Perú', action: () => goToDepartments() },
      { label: props.DEPARTAMEN, action: () => goToProvinces(props.CCDD, props.DEPARTAMEN) },
      { label: props.PROVINCIA, action: () => goToDistricts(props.CCDD, props.CCPP, props.PROVINCIA, props.DEPARTAMEN) },
      { label: props.DISTRITO, active: true }
    ])
  }
})

// Evento de clic derecho en el mapa para reportar incidentes
map.on('contextmenu', async (e) => {
  const lat = e.latlng.lat
  const lon = e.latlng.lng
  
  openPanel('Buscando distrito...', 'Geografía', 'neutral', 'Identificando distrito para las coordenadas seleccionadas... Por favor, espera.')
  
  // Asegurar carga asíncrona de distritos para cruzar coordenadas
  if (!geoDist) {
    try {
      await ensureGeoJSONLoaded('dist')
    } catch (err) {
      openPanel('Error', 'Geografía', 'neutral', 'No se pudo cargar la capa de distritos: ' + err.message)
      return
    }
  }
  
  const distFeature = findDistrictByCoords(lat, lon)
  if (distFeature) {
    const props = distFeature.properties
    openIncidentForm(lat, lon, props.UBIGEO, props.DISTRITO, props.PROVINCIA, props.DEPARTAMEN)
  } else {
    openPanel('Ubicación fuera de límites', 'Reporte', 'neutral', 'La ubicación seleccionada está fuera de los distritos geográficos registrados del Perú.')
  }
})

// ============================
// Modal de Configuración (Google API Key)
// ============================
const settingsToggle = document.getElementById('settings-toggle')
const settingsModal = document.getElementById('settings-modal')
const settingsClose = document.getElementById('settings-close')
const btnSaveSettings = document.getElementById('btn-save-settings')
const btnClearSettings = document.getElementById('btn-clear-settings')
const inputGoogleApiKey = document.getElementById('google-api-key')

// Cargar la API Key guardada al arrancar
async function loadGoogleApiKey() {
  try {
    const key = await ipcRenderer.invoke('db-get-setting', 'google-api-key')
    if (key) {
      inputGoogleApiKey.value = key
    }
  } catch (err) {
    console.error('Error al cargar API Key de settings:', err)
  }
}

// Inicializar API Key al cargar
loadGoogleApiKey()

settingsToggle.onclick = () => {
  settingsModal.classList.remove('hide')
}

settingsClose.onclick = () => {
  settingsModal.classList.add('hide')
}

// Cerrar haciendo clic fuera del modal
settingsModal.onclick = (e) => {
  if (e.target === settingsModal) {
    settingsModal.classList.add('hide')
  }
}

btnSaveSettings.onclick = async () => {
  const value = inputGoogleApiKey.value.trim()
  if (!value) {
    alert('Por favor ingresa una clave válida.')
    return
  }
  try {
    await ipcRenderer.invoke('db-set-setting', { key: 'google-api-key', value })
    alert('API Key de Google Maps guardada con éxito.')
    settingsModal.classList.add('hide')
    
    // Si hay una categoría POI activa, recargar los marcadores usando la API Key
    if (activePoiCategory) {
      fetchPOIs(activePoiCategory)
    }
  } catch (err) {
    alert('Error al guardar la clave: ' + err.message)
  }
}

btnClearSettings.onclick = async () => {
  try {
    await ipcRenderer.invoke('db-set-setting', { key: 'google-api-key', value: null })
    inputGoogleApiKey.value = ''
    alert('API Key eliminada. La app usará la base de datos offline de OpenStreetMap.')
    settingsModal.classList.add('hide')
    
    // Si hay una categoría POI activa, recargar usando el fallback
    if (activePoiCategory) {
      fetchPOIs(activePoiCategory)
    }
  } catch (err) {
    alert('Error al eliminar la clave: ' + err.message)
  }
}