# 🔐 Portal ALS — Migración a Supabase Auth + RLS real

Guía de despliegue, pruebas y rollback.

---

## 📦 Archivos del paquete

| Archivo | Destino | Qué hace |
|---|---|---|
| `01_seguridad_completa.sql` | Supabase SQL Editor | Vincula auth_user_id, crea funciones RLS, reescribe policies |
| `auth-guard.js` | **NUEVO** — raíz del repo de GitHub Pages | Sistema unificado de auth/permisos/inactividad |
| `index.html` | reemplaza el existente | Login solo vía Auth + delegación a PortalGuard |
| `taric.html` | reemplaza el existente | Guard unificado |
| `airport_cargo.html` | reemplaza el existente | Guard unificado |
| `pendencias.html` | reemplaza el existente | Guard unificado |
| `despacho.html` | reemplaza el existente | Guard unificado |

---

## 🚀 Orden de despliegue OBLIGATORIO

**No se puede invertir el orden. Si subes el HTML antes del SQL, los usuarios no podrán hacer login.**

### Paso 1 — Migración SQL

1. Abre **Supabase Dashboard → SQL Editor → New query**
2. Pega el contenido completo de `01_seguridad_completa.sql`
3. Pulsa **Run**
4. Revisa el bloque 7 al final (verificación). Debes ver:
   - `app_es_admin`, `app_user_can`, `app_get_session_data` y los demás → existen, todas con `🔒 DEFINER`
   - Policies en `usuarios`: `usuarios_select_auth`, `usuarios_update_self`, `usuarios_admin_all`
   - Policies en `als_*`: `*_select_auth`, `*_admin_write`
   - Cada usuario activo con vinculado=`✅` y `ha_loguead_via_auth=true` o `false`

### Paso 2 — Verificación manual desde el SQL Editor

Ejecuta esta query (te identifica como Marcos vía Service Role):

```sql
-- Simular auth.uid() = id de Marcos para verificar las funciones
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims TO '{"sub":"09793b79-d3d2-4416-b983-a05002e2081b","role":"authenticated"}';

SELECT app_es_admin() as soy_admin,
       app_current_usuario_id() as mi_id,
       app_current_user_roles() as mis_roles;

SELECT app_get_session_data();

RESET ROLE;
```

Debes ver:
- `soy_admin = true`
- `mi_id = 00000000-0000-0000-0000-000000000001` (id de Marcos en `usuarios`)
- `mis_roles = {admin}`
- `app_get_session_data` devuelve un JSON con `es_admin: true` y matriz completa de permisos

### Paso 3 — Subir archivos a GitHub Pages

En el repositorio del portal:
1. Subir `auth-guard.js` (archivo nuevo)
2. Subir los 5 HTML modificados
3. **Vaciar caché del navegador completamente** (Cmd+Shift+Delete → "Caché de imágenes y archivos")
4. **Forzar actualización del Service Worker** (en DevTools → Application → Service Workers → Unregister)

---

## ✅ Plan de pruebas — 8 escenarios obligatorios

Ejecuta TODOS antes de confirmar el despliegue como completado.

### Test 1 — Login como admin (Marcos)

1. Abrir `portal.alsalgeciras.com/index.html` en navegador limpio
2. Login con `mvalencia@customsway.eu` + tu contraseña
3. **Resultado esperado**:
   - Login exitoso
   - Home muestra TODAS las cards
   - Sidebar muestra TODOS los módulos de administración
   - En DevTools Console: ningún error rojo

### Test 2 — Login como rol limitado (Roberto, aduanas)

1. Logout
2. Login con `rgarcia@customsway.eu`
3. **Resultado esperado**:
   - Home muestra solo cards que él puede ver (almacén, expediciones, facturación, etc.)
   - **NO** ve la card "Usuarios" ni "Configuración"
   - Sidebar tampoco las muestra
   - Botón "Eliminar" en empresas: oculto (puede_eliminar=true en su rol aduanas según los datos, pero overrides personalizados puedan modificarlo)

### Test 3 — Manipulación de localStorage

1. Logueado como Roberto, abrir DevTools → Application → Local Storage
2. Modificar `als_cu` añadiendo `"rol":"admin"` y refrescar
3. **Resultado esperado**:
   - PortalGuard pide a la BD `app_get_session_data()` y devuelve el rol REAL (aduanas)
   - El frontend NO concede privilegios admin
   - El sidebar y cards siguen siendo los de aduanas
   - Si intenta editar la tabla `usuarios` desde DevTools, las RLS bloquean la operación

### Test 4 — Inactividad: aviso a los 30 min

1. Logueado como cualquier usuario
2. Abrir DevTools → Application → Local Storage
3. Editar `als_last_activity` a un timestamp 31 minutos en el pasado:
   - Calcular: `Date.now() - 31*60*1000`
   - Pegar como valor
4. Mover el ratón o hacer scroll para disparar el listener
5. **Resultado esperado**: aparece el banner "Sesión a punto de cerrarse" con botón "Seguir"

### Test 5 — Inactividad: cierre forzado a los 35 min

1. Como Test 4 pero con timestamp 36 min en el pasado
2. Mover el ratón
3. **Resultado esperado**: logout inmediato, redirección a login con `?reason=inactivity`

