# Recomendaciones de Arquitectura para Integración con Asistente de IA

Este documento detalla las pautas, protocolos y estructura de comandos recomendados para conectar un Asistente de IA externo (desarrollado en Python, Flutter u otro lenguaje) con la aplicación **Perú Security Map** para controlarla mediante órdenes de voz o texto.

---

## 1. Arquitectura de Conexión Recomendada (API Local)

Dado que la aplicación corre en **Electron (proceso de escritorio local)** y tu asistente de IA podría residir en un servicio en Python o una app móvil de Flutter, la mejor opción es abrir un canal de red local.

### Opción A: Servidor HTTP REST (Recomendada por simplicidad)
Instalar un servidor de red ultraligero dentro de Electron (por ejemplo, con `express` o usando el módulo `http` nativo de Node.js en `main.js`).
1. El Asistente de IA procesa la orden de voz/texto del usuario.
2. Traduce la orden a una acción en formato JSON.
3. Envía una petición `POST` HTTP a `http://localhost:3000/api/control`.
4. El servidor de Electron recibe el JSON y lo envía al mapa usando el IPC de Electron (`ipcMain` $\rightarrow$ `ipcRenderer`).

### Opción B: Servidor WebSockets (Recomendada para tiempo real)
Ideal si deseas comunicación bidireccional (por ejemplo, que el mapa le envíe al asistente lo que se está mostrando en pantalla en tiempo real).

---

## 2. Contrato de Comandos (Command Pattern)

Para que el asistente manipule el mapa de forma consistente, se debe establecer un contrato de datos JSON estructurado. A continuación, se detallan los comandos recomendados correspondientes a las funciones existentes en la aplicación:

### A. Comando de Navegación (`navigate_to`)
Le permite al asistente mover la cámara, cargar distritos y enfocar la visualización.
* **Payload JSON:**
  ```json
  {
    "command": "navigate_to",
    "params": {
      "target": "Ate",
      "scope": "dist"
    }
  }
  ```
* **Mapeo en app.js:** Debe invocar a la función `navigateToPlace(scope, feature)`.

### B. Comando de Filtro de Alertas (`filter_alerts`)
Filtra los marcadores de incidentes y el sombreado de distritos según su nivel de severidad.
* **Payload JSON:**
  ```json
  {
    "command": "filter_alerts",
    "params": {
      "level": "critical" 
    }
  }
  ```
  *(Valores válidos para level: `"all"`, `"critical"`, `"moderated"`, `"safe"`)*

### C. Comando de Lugares de Interés (`toggle_poi`)
Activa o desactiva la visualización de POIs (Comisarías, Hospitales, etc.).
* **Payload JSON:**
  ```json
  {
    "command": "toggle_poi",
    "params": {
      "category": "police"
    }
  }
  ```
  *(Valores válidos para category: `"none"`, `"all"`, `"police"`, `"hospital"`, `"school"`, `"hotel"`, `"restaurant"`)*

### D. Comando de Reset / Limpieza (`reset`)
Limpia las selecciones, resetea el buscador y quita los sombreados (equivalente a la tecla `Esc`).
* **Payload JSON:**
  ```json
  {
    "command": "reset"
  }
  ```

---

## 3. Ejemplo de Implementación Rápida en Electron (`main.js`)

Puedes añadir esta sección al final de `main.js` para recibir comandos desde tu backend en Python o dispositivo Flutter:

```javascript
const http = require('http');

function startControlServer(windowReference) {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/control') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          console.log('[AI-Server] Comando recibido:', payload);
          
          // Enviar comando al Renderer Process (app.js)
          windowReference.webContents.send('ai-map-command', payload);
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', msg: 'Comando enviado al mapa' }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', msg: 'JSON Inválido' }));
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(3000, 'localhost', () => {
    console.log('[AI-Server] Servidor de control escuchando en http://localhost:3000');
  });
}
```

---

## 4. Ejemplo de Cliente de IA en Python (Backend)

Tu script de procesamiento de IA en Python puede enviar la orden estructurada al mapa de la siguiente manera:

```python
import requests

def enviar_comando_mapa(accion, parametros=None):
    url = "http://localhost:3000/api/control"
    payload = {
        "command": accion,
        "params": parametros or {}
    }
    try:
        response = requests.post(url, json=payload)
        return response.json()
    except Exception as e:
        print(f"Error al conectar con el mapa: {e}")
        return None

# Ejemplo: El usuario dice "Busca la comisaría de Comas"
enviar_comando_mapa("navigate_to", {"target": "Comas", "scope": "dist"})
enviar_comando_mapa("toggle_poi", {"category": "police"})
```

---

## 5. Integración con App Móvil Flutter (Control Remoto)
1. Si la app móvil y la app de escritorio de Electron están conectadas a la misma red WiFi:
   * Cambia `'localhost'` en el servidor de Node.js a `'0.0.0.0'` para recibir peticiones externas.
   * La app de Flutter puede enviar llamadas HTTP directas a la IP de la computadora (ej. `http://192.168.1.15:3000/api/control`) al recibir una orden del usuario por voz en su teléfono, manipulando la pantalla de escritorio al instante.
