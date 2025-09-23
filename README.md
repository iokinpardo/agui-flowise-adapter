# AG-UI ↔ Flowise Adapter (Render ready)

Este microservicio expone una pasarela HTTP que transforma las respuestas de flujo de agentes de [Flowise](https://flowiseai.com/) en un stream de eventos compatible con AG-UI. La aplicación está escrita en **TypeScript** sobre **Express** y está preparada para desplegarse en Render mediante el archivo [`render.yaml`](./render.yaml).

## ¿Cómo funciona?

1. El cliente (AG-UI) abre una conexión **Server-Sent Events (SSE)** contra `GET /agui/stream` enviando los parámetros de consulta:
   - `chatflowId`: identificador del flujo en Flowise que debe ejecutarse.
   - `q`: mensaje o pregunta del usuario final.
2. El adaptador envía la petición a Flowise `POST /api/v1/prediction/:chatflowId` activando el modo de streaming (`stream: true`).
3. Mientras Flowise produce tokens, estados o metadatos, el adaptador los normaliza y los reenvía como eventos SSE hacia AG-UI.
4. Una vez finalizado el flujo, el servidor emite los eventos de cierre y termina la conexión.

El endpoint `/health` devuelve `{ ok: true }` y se utiliza para las comprobaciones de estado en Render.

## Eventos emitidos

El stream SSE expone varios tipos de eventos para que el cliente pueda reconstruir la conversación y el estado de ejecución:

- `run.input`: mensaje inicial con la consulta del usuario.
- `status.update`: mensajes de estado, metadatos o diffs de variables (`state.changed` y `state.full`).
- `message.delta`: porciones del texto del asistente. El adaptador fragmenta las respuestas en oraciones o bloques de 120 caracteres.
- `message.completed`: indica que la respuesta del asistente ha terminado.
- `run.error`: se emite cuando ocurre un error al llamar al flujo.
- `run.completed`: evento final que cierra la ejecución (éxito o error).

Además, se ignoran tokens de control (`INPROGRESS`, `FINISHED`, `[DONE]`) y se normalizan saltos de línea/HTML. Para evitar duplicados, se calcula un hash de cada fragmento antes de reenviarlo.

### Seguimiento de estado

Flowise puede enviar estructuras `state` o `agentFlowExecutedData` durante la ejecución. El adaptador compara cada payload con el estado previo y solo emite las claves que cambian, junto con el estado completo actual, para optimizar el renderizado en AG-UI. También se etiquetan los nodos (`nodeId`, `nodeLabel`) que generan los cambios cuando esa información está disponible.

## Variables de entorno

| Variable            | Descripción                                                     | Valor por defecto       |
|---------------------|-----------------------------------------------------------------|-------------------------|
| `FLOWISE_BASE_URL`  | URL base de la instancia de Flowise.                            | `http://localhost:3000` |
| `FLOWISE_API_KEY`   | Token opcional de autenticación Bearer para Flowise.            | *(cadena vacía)*        |
| `PORT`              | Puerto HTTP en el que escuchará el adaptador.                   | `8787`                  |

> En Render, `FLOWISE_BASE_URL` y `FLOWISE_API_KEY` pueden configurarse como *env vars* gestionadas desde el panel (ver [`render.yaml`](./render.yaml)).

## Scripts de npm

- `npm run dev`: inicia el servidor en modo desarrollo con recarga en caliente (`tsx watch`).
- `npm run build`: compila el proyecto a JavaScript en `dist/` mediante `tsc`.
- `npm start`: arranca la versión compilada (`node dist/server.js`).

## Ejecución local

```bash
npm install
FLOWISE_BASE_URL="https://mi-flowise" \
FLOWISE_API_KEY="<opcional>" \
npm run dev
```

Luego abre `http://localhost:8787/agui/stream?chatflowId=<ID>&q=Hola` desde un cliente SSE (por ejemplo, la propia AG-UI) para verificar el stream. También puedes comprobar la salud en `http://localhost:8787/health`.

## Manejo de errores y reconexión

- Si Flowise responde sin `body` o con un estado HTTP distinto de 2xx, el adaptador emite `run.error` con el detalle y finaliza el stream.
- Se mantiene un *heartbeat* (`: ping`) cada 15 s para conservar viva la conexión SSE.
- Al cerrar el cliente, se limpia el `AbortController` y se interrumpe la petición hacia Flowise.

## Despliegue en Render

El repositorio incluye una definición de servicio (`render.yaml`) lista para desplegar usando el entorno Docker de Render. Solo es necesario definir las variables de entorno mencionadas arriba y Render utilizará `/health` como ruta de *health check*.

---

Este README resume el flujo completo del adaptador y los puntos clave para ejecutarlo o integrarlo con AG-UI y Flowise.