### Test 6 — Inactividad sobrevive a cambio de módulo

1. Login. En el index.html, esperar 20 min (o ajustar `als_last_activity` a -20 min)
2. Navegar a `taric.html`
3. Esperar 11 minutos más (o ajustar el timestamp)
4. **Resultado esperado**: el banner de aviso aparece en taric.html, no se ha reseteado el timer al cambiar de módulo

### Test 7 — Editar usuarios desde el panel admin

1. Logueado como Marcos
2. Configuración → Usuarios → editar uno
3. Cambiar permisos personalizados de algún módulo
4. **Resultado esperado**:
   - Guardado correcto sin toast de error
   - Refrescar la página: los cambios persisten
   - Loguearse con el usuario editado: los permisos nuevos se aplican

### Test 8 — Acceso directo a módulo sin permiso

1. Logueado como Roberto (no tiene módulo `usuarios`)
2. Ir directamente a `portal.alsalgeciras.com/taric.html` por URL
3. **Resultado esperado**:
   - Si Roberto tiene permiso para taric → entra normal
   - Si NO tiene → pantalla "Acceso denegado" + redirección automática a `index.html` tras 5 segundos

---

## 🆘 Rollback si algo va mal

Si tras el despliegue alguien no puede entrar:

### Caso 1 — Un usuario no puede hacer login

```sql
-- Verifica que está vinculado a auth.users
SELECT u.nombre, u.email, u.auth_user_id, au.email as auth_email
FROM usuarios u
LEFT JOIN auth.users au ON au.id = u.auth_user_id
WHERE u.email = 'EMAIL_DEL_USUARIO_PROBLEMÁTICO';

-- Si auth_user_id es NULL pero existe en auth.users con el mismo email:
UPDATE usuarios u SET auth_user_id = au.id
FROM auth.users au
WHERE LOWER(au.email) = LOWER(u.email)
  AND u.email = 'EMAIL_DEL_USUARIO_PROBLEMÁTICO';

-- Si no existe en auth.users, créalo:
-- Dashboard → Authentication → Users → Add user → email + password
-- Luego ejecuta el UPDATE de arriba
```

### Caso 2 — Las RLS están bloqueando TODO

```sql
-- Modo emergencia: reabrir lectura en usuarios
DROP POLICY IF EXISTS usuarios_select_auth ON usuarios;
CREATE POLICY usuarios_select_auth ON usuarios FOR SELECT TO authenticated USING (true);
NOTIFY pgrst, 'reload schema';
```

### Caso 3 — Rollback total

```sql
-- Restaurar policies viejas (permisivas)
DROP POLICY IF EXISTS usuarios_admin_all ON usuarios;
DROP POLICY IF EXISTS usuarios_update_self ON usuarios;
CREATE POLICY emergency_open ON usuarios FOR ALL TO public USING (true) WITH CHECK (true);

-- Y reactivar el RPC bcrypt para que el frontend antiguo funcione
-- (las funciones verificar_password siguen existiendo, no fueron eliminadas)
```

Restaurar el `index.html` de la versión anterior desde git history.

---

## 🧹 Limpieza posterior (opcional, tras 1 semana sin incidencias)

Cuando todo lleve estable 1 semana, ejecutar `02_cleanup.sql`:

```sql
-- Eliminar columnas legacy de password
ALTER TABLE usuarios DROP COLUMN IF EXISTS password_hash;
ALTER TABLE usuarios DROP COLUMN IF EXISTS password_bcrypt;
ALTER TABLE usuarios DROP COLUMN IF EXISTS must_change_password;

-- Eliminar RPCs de bcrypt (ya no se usan)
DROP FUNCTION IF EXISTS verificar_password(text, text);
DROP FUNCTION IF EXISTS verificar_password_email(text, text);
DROP FUNCTION IF EXISTS cambiar_password(uuid, text);
```

---

## 📊 Mejoras de seguridad introducidas

| Antes | Después |
|---|---|
| `_permisos = {__admin: true}` por defecto | `puedeAcceder()` devuelve `false` mientras no se cargan permisos |
| Admin se decidía por contenido de localStorage | Admin se decide por `app_es_admin()` consultando BD vía `auth.uid()` |
| 4 guards distintos, uno por módulo | 1 sólo guard (PortalGuard) usado por todos |
| Inactividad solo en index.html | Inactividad en todos los módulos, persistida en localStorage |
| RLS `USING(true)` en tablas críticas | RLS basadas en `auth.uid()` y `app_es_admin()` |
| Bcrypt RPC + Auth dual | Solo Supabase Auth (bcrypt mantenido transitoriamente en BD por seguridad) |
| Timer inactividad se resetea al cambiar módulo | Timer persiste en localStorage, sobrevive recarga y cambio de módulo |
| `update().select()` falla por RLS | RLS permite a admin operar correctamente |

---

## 📞 Si hay problemas durante el deploy

Comparte:
1. Mensaje exacto de la consola del navegador (F12 → Console)
2. Resultado de esta query:
   ```sql
   SELECT app_get_session_data();
   ```
   ejecutada tras loguearte como el usuario problemático en Dashboard → SQL Editor con el "user" cambiado en Authentication.
3. Salida del bloque 7 del SQL de migración.
