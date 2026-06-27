// ============================
// Configuración inicial del mapa
// ============================
const map = L.map('map', {
  zoomControl: true,
  attributionControl: false,
  minZoom: 5,
  maxZoom: 19
}).setView([-9.19, -75.015], 6)

let tileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  maxZoom: 19,
  subdomains: 'abcd'
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

const fs = require('fs')
const path = require('path')

// ============================
// Estilos de polígonos
// ============================
const styleDep = { color: '#334155', weight: 1, fillColor: '#1e3a5f', fillOpacity: 0.6 }
const styleDepHover = { fillColor: '#2563eb', fillOpacity: 0.75, weight: 1.5 }
const styleProv = { color: '#475569', weight: 0.8, fillColor: '#1e3a5f', fillOpacity: 0.5 }
const styleProvHover = { fillColor: '#3b82f6', fillOpacity: 0.7 }
const styleDist = { color: '#64748b', weight: 0.5, fillColor: '#1e3a5f', fillOpacity: 0.4 }
const styleDistHover = { fillColor: '#60a5fa', fillOpacity: 0.65 }
const styleDepLight = { color: '#94a3b8', weight: 1, fillColor: '#bfdbfe', fillOpacity: 0.5 }
const styleProvLight = { color: '#94a3b8', weight: 0.8, fillColor: '#bfdbfe', fillOpacity: 0.4 }
const styleDistLight = { color: '#94a3b8', weight: 0.5, fillColor: '#bfdbfe', fillOpacity: 0.35 }

// ============================
// Cargar GeoJSON local
// ============================
function loadGeoJSON(filename) {
  const filepath = path.join(__dirname, 'assets', filename)
  const raw = fs.readFileSync(filepath, 'utf8')
  return JSON.parse(raw)
}

let geoDep, geoProv, geoDist

try {
  geoDep = loadGeoJSON('departamentos.geojson')
  geoProv = loadGeoJSON('provincias.geojson')
  geoDist = loadGeoJSON('distritos.geojson')
  console.log('GeoJSON cargado:', geoDep.features.length, 'departamentos,', geoProv.features.length, 'provincias,', geoDist.features.length, 'distritos')
} catch (err) {
  alert('Error cargando GeoJSON: ' + err.message)
  console.error(err)
}

