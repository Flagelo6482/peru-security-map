# peru-security-map


Cuando clones el repo a tu PC, abre .gitignore en VS Code y agrega las líneas al final, luego:
bashgit add .gitignore
git commit -m "Agregar reglas .gitignore para Electron"
git push


Realizar en pc local:
# 1. Clonar el repo
git clone https://github.com/Flagelo6482/peru-security-map.git
cd peru-security-map

# 2. Instalar TODAS las dependencias de un solo comando
npm install

# 3. Ejecutar
npm start








# Mapa Interactivo de Seguridad — Perú

App de escritorio que muestra el mapa interactivo del Perú con puntos de incidencia clasificados por nivel de alerta.

## Stack

- **Electron** — App de escritorio
- **Leaflet.js** — Mapa interactivo (vía CDN)
- **GeoJSON oficial INEI/IGN** — Datos geográficos

## Instalación

```bash
git clone https://github.com/Flagelo6482/peru-security-map.git
cd peru-security-map
npm install
npm start
```

## Dependencias instaladas

### Producción
_(Aún no hay, se agregarán: better-sqlite3, rss-parser)_

### Desarrollo
- `electron` — Runtime de la app
- `electron-builder` — Generador de instalador (pendiente)

## Estructura