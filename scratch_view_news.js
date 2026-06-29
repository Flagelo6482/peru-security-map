const Database = require('better-sqlite3')
const path = require('path')
const os = require('os')

try {
  const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'peru-security-map', 'peru_security.db')
  console.log(`Conectando a base de datos en: ${dbPath}`)
  const db = new Database(dbPath, { fileMustExist: true })

  // 1. Mostrar resumen por categorías
  const summary = db.prepare('SELECT category, COUNT(*) as count FROM global_news GROUP BY category').all()
  console.log('\n=== RESUMEN DE NOTICIAS POR CATEGORÍA EN CACHÉ ===')
  summary.forEach(row => {
    console.log(`- ${row.category}: ${row.count} artículos`)
  })

  // 2. Mostrar todas las noticias guardadas
  const rows = db.prepare('SELECT source, title, category, fetched_at FROM global_news ORDER BY fetched_at DESC').all()
  console.log(`\n=== LISTADO DETALLADO DE NOTICIAS (${rows.length} en total) ===`)
  rows.forEach((r, idx) => {
    console.log(`[${idx + 1}] [${r.source}] [Categoría: ${r.category}]`)
    console.log(`    Título: ${r.title}`)
    console.log(`    Guardada el: ${r.fetched_at}\n`)
  })
} catch (err) {
  console.error('Error al leer la base de datos:', err.message)
  console.log('Asegúrate de haber corrido la aplicación al menos una vez para poblar la base de datos.')
}
