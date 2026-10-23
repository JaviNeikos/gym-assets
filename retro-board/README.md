# Retro Board

Tableros de retrospectiva sin registro ni captchas, pensados para equipos pequeños (< 15 personas) y para que un agente como Claude pueda crearlos por API.

Sin dependencias: solo Node >= 20. Tiempo real por SSE; los datos se guardan en `data/boards.json` y los tableros caducan a los 90 días.

```
npm start        # http://localhost:3000
npm test
```

Variables de entorno: `PORT`, `API_KEY` (si se define, crear tableros exige `Authorization: Bearer <key>`), `PUBLIC_URL` (para los enlaces devueltos), `DATA_FILE`.

## API

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/boards` | `{title, template? \| columns?, anonymous?, hideUntilReveal?, maxVotes?}` → `{url, adminUrl, adminToken, columns}` |
| GET | `/api/boards/:id` | Estado del tablero (las tarjetas ocultas no incluyen el texto) |
| POST | `/api/boards/:id/notes` | `{column, text, author?}` |
| POST | `/api/boards/:id/notes/:noteId` | Alterna tu voto |
| DELETE | `/api/boards/:id/notes/:noteId` | Autor o facilitador |
| POST | `/api/boards/:id/reveal` | Facilitador: `{revealed}` |
| GET | `/api/boards/:id/export` | Markdown ordenado por votos |
| GET | `/api/boards/:id/events` | SSE (`update`) |

Identidad: cabecera `x-client-id` (cualquier cadena estable por persona). Facilitador: cabecera `x-admin-token` o `?admin=`.
Plantillas: `went-well`, `start-stop-continue`, `mad-sad-glad`, `4ls`.
