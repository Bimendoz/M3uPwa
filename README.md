# Listas M3U — PWA para iPhone (Safari)

Busca canales por nombre, **los prueba reproduciéndolos de verdad** y arma listas `.m3u` / `.m3u8` con categorías
para CarTV, VLC y apps IPTV. Funciona en iPhone, iPad, Android y computador.

## Publicarla (necesita HTTPS)
Una PWA tiene que estar en una dirección `https://`. Dos opciones gratis:

**A. Netlify Drop (la más rápida, 1 minuto)**
1. Entra a https://app.netlify.com/drop
2. Arrastra esta carpeta `pwa` completa.
3. Te da un link `https://…netlify.app`: ábrelo en Safari del iPhone.

**B. GitHub Pages (ya tienes cuenta de GitHub)**
1. Crea un repositorio nuevo (p. ej. `listas-m3u`) y sube el contenido de esta carpeta.
2. Settings → Pages → Branch `main` / carpeta raíz → Save.
3. Link: `https://TU_USUARIO.github.io/listas-m3u/`

## Instalar en el iPhone
Safari → abre el link → Compartir (cuadro con flecha) → **Añadir a pantalla de inicio**.

## Cómo funciona
- **🔎 Buscar**: busca en el directorio público de canales gratuitos (iptv-org). Cada link se reproduce en segundo
  plano y solo aparece si el video avanza de verdad. Safari prueba igual que las apps del iPhone.
- **📺 Mis listas**: varias listas, cada una con sus categorías (salen como grupos en CarTV/VLC).
  Agregar links a mano (se prueban), importar `.m3u`, mover, renombrar, probar todos.
- **Exportar**: compartir el archivo (menú del iPhone → CarTV, VLC, Archivos), descargar `.m3u` o `.m3u8`,
  copiar el texto, o crear un **link fijo** (Gist de GitHub) que se actualiza solo.
- Los datos quedan guardados en el equipo. Usa Ajustes → Copia de seguridad para respaldarlos.

## Extraer de una página y buscar con tu computador
- En 🔎 Buscar pega el link de la página donde ves el canal → **Extraer**.
  1. Si el link del video está escrito en el código de la página y la página deja leerse, la app lo saca sola.
  2. Si no (lo más común: el reproductor arma el link en vivo), le pasa el encargo a la **extensión de Chrome
     de tu computador** por tu GitHub. La extensión abre la página, captura el video, lo prueba y responde.
     La app lo vuelve a probar aquí y te dice si también funciona en este equipo.
- La búsqueda por nombre sigue el mismo recorrido que la extensión, link por link y en orden: directorio → sitio oficial → resultados de la web.
  Si el directorio no alcanza, la app le pasa sola el encargo a tu computador con tus ajustes (Ajustes → Búsqueda):
  **parar en el primer link que funcione** y **cuántos resultados de la web revisar** (sin límite). En «Páginas revisadas» ves cada página que abrió.
- Requisitos: el mismo usuario de GitHub en la app (Ajustes) y en la extensión (lista publicada), y el computador
  prendido con Chrome abierto. La extensión revisa encargos cada 30 segundos.

## Límites de una app web (no los tiene la extensión de Chrome)
- Por sí sola no puede abrir otras páginas por detrás: para eso usa el puente con la extensión.
- No puede probar links que exigen Referer (Safari no deja cambiarlo): se descartan en la búsqueda.
- Los links con 🔒 (amarrados a la red) solo funcionan en la red donde se probaron.
