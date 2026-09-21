# API Proyecto G2

Backend REST para la gestión de recubrimientos arquitectónicos, desarrollado con Node.js y MySQL.

## Descripción

Esta API expone servicios para:

- autenticación y gestión de usuarios
- administración de clientes
- catálogo de materiales con categorías, imagen y estado
- control de inventario con movimientos y lotes
- cálculo de materiales por proyecto
- gestión de proyectos y costos asociados
- reportes básicos del sistema

## Stack

- Node.js 18+
- Express 5
- MySQL 8+
- mysql2
- bcryptjs
- cors
- dotenv

## Estructura del proyecto

```text
API-ProyectoG2/
├── database/
│   └── schema.sql
├── src/
│   └── server.js
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
├── README.md
└── image/
```

## Requisitos previos

- Node.js 18 o superior
- MySQL 8 o superior
- Base de datos llamada `recubrimientos`

## Instalación

1. Clona o abre la carpeta del proyecto.
2. Instala dependencias:

```powershell
npm install
```

3. Crea el archivo `.env` a partir del ejemplo:

```powershell
Copy-Item .env.example .env
```

4. Configura las variables de conexión:

```env
PORT=3000
DB_HOST=localhost
DB_PORT=3306
DB_NAME=recubrimientos
DB_USER=root
DB_PASSWORD=root
```

Opcionalmente para entorno de producción:

```env
NODE_ENV=production
FRONTEND_URL=http://localhost:5500
SESSION_SECRET=una-clave-larga-y-aleatoria
COOKIE_SAMESITE=lax
COOKIE_SECURE=false
SESSION_COOKIE_NAME=recubrimientos_session
```

> `FRONTEND_URL` puede recibir varios orígenes separados por comas.

## Base de datos

Importa el esquema SQL si aún no existe:

```powershell
mysql -u root -p < database\schema.sql
```

También puedes ejecutarlo desde MySQL Workbench o desde una herramienta de administración.

## Ejecutar la API

Modo desarrollo:

```powershell
npm run dev
```

Modo producción:

```powershell
npm start
```

La API queda disponible en:

- http://localhost:3000
- http://localhost:3000/api/health

## Autenticación

La API usa cookies de sesión para autenticar solicitudes protegidas. Todas las rutas bajo `/api` requieren una sesión válida, excepto el login y el health check.

### Login

```http
POST /api/auth/login
Content-Type: application/json

{
  "usuario": "admin@recubrimientos.com",
  "contrasena": "admin123",
  "recordar": true
}
```

### Sesión

- `GET /api/auth/session`
- `GET /api/auth/me`
- `POST /api/auth/logout`

## Usuarios por defecto

El sistema crea automáticamente un usuario administrador si no existe:

- Email: `admin@recubrimientos.com`
- Contraseña: `admin123`

## Roles y permisos

- `Administrador`: acceso completo al módulo de usuarios y administración general.
- `Operador`: acceso a clientes, materiales, inventario, proyectos, reportes y panel; no puede administrar usuarios.

## Endpoints principales

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
- `PATCH /api/clientes/:id/archivar`
- `PATCH /api/clientes/:id/desarchivar`

### Materiales

- `GET /api/materiales`
- `GET /api/materiales/categorias`
- `POST /api/materiales/categorias`
- `PUT /api/materiales/categorias/:id`
- `DELETE /api/materiales/categorias/:id`

### Inventario

- `GET /api/inventario`
- `GET /api/inventario/movimientos`
- `POST /api/inventario/movimientos`
- `PUT /api/inventario/movimientos/:id`
- `DELETE /api/inventario/movimientos/:id`

### Proyectos

- `GET /api/proyectos`
- `GET /api/proyectos/:id`
- `POST /api/proyectos`
- `PUT /api/proyectos/:id`
- `DELETE /api/proyectos/:id`

## Funcionalidades relevantes

- catálogo de materiales con código, categoría, imagen y estado activo/archivado
- inventario con control de stock y lotes por PEPS
- cálculo de costo por salida con base en lotes más antiguos
- proyectos con materiales asignados, costos y detalle PEPS
- compatibilidad automática de esquema para cubrir columnas y tablas nuevas
- validación de permisos por rol

## Notas importantes

- El backend exige sesión válida para acceder a rutas protegidas dentro de `/api`.
- El archivo `database/schema.sql` crea la base de datos, tablas, vistas y datos iniciales básicos.
- La API realiza migraciones leves al arrancar para agregar columnas o tablas faltantes cuando la base ya existe.
- En desarrollo, por defecto se aceptan orígenes locales como `http://localhost:5500` y `http://127.0.0.1:5500`.

## Comandos útiles

```powershell
npm install
npm run dev
npm start
```

## Troubleshooting

Si la API no puede conectarse a MySQL, verifica:

- que MySQL esté corriendo
- que la base `recubrimientos` exista
- que `.env` tenga los valores correctos
- que el usuario de MySQL tenga permisos para crear y modificar tablas

