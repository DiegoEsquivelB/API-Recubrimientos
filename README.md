# API Proyecto G2

Backend REST del sistema de gestión para recubrimientos arquitectónicos.

## Requisitos

- Node.js 18 o superior
- MySQL 8 o superior
- Base de datos con nombre `recubrimientos`

## Librerías del backend

- `express 5.1.0`: creación de la API REST y manejo de rutas HTTP.
- `mysql2 3.14.3`: conexión y consultas parametrizadas a MySQL.
- `bcryptjs 3.0.2`: hash y verificación de contraseñas.
- `cors 2.8.6`: configuración de solicitudes desde el frontend.
- `dotenv 16.4.7`: carga de variables de entorno desde `.env`.

Las dependencias se instalan con `npm install` y están definidas en `package.json`.

## Instalación

```powershell
cd "API-ProyectoG2"
npm install
Copy-Item .env.example .env
```

Configure el archivo `.env` con la conexión a MySQL:

```env
PORT=3000
DB_HOST=localhost
DB_PORT=3306
DB_NAME=recubrimientos
DB_USER=root
DB_PASSWORD=root
```

Luego importe el esquema si aún no existe:

```powershell
mysql -u root -p < database\schema.sql
```

O puede ejecutarlo desde MySQL Workbench.

## Ejecutar la API

```powershell
npm run dev
```

La API queda disponible en:

- `http://localhost:3000`
- `http://localhost:3000/api/health`

## Funcionalidades principales

- Autenticación de usuarios
- Gestión de clientes
- Gestión de materiales e inventario
- Cálculo de materiales por proyecto
- CRUD de proyectos
- Reportes y panel principal

## Roles y permisos

- `Administrador`: acceso completo, incluida la creación, consulta, edición y eliminación de usuarios.
- `Operador`: acceso al panel, clientes, proyectos, cálculo de materiales, inventario, materiales y reportes. No puede acceder ni operar el módulo de usuarios.

La API valida el rol en cada solicitud al módulo de usuarios y responde `403` cuando un operador intenta acceder directamente.

## Rutas principales

### Autenticación
- `GET /api/health`
- `POST /api/auth/login`
- `GET /api/auth/session`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `POST /api/auth/usuarios`

### Usuarios
- `GET /api/usuarios`
- `GET /api/usuarios/:id`
- `POST /api/usuarios`
- `PUT /api/usuarios/:id`
- `DELETE /api/usuarios/:id`

### Clientes
- `GET /api/clientes`
- `GET /api/clientes/:id`
- `POST /api/clientes`
- `PUT /api/clientes/:id`
- `DELETE /api/clientes/:id`

### Materiales
- `GET /api/materiales`
- `GET /api/materiales/:id`
- `POST /api/materiales`
- `PUT /api/materiales/:id`
- `DELETE /api/materiales/:id`
- `GET /api/materiales/categorias`
- `POST /api/materiales/categorias`
- `PUT /api/materiales/categorias/:id`
- `DELETE /api/materiales/categorias/:id`

### Proyectos
- `GET /api/proyectos`
- `GET /api/proyectos/:id`
- `POST /api/proyectos`
- `PUT /api/proyectos/:id`
- `DELETE /api/proyectos/:id`

> La API incluye una validación de compatibilidad del esquema para agregar la columna `id_usuario` en `proyectos` cuando la instalación existente la carece.

### Inventario
- `GET /api/inventario`
- `GET /api/inventario/movimientos`
- `POST /api/inventario/movimientos`
- `PUT /api/inventario/movimientos/:id`
- `DELETE /api/inventario/movimientos/:id`

### Reportes
- `GET /api/reportes?tipo=Clientes%20registrados`
- Tipos: `Clientes registrados`, `Proyectos por estado`, `Inventario actual`, `Movimientos de inventario` y `Consumo de materiales`.
- Filtros opcionales: `desde`, `hasta` y `estado` (este último aplica a proyectos).

## Usuario predeterminado

- Usuario: `admin@recubrimientos.com`
- Contraseña: `admin123`

## Notas

- La API usa cookies de sesión para autenticación.
- El backend exige sesión válida para acceder a rutas protegidas dentro de `/api`.
- El frontend se conecta automáticamente a `http://localhost:3000/api` desde la UI web.