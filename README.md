# API-Proyecto

Backend REST del sistema de recubrimientos arquitectónicos.

## Requisitos

- Node.js 18 o superior
- MySQL 8 o superior

## Instalación

```powershell
cd API-Proyecto
npm install
Copy-Item .env.example .env
```

Edite `.env` con los datos de su servidor MySQL y ejecute `database/schema.sql` desde MySQL Workbench o la consola de MySQL.

Para iniciar:

```powershell
npm run dev
```

La API quedará disponible en `http://localhost:3000`.

## Rutas

- `GET /api/health`
- `POST /api/auth/login`
- `POST /api/auth/usuarios`
- `GET|POST /api/clientes`
- `GET|POST /api/materiales`
- `GET|POST /api/proyectos`
- `GET|POST /api/inventario/movimientos`

Las contraseñas deben enviarse en texto plano únicamente por HTTPS en producción; la API las almacena cifradas con bcrypt.