// ============================
// Renderizar departamentos
// ============================
function showDepartments() {
  if (layerProv) { map.removeLayer(layerProv); layerProv = null }
  if (layerDist) { map.removeLayer(layerDist); layerDist = null }

  layerDep = L.geoJSON(geoDep, {
    style: styleDep,
    onEachFeature(feat, layer) {
      const name = feat.properties.NOMBDEP
      layer.bindTooltip(name, { sticky: true })

      layer.on('mouseover', () => { if (layersVisible && hoverEnabled) layer.setStyle(styleDepHover) })
      layer.on('mouseout', () => { if (layersVisible) layer.setStyle(darkMode ? styleDep : styleDepLight) })
      layer.on('click', () => {
        selectedDep = feat.properties.CCDD
        map.fitBounds(layer.getBounds(), { padding: [40, 40] })
        showProvinces(selectedDep, name)
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
function showProvinces(ccdd, depName) {
  if (layerDep) { map.removeLayer(layerDep); layerDep = null }
  if (layerDist) { map.removeLayer(layerDist); layerDist = null }

  const filtered = {
    type: 'FeatureCollection',
    features: geoProv.features.filter(f => f.properties.CCDD === ccdd)
  }

  layerProv = L.geoJSON(filtered, {
    style: styleProv,
    onEachFeature(feat, layer) {
      const name = feat.properties.NOMBPROV || feat.properties.NOMBRE
      layer.bindTooltip(name, { sticky: true })

      layer.on('mouseover', () => { if (layersVisible && hoverEnabled) layer.setStyle(styleProvHover) })
      layer.on('mouseout', () => { if (layersVisible) layer.setStyle(darkMode ? styleProv : styleProvLight) })
      layer.on('click', () => {
        selectedProv = feat.properties.CCPP
        map.fitBounds(layer.getBounds(), { padding: [40, 40] })
        showDistricts(ccdd, selectedProv, name, depName)
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
function showDistricts(ccdd, ccpp, provName, depName) {
  if (layerProv) { map.removeLayer(layerProv); layerProv = null }
  if (layerDep) { map.removeLayer(layerDep); layerDep = null }

  const filtered = {
    type: 'FeatureCollection',
    features: geoDist.features.filter(f => f.properties.CCDD === ccdd && f.properties.CCPP === ccpp)
  }

  layerDist = L.geoJSON(filtered, {
    style: styleDist,
    onEachFeature(feat, layer) {
      const name = feat.properties.NOMBDIST || feat.properties.NOMBRE
      layer.bindTooltip(name, { sticky: true })

      layer.on('mouseover', () => { if (layersVisible && hoverEnabled) layer.setStyle(styleDistHover) })
      layer.on('mouseout', () => { if (layersVisible) layer.setStyle(darkMode ? styleDist : styleDistLight) })
      layer.on('click', () => {
        openPanel(name, `${provName}, ${depName}`, 'yellow', null, true)
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

function goToProvinces(ccdd, depName) {
  selectedProv = null
  showProvinces(ccdd, depName)
  updateBreadcrumb([
    { label: 'Perú', action: () => goToDepartments() },
    { label: depName, active: true }
  ])
}

function goToDistricts(ccdd, ccpp, provName, depName) {
  showDistricts(ccdd, ccpp, provName, depName)
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
showDepartments()
document.getElementById('loader').classList.add('hide')

// ============================
// Activar / desactivar resaltado hover
// ============================
document.getElementById('hover-toggle').onclick = () => {
  hoverEnabled = !hoverEnabled
  const btn = document.getElementById('hover-toggle')
  btn.classList.toggle('hover-off', !hoverEnabled)
  btn.title = hoverEnabled ? 'Desactivar resaltado' : 'Activar resaltado'

  if (!hoverEnabled) {
    if (layerDep) layerDep.setStyle(darkMode ? styleDep : styleDepLight)
    if (layerProv) layerProv.setStyle(darkMode ? styleProv : styleProvLight)
    if (layerDist) layerDist.setStyle(darkMode ? styleDist : styleDistLight)
  }
}

// ============================
// Mostrar / ocultar capas
// ============================
document.getElementById('layer-toggle').onclick = () => {
  layersVisible = !layersVisible
  const btn = document.getElementById('layer-toggle')
  btn.classList.toggle('layer-off', !layersVisible)
  btn.title = layersVisible ? 'Ocultar zonas' : 'Mostrar zonas'

  if (layersVisible) {
    if (layerDep) layerDep.setStyle(darkMode ? styleDep : styleDepLight)
    if (layerProv) layerProv.setStyle(darkMode ? styleProv : styleProvLight)
    if (layerDist) layerDist.setStyle(darkMode ? styleDist : styleDistLight)
  } else {
    const hidden = { opacity: 0, fillOpacity: 0 }
    if (layerDep) layerDep.setStyle(hidden)
    if (layerProv) layerProv.setStyle(hidden)
    if (layerDist) layerDist.setStyle(hidden)
  }
}

// ============================
// Modo oscuro / claro
// ============================
document.getElementById('theme-toggle').onclick = () => {
  darkMode = !darkMode
  document.body.classList.toggle('light', !darkMode)
  document.getElementById('theme-toggle').textContent = darkMode ? '🌙' : '☀️'

  map.removeLayer(tileLayer)
  const url = darkMode
    ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
  tileLayer = L.tileLayer(url, { maxZoom: 19, subdomains: 'abcd' }).addTo(map)

  if (layerDep) layerDep.setStyle(darkMode ? styleDep : styleDepLight)
  if (layerProv) layerProv.setStyle(darkMode ? styleProv : styleProvLight)
  if (layerDist) layerDist.setStyle(darkMode ? styleDist : styleDistLight)
}