const https = require('https');
const fs = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, '..', 'assets', 'pois_local.json');

const ISO_CODES = [
  'PE-CAL', 'PE-LMA', 'PE-LIM', 'PE-ARE', 'PE-CUS', 'PE-LAL', 'PE-PIU', 'PE-CAJ', 
  'PE-PUN', 'PE-JUN', 'PE-LAM', 'PE-ANC', 'PE-LOR', 'PE-ICA', 'PE-SAM', 'PE-HUC', 
  'PE-AYA', 'PE-UCA', 'PE-APU', 'PE-AMA', 'PE-TAC', 'PE-PAS', 'PE-TUM', 'PE-MDD', 
  'PE-MOQ', 'PE-HUV'
];

const CATEGORIES = {
  police: 'node["amenity"="police"](area.searchArea); way["amenity"="police"](area.searchArea);',
  hospital: 'node["amenity"~"hospital|clinic"](area.searchArea); way["amenity"~"hospital|clinic"](area.searchArea);',
  school: 'node["amenity"~"school|university|college|kindergarten"](area.searchArea); way["amenity"~"school|university|college|kindergarten"](area.searchArea);',
  hotel: 'node["tourism"~"hotel|hostel|motel|guest_house|apartment"](area.searchArea); way["tourism"~"hotel|hostel|motel|guest_house|apartment"](area.searchArea);',
  restaurant: 'node["amenity"~"restaurant|fast_food|cafe|bar|pub"](area.searchArea); way["amenity"~"restaurant|fast_food|cafe|bar|pub"](area.searchArea);'
};

function queryOverpass(queryText) {
  return new Promise((resolve, reject) => {
    const postData = 'data=' + encodeURIComponent(queryText);
    
    const options = {
      hostname: 'overpass-api.de',
      port: 443,
      path: '/api/interpreter',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'PeruSecurityMapPOIDownloader/1.0 (contact@flagelo.com)'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Respuesta JSON inválida: ' + e.message));
          }
        } else {
          reject(new Error(`Código de estado: ${res.statusCode}`));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.write(postData);
    req.end();
  });
}

async function downloadAll() {
  console.log('Iniciando descarga particionada por región del 100% de POIs del Perú...');
  const allPois = [];
  const processedCoordinates = new Set(); // Evitar duplicados por fronteras

  for (let i = 0; i < ISO_CODES.length; i++) {
    const code = ISO_CODES[i];
    console.log(`\n[${i+1}/${ISO_CODES.length}] Descargando puntos para ${code}...`);
    
    // Consulta combinada para esta región
    const query = `[out:json][timeout:180];
      area["ISO3166-2"="${code}"]->.searchArea;
      (
        ${Object.values(CATEGORIES).join('\n        ')}
      );
      out center;`;

    let attempts = 3;
    let success = false;
    let data;

    while (attempts > 0 && !success) {
      try {
        data = await queryOverpass(query);
        success = true;
      } catch (err) {
        attempts--;
        console.error(`⚠️ Error en ${code}: ${err.message}. Reintentos restantes: ${attempts}`);
        if (attempts > 0) {
          await new Promise(r => setTimeout(r, 6000));
        }
      }
    }

    if (!success) {
      console.error(`❌ No se pudieron obtener los datos de ${code} tras 3 intentos. Pasando al siguiente.`);
      continue;
    }

    const elements = data.elements || [];
    let addedCount = 0;

    elements.forEach(el => {
      const lat = el.lat || (el.center && el.center.lat);
      const lon = el.lon || (el.center && el.center.lon);

      if (lat && lon) {
        const roundLat = Number(lat.toFixed(6));
        const roundLon = Number(lon.toFixed(6));
        const key = `${roundLat},${roundLon}`;

        if (processedCoordinates.has(key)) return;
        processedCoordinates.add(key);

        const tags = el.tags || {};
        
        let cat = 'restaurant';
        if (tags.amenity === 'police') cat = 'police';
        else if (tags.amenity === 'hospital' || tags.amenity === 'clinic') cat = 'hospital';
        else if (tags.amenity === 'school' || tags.amenity === 'university' || tags.amenity === 'college' || tags.amenity === 'kindergarten') cat = 'school';
        else if (tags.tourism === 'hotel' || tags.tourism === 'hostel' || tags.tourism === 'motel' || tags.tourism === 'guest_house' || tags.tourism === 'apartment') cat = 'hotel';

        allPois.push({
          c: cat,
          lt: roundLat,
          ln: roundLon,
          n: tags.name || undefined,
          op: tags.operator || undefined,
          st: tags['addr:street'] || undefined,
          hn: tags['addr:housenumber'] || undefined,
          tl: tags.phone || undefined,
          wb: tags.website || undefined
        });
        addedCount++;
      }
    });

    console.log(`[${code}] Descargados y compactados ${addedCount} puntos.`);
    
    // Espera de 3.5 segundos para cumplir los límites de tasa del servidor
    await new Promise(r => setTimeout(r, 3500));
  }

  console.log(`\nGuardando base de datos consolidada de POIs...`);
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(allPois, null, 2), 'utf8');
  const stats = fs.statSync(OUTPUT_PATH);
  const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
  console.log(`\n✨ ¡Proceso completado! Guardado en: ${OUTPUT_PATH}`);
  console.log(`Total de puntos detallados en el Perú: ${allPois.length}`);
  console.log(`Tamaño final del archivo: ${sizeMb} MB`);
}

downloadAll();
